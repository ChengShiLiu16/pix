import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pix-agent-core";
import type { AssistantMessage, TextContent, ToolResultMessage } from "@earendil-works/pix-ai";
import type { BashExecutionMessage } from "./messages.ts";

const GIT_EVIDENCE_PREFIX = "Git evidence captured:";
const MAX_RAW_BYTES = 20 * 1024 * 1024;
const MAX_SESSION_BYTES = 200 * 1024 * 1024;
const MAX_RECORDS = 200;
const MAX_LEDGER_CHARS = 12_000;
const COMPACT_LEDGER_CHARS = 1_200;
const MAX_FILES = 40;
const MAX_HUNKS_PER_FILE = 8;
const MAX_KEY_LINES = 4;
const MAX_LINE_CHARS = 180;

const READ_ONLY_GIT_KINDS = new Set(["log", "show", "diff", "diff-tree", "status", "blame"]);

export type GitInspectionKind = "log" | "show" | "diff" | "diff-tree" | "status" | "blame";

export interface GitInspectionInfo {
	kind: GitInspectionKind;
}

interface GitHunkDigest {
	header: string;
	rawStartLine: number;
	rawEndLine?: number;
	keyAddedLines: string[];
	keyRemovedLines: string[];
	omittedLineCount: number;
}

interface GitFileDigest {
	path: string;
	oldPath?: string;
	status?: string;
	additions: number;
	deletions: number;
	hunks: GitHunkDigest[];
}

interface GitCommitDigest {
	sha: string;
	subject?: string;
	author?: string;
	date?: string;
}

interface GitEvidenceDigest {
	kind: GitInspectionKind;
	command: string;
	commits: GitCommitDigest[];
	files: GitFileDigest[];
	rawLines: number;
	rawBytes: number;
	rawTruncated: boolean;
	parseIncomplete: boolean;
}

export interface GitEvidenceDetails {
	id: string;
	command: string;
	kind: GitInspectionKind;
	rawPath?: string;
	rawBytes: number;
	rawLines: number;
	outputHash: string;
	compactText: string;
	/** Full detailed digest (with key changed lines and guidance). */
	detailedText: string;
}

export interface GitEvidenceResult {
	text: string;
	details: GitEvidenceDetails;
}

type ToolResultWithDetails = ToolResultMessage & { details?: Record<string, unknown> };

function hashText(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf-8");
}

function shortenLine(line: string): string {
	const trimmed = line.trimEnd();
	return trimmed.length <= MAX_LINE_CHARS ? trimmed : `${trimmed.slice(0, MAX_LINE_CHARS)}...`;
}

function countLines(text: string): number {
	if (text.length === 0) return 0;
	const lines = text.split("\n");
	return text.endsWith("\n") ? lines.length - 1 : lines.length;
}

export function isGitEvidenceText(text: string): boolean {
	return text.startsWith(GIT_EVIDENCE_PREFIX);
}

export function detectGitInspection(command: string): GitInspectionInfo | undefined {
	const globalOption = String.raw`(?:-[^\s]+\s+|-C\s+\S+\s+|-c\s+\S+\s+|--git-dir(?:=\S+|\s+\S+)\s+|--work-tree(?:=\S+|\s+\S+)\s+)`;
	const re = new RegExp(String.raw`\bgit\s+(?:${globalOption})*(?<kind>[a-z][\w-]*)\b`, "gu");
	const matches = Array.from(command.matchAll(re));
	if (matches.length === 0) return undefined;

	let firstKind: GitInspectionKind | undefined;
	for (const match of matches) {
		const kind = match.groups?.kind;
		if (!kind || !READ_ONLY_GIT_KINDS.has(kind)) return undefined;
		firstKind ??= kind as GitInspectionKind;
	}
	return firstKind ? { kind: firstKind } : undefined;
}

