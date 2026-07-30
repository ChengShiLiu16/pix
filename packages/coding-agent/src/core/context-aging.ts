/**
 * Context-window optimization: progressively age tool results to save tokens.
 *
 * As context usage grows, older tool results are gradually reduced in detail.
 * This is less destructive than compaction (which replaces entire conversations
 * with summaries) and more aggressive than stale pruning (which only removes
 * results superseded by mutations or duplicates).
 *
 * Aging is applied in `transformContext` before stale pruning, and only when
 * context usage exceeds a configurable threshold. It never mutates persisted
 * session entries — the original messages are preserved in the session file.
 *
 * Aging levels by context ratio (used / window):
 *   < AGING_START_RATIO: no aging
 *   AGING_START_RATIO-AGING_MEDIUM_RATIO: light aging — results older than 10 user turns
 *   AGING_MEDIUM_RATIO-effective heavy threshold: medium aging — results older than 5 user turns
 *   >= effective heavy threshold: heavy aging — results older than 3 user turns
 *
 * Error results and mutation results (edit/write) are never aged.
 */

import type { AgentMessage } from "@chengshiliu16/pix-agent-core";
import type { AssistantMessage, TextContent, ToolResultMessage } from "@chengshiliu16/pix-ai";
import type { ReachabilityLevel } from "./context-reachability.ts";
import {
	AGING_HEAVY_RATIO,
	AGING_MEDIUM_RATIO,
	AGING_START_RATIO,
	EDIT_ARGS_COMPACT_RATIO,
	MIN_AGING_CHARS,
} from "./context-thresholds.ts";
import { BASH_READ_COMMAND_RE, MUTATION_TOOLS } from "./context-tool-scope.ts";

/** Tools whose results contain file content and can be aged. */
const AGABLE_TOOLS = new Set([
	"read",
	"read_many",
	"grep",
	"grep_many",
	"ffgrep",
	"fff-multi-grep",
	"multi_grep",
	"find",
	"ffind",
	"fffind",
	"ls",
	"ls_many",
	"bash",
]);

interface AgingLevel {
	/** Minimum user-turn age to apply aging. */
	minAge: number;
	/** Maximum head lines to keep for read results. */
	readHeadLines: number;
	/** Maximum tail lines to keep for read results. */
	readTailLines: number;
	/** Maximum lines to keep for bash results. */
	bashTailLines: number;
	/** Maximum matches to keep for grep results. */
	grepMaxMatches: number;
	/** Maximum entries to keep for ls/find results. */
	listMaxEntries: number;
	/** Whether to use heavy (single-line) placeholders. */
	heavy: boolean;
}

const AGING_LEVELS: Record<string, AgingLevel> = {
	light: {
		minAge: 10,
		readHeadLines: 20,
		readTailLines: 5,
		bashTailLines: 6,
		grepMaxMatches: 20,
		listMaxEntries: 30,
		heavy: false,
	},
	medium: {
		minAge: 5,
		readHeadLines: 5,
		readTailLines: 0,
		bashTailLines: 2,
		grepMaxMatches: 5,
		listMaxEntries: 10,
		heavy: false,
	},
	heavy: {
		minAge: 3,
		readHeadLines: 0,
		readTailLines: 0,
		bashTailLines: 0,
		grepMaxMatches: 0,
		listMaxEntries: 0,
		heavy: true,
	},
};

function textLength(content: ToolResultMessage["content"]): number {
	let chars = 0;
	for (const block of content) {
		if (block.type === "text") chars += block.text.length;
		else if (block.type === "image") chars += 4800;
	}
	return chars;
}

function extractText(content: ToolResultMessage["content"]): string {
	return content
		.filter((b): b is { type: "text"; text: string } => b.type === "text")
		.map((b) => b.text)
		.join("\n");
}

/**
 * Compute the "age" of each tool result message, measured as the number of
 * user-role messages that appear after it in the conversation.
 */
function computeAges(messages: AgentMessage[]): Map<number, number> {
	const ages = new Map<number, number>();
	let userCount = 0;
	// Walk backwards: each user message increments the counter.
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "user" || msg.role === "bashExecution" || msg.role === "custom") {
			userCount++;
		}
		if (msg.role === "toolResult") {
			ages.set(i, userCount);
		}
	}
	return ages;
}

