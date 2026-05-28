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
 *   < 50% : no aging
 *   50-70%: light aging — results older than 10 user turns
 *   70-85%: medium aging — results older than 5 user turns
 *   > 85% : heavy aging — results older than 3 user turns
 *
 * Error results and mutation results (edit/write) are never aged.
 */

import type { AgentMessage } from "@earendil-works/pix-agent-core";
import type { AssistantMessage, TextContent, ToolResultMessage } from "@earendil-works/pix-ai";

/** Minimum text length (chars) of a result before aging is worth it. */
const MIN_AGING_CHARS = 800;

/** Tools whose results contain file content and can be aged. */
const AGABLE_TOOLS = new Set(["read", "read_many", "grep", "grep_many", "find", "ls", "ls_many", "bash"]);

/** Mutation tools whose results should never be aged. */
const MUTATION_TOOLS = new Set(["edit", "write"]);

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
		bashTailLines: 10,
		grepMaxMatches: 20,
		listMaxEntries: 30,
		heavy: false,
	},
	medium: {
		minAge: 5,
		readHeadLines: 5,
		readTailLines: 0,
		bashTailLines: 3,
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
 */
function getAgingLevel(contextRatio: number): AgingLevel | undefined {
	if (contextRatio < 0.5) return undefined;
	if (contextRatio < 0.7) return AGING_LEVELS.light;
	if (contextRatio < 0.85) return AGING_LEVELS.medium;
	return AGING_LEVELS.heavy;
}

/**
 * Age a read result: keep head + tail lines, with a truncation notice.
 * For single-line or few-line results, use character-based truncation.
 */
function ageReadResult(text: string, level: AgingLevel): string {
	const lines = text.split("\n");
	const totalLines = lines.length;

	if (level.heavy) {
		return `[Read result aged: ${totalLines} lines total. Re-read the file if you need its contents.]`;
	}

	const keptLines = level.readHeadLines + level.readTailLines;
	if (totalLines <= keptLines) {
		// Result fits within budget — try character-based truncation for long lines
		if (text.length <= 2000) return text;
		// Single/few long lines: keep first 1500 chars
		return `${text.slice(0, 1500)}\n... [${text.length - 1500} more characters omitted]`;
	}

	const head = lines.slice(0, level.readHeadLines);
	const tail = level.readTailLines > 0 ? lines.slice(-level.readTailLines) : [];
	const omitted = totalLines - keptLines;
	let result = head.join("\n");
	if (tail.length > 0) {
		result += `\n... [${omitted} lines omitted] ...\n${tail.join("\n")}`;
	} else {
		result += `\n... [${omitted} lines omitted]`;
	}
	return result;
}

/**
 * Age a bash result: keep tail lines with truncation notice.
 * For single-line or few-line results, use character-based truncation.
 */
function ageBashResult(text: string, level: AgingLevel): string {
	const lines = text.split("\n");
	const totalLines = lines.length;

	if (level.heavy) {
		return `[Bash output aged: ${totalLines} lines total. Re-run the command if you need the output.]`;
	}

	if (totalLines <= level.bashTailLines) {
		if (text.length <= 2000) return text;
		// Few long lines: keep last 1500 chars
		return `... [earlier content omitted] ...\n${text.slice(-1500)}`;
	}

	const tail = lines.slice(-level.bashTailLines);
	return `... [${totalLines - level.bashTailLines} earlier lines omitted] ...\n${tail.join("\n")}`;
}

/**
 * Age a grep result: keep first N matches with truncation notice.
 */
function ageGrepResult(text: string, level: AgingLevel): string {
	if (level.heavy) {
		// Count matches using ripgrep output format (file:line:content).
		// Skip empty lines and "--" separators between files.
		const matchCount = text.split("\n").filter((l) => l.length > 0 && !l.startsWith("--") && /:\d+:/.test(l)).length;
		return `[Grep result aged: ${matchCount} matches total. Re-run grep if you need the matches.]`;
	}
	const lines = text.split("\n");
	if (lines.length <= level.grepMaxMatches) return text;
	const kept = lines.slice(0, level.grepMaxMatches);
	return `${kept.join("\n")}\n... [${lines.length - level.grepMaxMatches} more matches omitted]`;
}

/**
 * Age an ls/find result: keep first N entries with truncation notice.
 */
function ageListResult(text: string, level: AgingLevel, toolName: string): string {
	if (level.heavy) {
		const entryCount = text.split("\n").length;
		const label = toolName === "find" ? "Find" : "Ls";
		return `[${label} result aged: ${entryCount} entries total. Re-run if you need the full list.]`;
	}
	const lines = text.split("\n");
	if (lines.length <= level.listMaxEntries) return text;
	const kept = lines.slice(0, level.listMaxEntries);
	return `${kept.join("\n")}\n... [${lines.length - level.listMaxEntries} more entries omitted]`;
}

/**
 * Progressively age tool results to reduce context size.
 * Returns the original array when nothing is aged.
 *
 * @param messages - The conversation messages to process
 * @param contextRatio - Current context usage ratio (used / window), 0-1+
 */
export function ageToolResults(messages: AgentMessage[], contextRatio: number): AgentMessage[] {
	const level = getAgingLevel(contextRatio);
	if (!level) return messages;

	const ages = computeAges(messages);
	let changed = false;

	const result = messages.map((message, index) => {
		if (message.role !== "toolResult") return message;
		const toolResult = message as ToolResultMessage;

		// Never age error results or mutation results.
		if (toolResult.isError) return message;
		if (MUTATION_TOOLS.has(toolResult.toolName)) return message;
		if (!AGABLE_TOOLS.has(toolResult.toolName)) return message;

		// Check age threshold.
		const age = ages.get(index) ?? 0;
		if (age < level.minAge) return message;

		// Check size threshold.
		if (textLength(toolResult.content) < MIN_AGING_CHARS) return message;

		const text = extractText(toolResult.content);
		let agedText: string;

		switch (toolResult.toolName) {
			case "read":
			case "read_many":
				agedText = ageReadResult(text, level);
				break;
			case "bash":
				agedText = ageBashResult(text, level);
				break;
			case "grep":
			case "grep_many":
				agedText = ageGrepResult(text, level);
				break;
			case "ls":
			case "ls_many":
			case "find":
				agedText = ageListResult(text, level, toolResult.toolName);
				break;
			default:
				return message;
		}

		// If aging didn't actually change anything, skip.
		if (agedText === text) return message;

		changed = true;
		const stub: TextContent = { type: "text", text: agedText };
		return { ...toolResult, content: [stub] } satisfies ToolResultMessage;
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
	if (contextRatio < 0.7) return messages;

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
					? `${head}... [${middle} chars omitted, ${oldString.length} chars total] ...${tail}`
					: `${head}... [${oldString.length} chars total]`;
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