function normalizeDiffPath(path: string): string {
	if (path === "/dev/null") return path;
	return path.replace(/^"|"$/gu, "").replace(/^[ab]\//u, "");
}

function currentHunk(file: GitFileDigest): GitHunkDigest | undefined {
	return file.hunks[file.hunks.length - 1];
}

function addKeyLine(lines: string[], line: string): boolean {
	if (lines.length >= MAX_KEY_LINES) return false;
	lines.push(shortenLine(line));
	return true;
}

function parseCustomLogCommits(lines: string[]): GitCommitDigest[] {
	const commits: GitCommitDigest[] = [];
	for (let i = 0; i + 3 < lines.length; i++) {
		const markerMatch = /^(?:---\s*COMMIT\s+|=+\s*COMMIT:?\s*)([0-9a-f]{7,40})\s*(?:---|=+)?$/u.exec(lines[i]);
		if (markerMatch) {
			const author = /^Author:\s*(.+)$/u.exec(lines[i + 1])?.[1]?.trim();
			const date = /^Date:\s*(.+)$/u.exec(lines[i + 2])?.[1]?.trim();
			const subject = /^Subject:\s*(.+)$/u.exec(lines[i + 3])?.[1]?.trim();
			if (author || date || subject) {
				commits.push({
					sha: markerMatch[1],
					author,
					date,
					subject: subject ? shortenLine(subject) : undefined,
				});
				i += 3;
				continue;
			}
		}
		if (!/^[0-9a-f]{40}$/u.test(lines[i])) continue;
		const author = lines[i + 1].trim();
		const date = lines[i + 2].trim();
		const subject = lines[i + 3].trim();
		if (!author || !subject || !/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/u.test(date)) continue;
		commits.push({ sha: lines[i], author, date, subject: shortenLine(subject) });
		i += 3;
	}
	return commits;
}

function closeCurrentHunk(file: GitFileDigest | undefined, rawEndLine: number): void {
	const hunk = file ? currentHunk(file) : undefined;
	if (hunk && hunk.rawEndLine === undefined) hunk.rawEndLine = rawEndLine;
}

function parseGitOutput(
	command: string,
	kind: GitInspectionKind,
	output: string,
	rawTruncated: boolean,
): GitEvidenceDigest {
	const files: GitFileDigest[] = [];
	const commits: GitCommitDigest[] = [];
	const rawLines = countLines(output);
	const rawBytes = byteLength(output);
	let currentFile: GitFileDigest | undefined;
	let currentCommit: GitCommitDigest | undefined;
	const lines = output.split("\n");

	commits.push(...parseCustomLogCommits(lines));

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		const rawLine = index + 1;
		const commitMatch = /^commit\s+([0-9a-f]{7,40})\b/u.exec(line);
		if (commitMatch) {
			closeCurrentHunk(currentFile, rawLine - 1);
			currentFile = undefined;
			currentCommit = { sha: commitMatch[1] };
			commits.push(currentCommit);
			continue;
		}

		const logMatch = /^([0-9a-f]{7,40})\s+(.+)$/u.exec(line);
		if (!currentFile && logMatch && kind === "log") {
			commits.push({ sha: logMatch[1], subject: shortenLine(logMatch[2]) });
			continue;
		}

		if (currentCommit) {
			const author = /^Author:\s*(.+)$/u.exec(line)?.[1]?.trim();
			if (author) {
				currentCommit.author ??= author;
				continue;
			}
			const date = /^Date:\s*(.+)$/u.exec(line)?.[1]?.trim();
			if (date) {
				currentCommit.date ??= date;
				continue;
			}
			const subject = /^Subject:\s*(.+)$/u.exec(line)?.[1]?.trim();
			if (subject) {
				currentCommit.subject ??= shortenLine(subject);
				continue;
			}
		}

		const diffMatch = /^diff --git\s+(.+?)\s+(.+)$/u.exec(line);
		if (diffMatch) {
			closeCurrentHunk(currentFile, rawLine - 1);
			currentFile = {
				oldPath: normalizeDiffPath(diffMatch[1]),
				path: normalizeDiffPath(diffMatch[2]),
				additions: 0,
				deletions: 0,
				hunks: [],
			};
			files.push(currentFile);
			continue;
		}

		if (!currentFile) {
			const statusMatch = /^\s*(?:modified:|new file:|deleted:|renamed:|\?\?|[MADRCU?!]{1,2})\s+(.+)$/u.exec(line);
			if (statusMatch && kind === "status") {
				files.push({ path: statusMatch[1].trim(), additions: 0, deletions: 0, hunks: [] });
				continue;
			}
			const statMatch = /^\s*(.+?)\s+\|\s+(?:(\d+)\s+([+-]+)|Bin\s+\d+\s+->\s+\d+\s+bytes)$/u.exec(line);
			if (statMatch) {
				const changes = statMatch[3] ?? "";
				files.push({
					path: statMatch[1].trim(),
					additions: changes.replace(/[^+]/gu, "").length,
					deletions: changes.replace(/[^-]/gu, "").length,
					hunks: [],
				});
				continue;
			}
			if (currentCommit && line.startsWith("    ") && line.trim()) {
				currentCommit.subject ??= shortenLine(line.trim());
			}
			continue;
		}

		if (line.startsWith("new file mode ")) currentFile.status = "added";
		else if (line.startsWith("deleted file mode ")) currentFile.status = "deleted";
		else if (line.startsWith("rename from ")) currentFile.oldPath = line.slice("rename from ".length).trim();
		else if (line.startsWith("rename to ")) {
			currentFile.path = line.slice("rename to ".length).trim();
			currentFile.status = "renamed";
		}

		if (line.startsWith("@@ ")) {
			closeCurrentHunk(currentFile, rawLine - 1);
			currentFile.hunks.push({
				header: shortenLine(line),
				rawStartLine: rawLine,
				keyAddedLines: [],
				keyRemovedLines: [],
				omittedLineCount: 0,
			});
			continue;
		}

		const hunk = currentHunk(currentFile);
		if (!hunk || line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+")) {
			currentFile.additions++;
			if (!addKeyLine(hunk.keyAddedLines, line)) hunk.omittedLineCount++;
		} else if (line.startsWith("-")) {
			currentFile.deletions++;
			if (!addKeyLine(hunk.keyRemovedLines, line)) hunk.omittedLineCount++;
		}
	}
	closeCurrentHunk(currentFile, lines.length);

	return {
		kind,
		command,
		commits,
		files,
		rawLines,
		rawBytes,
		rawTruncated,
		parseIncomplete: files.length === 0 && commits.length === 0 && output.trim().length > 0,
	};
}