/**
 * Determine the aging level based on context ratio.
 *
 * @param contextRatio - Current context usage ratio (used / window)
 * @param effectiveHeavyThreshold - Optional dynamic heavy aging threshold
 *   (computed from compaction threshold minus hysteresis gap). If not provided,
 *   falls back to static AGING_HEAVY_RATIO.
 */
function getAgingLevel(contextRatio: number, effectiveHeavyThreshold?: number): AgingLevel | undefined {
	const heavyThreshold = effectiveHeavyThreshold ?? AGING_HEAVY_RATIO;
	if (contextRatio < AGING_START_RATIO) return undefined;
	if (contextRatio < AGING_MEDIUM_RATIO) return AGING_LEVELS.light;
	if (contextRatio < heavyThreshold) return AGING_LEVELS.medium;
	return AGING_LEVELS.heavy;
}

/**
 * Lines worth keeping when a source file is reduced to an outline: top-level
 * declarations across the languages the read tool sees most. Deliberately
 * anchored at the start of the line (allowing indentation) so that call sites
 * and string literals containing these words do not match.
 */
const DECLARATION_RE =
	/^\s*(?:export\s+)?(?:default\s+)?(?:public\s+|private\s+|protected\s+|static\s+|abstract\s+|declare\s+)*(?:async\s+)?(?:function\*?|class|interface|type|enum|const\s+enum|struct|impl|trait|def|fn|func|module|namespace)\s+[A-Za-z_$][\w$]*/u;

/** Exported bindings that hold a function/component, e.g. `export const f = (` */
const EXPORTED_BINDING_RE = /^\s*export\s+(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*[:=]/u;

/** Method signatures inside a class/interface body, e.g. `  doThing(a: X): Y {` */
const METHOD_RE = /^\s{1,8}(?:public\s+|private\s+|protected\s+|static\s+|readonly\s+|async\s+)*[A-Za-z_$][\w$]*\s*\(/u;

/**
 * Reduce file content to an outline of its declarations, each tagged with its
 * line number.
 *
 * This is strictly more useful to the model than the equivalent number of head
 * lines: the head of a source file is imports, whereas the outline tells the
 * model what the file actually contains and — via the line numbers, which the
 * raw read result does not even carry — exactly where to `read` next to get it
 * back. Same token budget, far higher information density, and recovery from an
 * aged result becomes one targeted read instead of a full re-read.
 *
 * Returns undefined when the content does not look like structured source, so
 * the caller can fall back to head/tail truncation.
 */
function extractOutline(lines: string[], maxEntries: number): string[] | undefined {
	if (maxEntries <= 0) return undefined;
	const outline: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line.length > 400) continue;
		if (!DECLARATION_RE.test(line) && !EXPORTED_BINDING_RE.test(line) && !METHOD_RE.test(line)) continue;
		outline.push(`L${i + 1}: ${line.trim().slice(0, 160)}`);
		if (outline.length >= maxEntries) break;
	}
	// Two declarations is not an outline, it is noise; fall back to head/tail.
	return outline.length >= 3 ? outline : undefined;
}

/**
 * Age a read result: prefer a declaration outline, fall back to head + tail
 * lines, with a truncation notice. For single-line or few-line results, use
 * character-based truncation.
 */
function ageReadResult(text: string, level: AgingLevel, anchor?: string): string {
	const lines = text.split("\n");
	const totalLines = lines.length;

	if (level.heavy) {
		const target = anchor ? ` Target: ${anchor}.` : "";
		return `Read result omitted to save context.${target} ${totalLines} lines total. Re-read the file if needed.`;
	}

	const keptLines = level.readHeadLines + level.readTailLines;
	if (totalLines <= keptLines) {
		// Result fits within budget — try character-based truncation for long lines
		if (text.length <= 2000) return text;
		// Single/few long lines: keep first 1500 chars
		return `${text.slice(0, 1500)}\n... ${text.length - 1500} more characters not shown.`;
	}

	const outline = extractOutline(lines, keptLines);
	if (outline) {
		const target = anchor ? ` of ${anchor}` : "";
		return `[Outline${target} — ${totalLines} lines total. Full body dropped to save context; re-read with offset/limit at the line numbers below.]\n${outline.join(
			"\n",
		)}`;
	}

	const head = lines.slice(0, level.readHeadLines);
	const tail = level.readTailLines > 0 ? lines.slice(-level.readTailLines) : [];
	const omitted = totalLines - keptLines;
	let result = head.join("\n");
	if (tail.length > 0) {
		result += `\n... ${omitted} lines not shown ...\n${tail.join("\n")}`;
	} else {
		result += `\n... ${omitted} lines not shown.`;
	}
	return result;
}

/**
 * Age a bash result: keep tail lines with truncation notice.
 * For single-line or few-line results, use character-based truncation.
 */
function ageBashResult(text: string, level: AgingLevel, anchor?: string): string {
	const lines = text.split("\n");
	const totalLines = lines.length;

	if (level.heavy) {
		const target = anchor ? ` Target: ${anchor}.` : "";
		return `Bash output omitted to save context.${target} ${totalLines} lines total. Re-run the command if needed.`;
	}

	if (totalLines <= level.bashTailLines) {
		if (text.length <= 2000) return text;
		// Few long lines: keep last 1500 chars
		return `... earlier content not shown ...\n${text.slice(-1500)}`;
	}

	const tail = lines.slice(-level.bashTailLines);
	return `... ${totalLines - level.bashTailLines} earlier lines not shown ...\n${tail.join("\n")}`;
}

/** How many distinct locations to name when summarizing dropped lines. */
const DROPPED_SUMMARY_MAX_GROUPS = 6;

/**
 * Summarize dropped lines as a location index instead of a bare count.
 *
 * "... 42 more matches not shown" tells the model nothing it can act on, so the
 * only way to recover is to re-run the search and pay for the entire result
 * again. Naming where the dropped hits live costs a handful of tokens and turns
 * recovery into one targeted grep/read. `groupOf` maps a line to the bucket it
 * should be counted under; lines it rejects are counted but not named.
 */
function summarizeDropped(dropped: string[], noun: string, groupOf: (line: string) => string | undefined): string {
	const counts = new Map<string, number>();
	for (const line of dropped) {
		const group = groupOf(line);
		if (group === undefined || group.length === 0) continue;
		counts.set(group, (counts.get(group) ?? 0) + 1);
	}
	if (counts.size === 0) return `... ${dropped.length} more ${noun} not shown.`;

	const ranked = [...counts].sort((a, b) => b[1] - a[1]);
	const named = ranked.slice(0, DROPPED_SUMMARY_MAX_GROUPS);
	const rest = ranked.length - named.length;
	const list = named.map(([group, count]) => `${group} (${count})`).join(", ");
	const tail = rest > 0 ? `, and ${rest} more` : "";
	return `... ${dropped.length} more ${noun} not shown, in: ${list}${tail}.`;
}

/** ripgrep emits `path:line:content`; take the path. */
function grepMatchFile(line: string): string | undefined {
	if (line.length === 0 || line.startsWith("--")) return undefined;
	const match = /^([^\s:][^:]*):\d+:/u.exec(line);
	return match?.[1];
}

/** Bucket a path entry by its parent directory. */
function entryDirectory(line: string): string | undefined {
	const trimmed = line.trim();
	if (trimmed.length === 0) return undefined;
	const slash = trimmed.lastIndexOf("/");
	return slash > 0 ? `${trimmed.slice(0, slash)}/` : "./";
}

/**
 * Age a grep result: keep first N matches, and index the rest by file.
 */
function ageGrepResult(text: string, level: AgingLevel, anchor?: string): string {
	if (level.heavy) {
		// Count matches using ripgrep output format (file:line:content).
		// Skip empty lines and "--" separators between files.
		const matchCount = text.split("\n").filter((l) => l.length > 0 && !l.startsWith("--") && /:\d+:/.test(l)).length;
		const target = anchor ? ` Target: ${anchor}.` : "";
		return `Grep result omitted to save context.${target} ${matchCount} matches total. Re-run grep if needed.`;
	}
	const lines = text.split("\n");
	if (lines.length <= level.grepMaxMatches) return text;
	const kept = lines.slice(0, level.grepMaxMatches);
	const dropped = lines.slice(level.grepMaxMatches);
	return `${kept.join("\n")}\n${summarizeDropped(dropped, "matches", grepMatchFile)}`;
}