function appendWithBudget(lines: string[], line: string, maxChars: number): boolean {
	const nextLength = lines.reduce((sum, item) => sum + item.length + 1, 0) + line.length + 1;
	if (nextLength > maxChars) return false;
	lines.push(line);
	return true;
}

function formatDigest(
	id: string,
	digest: GitEvidenceDigest,
	rawPath: string | undefined,
	options: { maxChars?: number; compact?: boolean } = {},
): string {
	const maxChars = options.maxChars ?? MAX_LEDGER_CHARS;
	const lines: string[] = [
		`${GIT_EVIDENCE_PREFIX} ${id}`,
		"",
		`Command: ${digest.command}`,
		`Kind: git ${digest.kind}`,
		`Raw: ${digest.rawLines} lines, ${digest.rawBytes} bytes${rawPath ? `, ${rawPath}` : ""}`,
		...(digest.rawTruncated
			? [
					"Raw note: source exceeded the evidence size cap; rerun a narrower git command if exact omitted output is needed.",
				]
			: []),
		"",
	];

	if (digest.commits.length > 0) {
		lines.push("Commits:");
		const maxCommits = options.compact ? 10 : 30;
		for (const commit of digest.commits.slice(0, maxCommits)) {
			const metadata = [commit.author, commit.date].filter((value) => value).join(", ");
			lines.push(`- ${commit.sha}${commit.subject ? ` ${commit.subject}` : ""}${metadata ? ` (${metadata})` : ""}`);
		}
		if (digest.commits.length > maxCommits)
			lines.push(`- ... ${digest.commits.length - maxCommits} more commits omitted`);
		lines.push("");
	}

	if (digest.files.length > 0) {
		lines.push("Files and hunks:");
		const maxFiles = options.compact ? 20 : MAX_FILES;
		const maxHunks = options.compact ? 2 : MAX_HUNKS_PER_FILE;
		for (const file of digest.files.slice(0, maxFiles)) {
			if (!appendWithBudget(lines, `- ${file.path} (+${file.additions}/-${file.deletions})`, maxChars)) break;
			for (const hunk of file.hunks.slice(0, maxHunks)) {
				const rawEnd = hunk.rawEndLine ?? hunk.rawStartLine;
				if (!appendWithBudget(lines, `  - ${hunk.header} [${id}:${hunk.rawStartLine}-${rawEnd}]`, maxChars)) break;
				const maxKeyLines = options.compact ? 1 : MAX_KEY_LINES;
				let omittedByCompact = 0;
				for (const removed of hunk.keyRemovedLines.slice(0, maxKeyLines)) {
					if (!appendWithBudget(lines, `    ${removed}`, maxChars)) break;
				}
				omittedByCompact += Math.max(0, hunk.keyRemovedLines.length - maxKeyLines);
				for (const added of hunk.keyAddedLines.slice(0, maxKeyLines)) {
					if (!appendWithBudget(lines, `    ${added}`, maxChars)) break;
				}
				omittedByCompact += Math.max(0, hunk.keyAddedLines.length - maxKeyLines);
				const omitted = hunk.omittedLineCount + omittedByCompact;
				if (omitted > 0) {
					appendWithBudget(lines, `    ... ${omitted} changed lines omitted in this hunk`, maxChars);
				}
			}
			if (file.hunks.length > maxHunks) {
				appendWithBudget(lines, `  - ... ${file.hunks.length - maxHunks} more hunks omitted`, maxChars);
			}
		}
		if (digest.files.length > maxFiles) lines.push(`- ... ${digest.files.length - maxFiles} more files omitted`);
		lines.push("");
	}

	if (digest.parseIncomplete) {
		lines.push("Parser note: structured diff metadata was not detected; inspect raw evidence for exact output.");
		if (digest.kind === "show") {
			lines.push(
				"Raw source snapshot captured; do not read the raw .pix/session-evidence/git file directly. Use git_evidence_read with this evidence id, offset, and limit.",
			);
		}
	}
	if (/\bgit\s+(?:-[^\s]+\s+|-C\s+\S+\s+|-c\s+\S+\s+)*show\b[\s\S]*\|\s*head\b/u.test(digest.command)) {
		lines.push(
			"Repeated `git show ... | head` pattern detected: stop scanning commits one-by-one; read specific hunk spans with git_evidence_read ranges or search the evidence store.",
		);
	}
	if (!options.compact) {
		lines.push(
			"Prefer git_evidence_read/search over repeating broad git log/show/diff commands for this captured output.",
		);
		lines.push(
			"Avoid invalid `git show --no-stat`; use `git log -1 --format=... <hash>` for metadata or `git show --stat <hash>` / `git diff-tree --stat --no-commit-id -r <hash>` for stats.",
		);
		lines.push("Use this digest for inventory and triage only; do not infer behavior from commit subjects or stats.");
		lines.push(
			"Use hunk spans such as `git-show-abcdef123456:120-180` with git_evidence_read instead of rerunning git show.",
		);
		lines.push(
			"Before final answers that include non-inventory git conclusions, record theme-level git_evidence_findings with confidence/limitations.",
		);
	}

	const text = lines.join("\n");
	return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n... git evidence ledger truncated.`;
}

// In-memory cache: maps normalized command string to evidence result.
// Prevents redundant git command execution when the model re-runs
// the same command (e.g., `git show abc123 -- | head -N` that was
// already captured and saved).
export const gitEvidenceCache = new Map<string, { text: string; details: GitEvidenceDetails }>();

function normalizeCachedCommand(command: string): string {
	// Normalize for cache lookup: collapse whitespace, strip shell redirects
	// that don't affect git output (e.g. 2>&1, | head -N).
	return command
		.replace(/\s+/g, " ")
		.replace(/\b2>&1\b/g, "")
		.trim();
}

export function clearGitEvidenceCache(): void {
	gitEvidenceCache.clear();
}

const EVIDENCE_PROTECT_WINDOW_MS = 24 * 60 * 60 * 1000;

async function pruneEvidenceStore(dir: string): Promise<void> {
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		const now = Date.now();
		const protectedFiles: Array<{ path: string; size: number; mtimeMs: number }> = [];
		const evictableFiles: Array<{ path: string; size: number; mtimeMs: number }> = [];

		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".txt")) continue;
			const path = join(dir, entry.name);
			const fileStat = await stat(path);
			const file = { path, size: fileStat.size, mtimeMs: fileStat.mtimeMs };

			// Files created in the last 24 hours are protected from pruning.
			// This ensures evidence referenced by active sessions isn't deleted
			// when new evidence files push the store past its limits.
			const age = now - fileStat.mtimeMs;
			if (age <= EVIDENCE_PROTECT_WINDOW_MS) {
				protectedFiles.push(file);
			} else {
				evictableFiles.push(file);
			}
		}

		// Only the evictable pool participates in record/byte limit checks.
		// Protected files stay regardless of limits and will age into the
		// evictable pool after the window expires.
		if (evictableFiles.length <= MAX_RECORDS) {
			const totalBytes = evictableFiles.reduce((sum, file) => sum + file.size, 0);
			if (totalBytes <= MAX_SESSION_BYTES) return;
		}

		// LRU prune within evictable pool: oldest first, keep most recent 80%.
		evictableFiles.sort((a, b) => a.mtimeMs - b.mtimeMs);
		const keepCount = Math.ceil(MAX_RECORDS * 0.8);
		const toRemove = evictableFiles.length - keepCount;
		for (let index = 0; index < toRemove; index++) {
			await rm(evictableFiles[index].path, { force: true });
		}

		// If still over byte limit, remove more from what remains (oldest first)
		if (toRemove > 0) {
			const remaining = evictableFiles.slice(toRemove);
			const remainingBytes = remaining.reduce((sum, file) => sum + file.size, 0);
			if (remainingBytes > MAX_SESSION_BYTES) {
				const overBytes = remainingBytes - MAX_SESSION_BYTES;
				let freedBytes = 0;
				for (const file of remaining) {
					if (freedBytes >= overBytes) break;
					await rm(file.path, { force: true });
					freedBytes += file.size;
				}
			}
		}
	} catch {
		// Evidence storage is best-effort; failing cleanup must not block bash.
	}
}

function truncateRawText(text: string): { text: string; rawTruncated: boolean } {
	if (byteLength(text) <= MAX_RAW_BYTES) return { text, rawTruncated: false };
	const buffer = Buffer.from(text, "utf-8");
	return {
		text: `${buffer.subarray(0, MAX_RAW_BYTES).toString("utf-8")}\n[Git evidence raw output truncated at ${MAX_RAW_BYTES} bytes.]`,
		rawTruncated: true,
	};
}

async function readRawText(
	output: string,
	fullOutputPath: string | undefined,
): Promise<{ text: string; rawTruncated: boolean }> {
	if (!fullOutputPath) return truncateRawText(output);
	try {
		const source = await stat(fullOutputPath);
		if (source.size > MAX_RAW_BYTES) {
			const visible = truncateRawText(output);
			return { text: visible.text, rawTruncated: true };
		}
		return truncateRawText(await readFile(fullOutputPath, "utf-8"));
	} catch {
		return truncateRawText(output);
	}
}

async function persistRaw(cwd: string, id: string, rawText: string): Promise<string | undefined> {
	try {
		const dir = join(cwd, ".pix", "session-evidence", "git");
		await mkdir(dir, { recursive: true });
		const rawPath = join(dir, `${id}.txt`);
		try {
			await stat(rawPath);
			// File already exists (same hash = same evidence), skip write.
			return rawPath;
		} catch {
			// File doesn't exist, write it.
			await writeFile(rawPath, rawText, "utf-8");
		}
		await pruneEvidenceStore(dir);
		return rawPath;
	} catch {
		return undefined;
	}
}

export async function createGitEvidenceResult(
	command: string,
	cwd: string,
	output: string,
	fullOutputPath?: string,
): Promise<GitEvidenceResult | undefined> {
	const info = detectGitInspection(command);
	if (!info || isGitEvidenceText(output)) return undefined;

	// Check in-memory cache: same normalized command → reuse cached digest.
	// This skips parsing, hashing, and disk IO for commands already seen.
	const cacheKey = normalizeCachedCommand(command);
	const cached = gitEvidenceCache.get(cacheKey);
	if (cached) return cached;

	const raw = await readRawText(output, fullOutputPath);
	const rawText = raw.text;
	const outputHash = hashText(rawText);
	const id = `git-${info.kind}-${outputHash.slice(0, 12)}`;
	const rawPath = await persistRaw(cwd, id, rawText);
	const digest = parseGitOutput(command, info.kind, rawText, raw.rawTruncated);
	// `text` is the compact digest (~1,200 chars) returned by bash/read for inventory.
	// The model should use `git_evidence_read` to get detailed span content.
	// `detailedText` is the full digest stored for potential future use.
	const text = formatDigest(id, digest, rawPath ?? fullOutputPath, {
		compact: true,
		maxChars: COMPACT_LEDGER_CHARS,
	});
	const detailedText = formatDigest(id, digest, rawPath ?? fullOutputPath, { maxChars: MAX_LEDGER_CHARS });

	const result: GitEvidenceResult = {
		text,
		details: {
			id,
			command,
			kind: info.kind,
			rawPath: rawPath ?? fullOutputPath,
			rawBytes: digest.rawBytes,
			rawLines: digest.rawLines,
			outputHash,
			compactText: text,
			detailedText,
		},
	};

	// Cache the result so repeated commands skip re-execution.
	gitEvidenceCache.set(cacheKey, result);
	return result;
}

function extractText(content: ToolResultMessage["content"]): string {
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function getBashFullOutputPath(message: ToolResultMessage): string | undefined {
	const details = (message as ToolResultWithDetails).details;
	const value = details?.fullOutputPath;
	return typeof value === "string" ? value : undefined;
}

function getGitEvidenceDetails(message: ToolResultWithDetails): GitEvidenceDetails | undefined {
	const value = message.details?.gitEvidence;
	if (!value || typeof value !== "object") return undefined;
	const details = value as Partial<GitEvidenceDetails>;
	return typeof details.id === "string" &&
		typeof details.command === "string" &&
		typeof details.kind === "string" &&
		typeof details.rawBytes === "number" &&
		typeof details.rawLines === "number" &&
		typeof details.outputHash === "string"
		? (details as GitEvidenceDetails)
		: undefined;
}

function compactExistingEvidence(message: ToolResultWithDetails): ToolResultWithDetails {
	const details = getGitEvidenceDetails(message);
	if (!details?.compactText) return message;
	const text = extractText(message.content);
	if (text === details.compactText) return message;
	return { ...message, content: [{ type: "text", text: details.compactText }] };
}

function compactOlderGitEvidenceResults(messages: AgentMessage[]): { messages: AgentMessage[]; changed: boolean } {
	const evidenceResultIndexes: number[] = [];
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (message.role !== "toolResult") continue;
		const toolResult = message as ToolResultWithDetails;
		if (toolResult.toolName === "bash" && getGitEvidenceDetails(toolResult)) evidenceResultIndexes.push(index);
	}

	const keepDetailed = new Set(evidenceResultIndexes.slice(-2));
	let changed = false;
	const compacted = messages.map((message, index) => {
		if (keepDetailed.has(index) || !evidenceResultIndexes.includes(index)) return message;
		const next = compactExistingEvidence(message as ToolResultWithDetails);
		if (next !== message) changed = true;
		return next;
	});
	return { messages: compacted, changed };
}

export async function applyGitEvidenceTransform(messages: AgentMessage[], cwd: string): Promise<AgentMessage[]> {
	const commandByToolCallId = new Map<string, string>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		const assistant = message as AssistantMessage;
		if (!("content" in assistant) || !Array.isArray(assistant.content)) continue;
		for (const block of assistant.content) {
			if (block.type !== "toolCall" || block.name !== "bash") continue;
			const command = (block.arguments as Record<string, unknown> | undefined)?.command;
			if (typeof command === "string") commandByToolCallId.set(block.id, command);
		}
	}

	let changed = false;
	const result: AgentMessage[] = [];
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (message.role === "toolResult" && (message as ToolResultMessage).toolName === "bash") {
			const toolResult = message as ToolResultWithDetails;
			if (getGitEvidenceDetails(toolResult)) {
				result.push(toolResult);
				continue;
			}
			const command = commandByToolCallId.get(toolResult.toolCallId);
			const originalText = extractText(toolResult.content);
			if (command && originalText && !toolResult.isError) {
				const evidence = await createGitEvidenceResult(
					command,
					cwd,
					originalText,
					getBashFullOutputPath(toolResult),
				);
				if (evidence) {
					changed = true;
					result.push({
						...toolResult,
						content: [{ type: "text", text: evidence.text }],
						details: { ...(toolResult.details ?? {}), gitEvidence: evidence.details },
					} satisfies ToolResultWithDetails);
					continue;
				}
			}
		}

		if (message.role === "bashExecution") {
			const bashMessage = message as BashExecutionMessage;
			const evidence = await createGitEvidenceResult(
				bashMessage.command,
				cwd,
				bashMessage.output,
				bashMessage.fullOutputPath,
			);
			if (evidence) {
				changed = true;
				result.push({
					...bashMessage,
					output: evidence.text,
					truncated: false,
					fullOutputPath: evidence.details.rawPath ?? bashMessage.fullOutputPath,
				});
				continue;
			}
		}

		result.push(message);
	}

	const compacted = compactOlderGitEvidenceResults(result);
	return changed || compacted.changed ? compacted.messages : messages;
}