/**
 * Age an ls/find result: keep first N entries, and index the rest by directory.
 */
function ageListResult(text: string, level: AgingLevel, toolName: string, anchor?: string): string {
	if (level.heavy) {
		const entryCount = text.split("\n").length;
		const label = toolName === "find" || toolName === "ffind" || toolName === "fffind" ? "Find" : "Ls";
		const target = anchor ? ` Target: ${anchor}.` : "";
		return `${label} result omitted to save context.${target} ${entryCount} entries total. Re-run if needed.`;
	}
	const lines = text.split("\n");
	if (lines.length <= level.listMaxEntries) return text;
	const kept = lines.slice(0, level.listMaxEntries);
	const dropped = lines.slice(level.listMaxEntries);
	return `${kept.join("\n")}\n${summarizeDropped(dropped, "entries", entryDirectory)}`;
}

/**
 * Progressively age tool results to reduce context size.
 * Returns the original array when nothing is aged.
 *
 * @param messages - The conversation messages to process
 * @param contextRatio - Current context usage ratio (used / window), 0-1+
 */
/**
 * Generate a concise natural-language placeholder for an unrelated tool result.
 * The text is plain prose with no machine markers so the model never mimics it.
 */
function naturalLanguagePlaceholder(toolName: string, anchor?: string, lineCount?: number): string {
	const p = anchor ?? "this file";
	const n = lineCount !== undefined ? `${lineCount}` : "many";
	const restore = restoreAgedHint(toolName, anchor);
	switch (toolName) {
		case "read":
		case "read_many":
			return `Earlier read of ${p} (${n} lines) omitted to save context. ${restore}`;
		case "grep":
		case "grep_many":
		case "ffgrep":
		case "fff-multi-grep":
		case "multi_grep":
			return `Earlier grep results omitted to save context. ${restore}`;
		case "ls":
		case "ls_many":
			return `Earlier directory listing (${n} entries) omitted to save context. ${restore}`;
		case "find":
		case "ffind":
		case "fffind":
			return `Earlier find results (${n} entries) omitted to save context. ${restore}`;
		case "bash":
			return `Earlier command output omitted to save context. ${restore}`;
		default:
			return `Earlier tool result omitted to save context. ${restore}`;
	}
}

function restoreAgedHint(toolName: string, anchor?: string): string {
	const target = anchor ? ` for ${anchor}` : "";
	switch (toolName) {
		case "read":
		case "read_many":
			return `Restore by re-reading${target}.`;
		case "grep":
		case "grep_many":
		case "ffgrep":
		case "fff-multi-grep":
		case "multi_grep":
			return `Restore by re-running grep${target}.`;
		case "ls":
		case "ls_many":
			return `Restore by re-running ${toolName}${target}.`;
		case "find":
		case "ffind":
		case "fffind":
			return `Restore by re-running find${target}.`;
		case "bash":
			return anchor
				? `Restore by re-running the command or reading ${anchor}.`
				: "Restore by re-running the command.";
		default:
			return "Restore by re-running the original tool call.";
	}
}

interface AgedToolResultDetails {
	reason: "aged";
	toolName: string;
	anchor?: string;
	reachability?: ReachabilityLevel;
	restoreHint: string;
}

function withAgedDetails(
	existing: unknown,
	toolName: string,
	anchor: string | undefined,
	reachability: ReachabilityLevel | undefined,
): Record<string, unknown> {
	const contextOmitted: AgedToolResultDetails = {
		reason: "aged",
		toolName,
		restoreHint: restoreAgedHint(toolName, anchor),
	};
	if (anchor !== undefined) contextOmitted.anchor = anchor;
	if (reachability !== undefined) contextOmitted.reachability = reachability;
	if (typeof existing === "object" && existing !== null && !Array.isArray(existing)) {
		return { ...(existing as Record<string, unknown>), contextOmitted };
	}
	return { contextOmitted };
}

/**
 * Count lines in a tool result's text content.
 */
function countLines(content: ToolResultMessage["content"]): number {
	let total = 0;
	for (const block of content) {
		if (block.type === "text") {
			total += block.text.split("\n").length;
		}
	}
	return total;
}

function compactList(values: string[], maxItems = 3): string | undefined {
	const clean = values.filter((value) => value.length > 0);
	if (clean.length === 0) return undefined;
	const head = clean.slice(0, maxItems).join(", ");
	const remaining = clean.length - maxItems;
	return remaining > 0 ? `${head}, +${remaining} more` : head;
}

function getStringArg(args: Record<string, unknown> | undefined, keys: string[]): string | undefined {
	if (!args) return undefined;
	for (const key of keys) {
		const value = args[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

function getReadManyAnchor(args: Record<string, unknown> | undefined): string | undefined {
	if (!args) return undefined;
	const files = args.files;
	if (Array.isArray(files)) {
		const paths = files
			.map((file) =>
				typeof file === "object" && file !== null && typeof file.path === "string" ? file.path : undefined,
			)
			.filter((path): path is string => path !== undefined);
		const list = compactList(paths);
		if (list) return list;
	}
	const paths = args.paths;
	if (Array.isArray(paths)) {
		return compactList(paths.filter((path): path is string => typeof path === "string"));
	}
	return getStringArg(args, ["path"]);
}

function getGrepManyAnchor(args: Record<string, unknown> | undefined): string | undefined {
	if (!args) return undefined;
	const searches = args.searches;
	if (Array.isArray(searches)) {
		const paths = searches
			.map((search) =>
				typeof search === "object" && search !== null && typeof search.path === "string" ? search.path : undefined,
			)
			.filter((path): path is string => path !== undefined);
		const list = compactList(paths);
		if (list) return list;
	}
	return getStringArg(args, ["path", "constraints"]);
}

function getLsManyAnchor(args: Record<string, unknown> | undefined): string | undefined {
	if (!args) return undefined;
	const paths = args.paths;
	if (!Array.isArray(paths)) return undefined;
	return compactList(paths.filter((path): path is string => typeof path === "string"));
}

function getBashAnchor(args: Record<string, unknown> | undefined): string | undefined {
	const command = getStringArg(args, ["command"]);
	if (!command) return undefined;
	const match = BASH_READ_COMMAND_RE.exec(command);
	if (match?.[1]) return match[1];
	return command.length > 80 ? `${command.slice(0, 77)}...` : command;
}

function getToolAnchor(toolName: string, args: Record<string, unknown> | undefined): string | undefined {
	switch (toolName) {
		case "read":
			return getStringArg(args, ["path", "file_path", "filePath"]);
		case "read_many":
			return getReadManyAnchor(args);
		case "grep":
		case "ffgrep":
		case "find":
		case "ffind":
		case "fffind":
		case "ls":
			return getStringArg(args, ["path"]);
		case "grep_many":
			return getGrepManyAnchor(args);
		case "fff-multi-grep":
		case "multi_grep":
			return getStringArg(args, ["constraints"]);
		case "ls_many":
			return getLsManyAnchor(args);
		case "bash":
			return getBashAnchor(args);
		default:
			return undefined;
	}
}

function collectToolAnchors(messages: AgentMessage[]): Map<string, string> {
	const anchors = new Map<string, string>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		const assistant = message as AssistantMessage;
		if (!("content" in assistant) || !Array.isArray(assistant.content)) continue;
		for (const block of assistant.content) {
			if (block.type !== "toolCall") continue;
			const anchor = getToolAnchor(block.name, block.arguments as Record<string, unknown> | undefined);
			if (anchor) anchors.set(block.id, anchor);
		}
	}
	return anchors;
}

export function ageToolResults(
	messages: AgentMessage[],
	contextRatio: number,
	reachability?: Map<number, ReachabilityLevel>,
	effectiveHeavyThreshold?: number,
): AgentMessage[] {
	const level = getAgingLevel(contextRatio, effectiveHeavyThreshold);
	if (!level) return messages;

	const ages = computeAges(messages);
	const anchors = collectToolAnchors(messages);
	let changed = false;

	const result = messages.map((message, index) => {
		if (message.role !== "toolResult") return message;
		const toolResult = message as ToolResultMessage;

		// Never age error results or mutation results.
		if (toolResult.isError) return message;
		if (MUTATION_TOOLS.has(toolResult.toolName)) return message;
		if (!AGABLE_TOOLS.has(toolResult.toolName)) return message;

		// Focus-context reachability decides how hard to age each result:
		//   active   — issued in the current focus window; keep full evidence.
		//   adjacent — touches a file/scope the current work is about; keep
		//              full unless we are under heavy pressure and need space.
		//   unrelated — not on the demand chain; age normally (heavy → stub).
		// Only "unrelated" results are eligible for aggressive trimming, so the
		// bulk of the savings come from history the model is no longer using
		// while what it is actively working on stays intact.
		const r = reachability?.get(index);
		if (r === "active") return message;
		if (r === "adjacent" && !level.heavy) return message;

		// Check age threshold.
		const age = ages.get(index) ?? 0;
		if (age < level.minAge) return message;

		// Check size threshold.
		if (textLength(toolResult.content) < MIN_AGING_CHARS) return message;

		// Unrelated results under heavy aging are replaced with a minimal
		// natural-language placeholder instead of truncated content.
		if (r === "unrelated" && level.heavy) {
			changed = true;
			const lines = countLines(toolResult.content);
			const anchor = anchors.get(toolResult.toolCallId);
			const stub: TextContent = {
				type: "text",
				text: naturalLanguagePlaceholder(toolResult.toolName, anchor, lines),
			};
			return {
				...toolResult,
				content: [stub],
				details: withAgedDetails(toolResult.details, toolResult.toolName, anchor, r),
			} satisfies ToolResultMessage;
		}

		const text = extractText(toolResult.content);
		const anchor = anchors.get(toolResult.toolCallId);
		let agedText: string;

		switch (toolResult.toolName) {
			case "read":
			case "read_many":
				agedText = ageReadResult(text, level, anchor);
				break;
			case "bash":
				agedText = ageBashResult(text, level, anchor);
				break;
			case "grep":
			case "grep_many":
			case "ffgrep":
			case "fff-multi-grep":
			case "multi_grep":
				agedText = ageGrepResult(text, level, anchor);
				break;
			case "ls":
			case "ls_many":
			case "find":
			case "ffind":
			case "fffind":
				agedText = ageListResult(text, level, toolResult.toolName, anchor);
				break;
			default:
				return message;
		}

		// If aging didn't actually change anything, skip.
		if (agedText === text) return message;

		changed = true;
		const stub: TextContent = { type: "text", text: agedText };
		return {
			...toolResult,
			content: [stub],
			details: withAgedDetails(toolResult.details, toolResult.toolName, anchor, r),
		} satisfies ToolResultMessage;
	});

	return changed ? result : messages;
}

/**
 * Compact edit tool-call arguments to reduce context size.
 *
 * Edit tool calls contain `old_string` which can be very long and is partially
 * redundant with the tool result (which shows the diff). When context is high,
 * we truncate `old_string` to a summary, keeping `new_string` intact so the
 * model still knows what was written.
 *
 * Only applies when context ratio >= 0.7 (same threshold as stale-read pruning).
 * Returns the original array when nothing is changed.
 */
export function compactEditArguments(messages: AgentMessage[], contextRatio: number): AgentMessage[] {
	if (contextRatio < EDIT_ARGS_COMPACT_RATIO) return messages;

	let changed = false;
	const result = messages.map((message) => {
		if (message.role !== "assistant") return message;
		const assistant = message as AssistantMessage;
		if (!("content" in assistant) || !Array.isArray(assistant.content)) return message;

		let msgChanged = false;
		const newContent = assistant.content.map((block) => {
			if (block.type !== "toolCall" || block.name !== "edit") return block;
			const args = block.arguments as Record<string, unknown>;
			const oldString = args.old_string;
			if (typeof oldString !== "string" || oldString.length < 200) return block;

			msgChanged = true;
			// Keep head + tail of old_string so the model can see the edit
			// boundaries. Middle is omitted to save tokens.
			const head = oldString.slice(0, 50);
			const tail = oldString.slice(-50);
			const middle = oldString.length - 100;
			const summary =
				middle > 0
					? `${head}... ${middle} chars not shown (${oldString.length} total) ...${tail}`
					: `${head}... ${oldString.length} chars total.`;
			return {
				...block,
				arguments: {
					...args,
					old_string: summary,
				},
			};
		});

		if (!msgChanged) return message;
		changed = true;
		return { ...assistant, content: newContent } satisfies AssistantMessage;
	});

	return changed ? result : messages;
}
