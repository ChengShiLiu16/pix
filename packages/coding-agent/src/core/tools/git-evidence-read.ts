import { createHash } from "node:crypto";
import { readdir as fsReaddir, readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AgentTool } from "@earendil-works/pix-agent-core";
import { Text } from "@earendil-works/pix-tui";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { getTextOutput, invalidArgText, shortenPath, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const gitEvidenceReadRangeSchema = Type.Object({
	id: Type.Optional(Type.String({ description: "Git evidence id for this span" })),
	path: Type.Optional(Type.String({ description: "Raw git evidence path for this span" })),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read for this span" })),
});

const gitEvidenceReadSchema = Type.Object({
	id: Type.Optional(Type.String({ description: "Git evidence id, e.g. git-show-abcdef123456" })),
	path: Type.Optional(Type.String({ description: "Raw git evidence path from the evidence digest" })),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read (default: 80, max: 160)" })),
	ranges: Type.Optional(
		Type.Array(gitEvidenceReadRangeSchema, {
			description: "Read multiple raw evidence spans in one call. Each range needs id or path.",
		}),
	),
	pattern: Type.Optional(Type.String({ description: "Optional literal text to search within the evidence" })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive pattern search (default: false)" })),
	context: Type.Optional(Type.Number({ description: "Context lines around pattern matches (default: 0, max: 10)" })),
});

export type GitEvidenceReadToolInput = Static<typeof gitEvidenceReadSchema>;

export interface GitEvidenceReadToolDetails {
	evidenceId?: string;
	totalLines?: number;
	startLine?: number;
	endLine?: number;
	spanHash?: string;
	ranges?: GitEvidenceReadToolDetails[];
	matchLimitReached?: number;
	entries?: number;
}

export interface GitEvidenceReadOperations {
	readFile: (absolutePath: string) => Promise<string> | string;
	readdir: (absolutePath: string) => Promise<string[]> | string[];
	stat: (absolutePath: string) => Promise<{ size: number; mtimeMs: number }> | { size: number; mtimeMs: number };
}

const defaultGitEvidenceReadOperations: GitEvidenceReadOperations = {
	readFile: (path) => fsReadFile(path, "utf-8"),
	readdir: (path) => fsReaddir(path),
	stat: (path) => fsStat(path),
};

export interface GitEvidenceReadToolOptions {
	operations?: GitEvidenceReadOperations;
}

const EVIDENCE_ID_RE = /^git-(?:log|show|diff|diff-tree|status|blame|grep)-[0-9a-f]{12}$/u;
const DEFAULT_LIMIT = 80;
const MAX_LIMIT = 160;
const MAX_RANGES = 8;
const MAX_CONTEXT = 10;
const MATCH_LIMIT = 50;

function getEvidenceDir(cwd: string): string {
	return resolve(cwd, ".pix", "session-evidence", "git");
}

function hashText(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

function resolveEvidenceTarget(
	cwd: string,
	id: string | undefined,
	path: string | undefined,
): { path: string; id?: string } {
	const evidenceDir = getEvidenceDir(cwd);
	let resolvedPath: string;
	let evidenceId = id;

	if (id) {
		if (!EVIDENCE_ID_RE.test(id)) throw new Error(`Invalid git evidence id: ${id}`);
		resolvedPath = join(evidenceDir, `${id}.txt`);
	} else if (path) {
		resolvedPath = resolve(cwd, path);
		const name = basename(resolvedPath, ".txt");
		if (EVIDENCE_ID_RE.test(name)) evidenceId = name;
	} else {
		throw new Error("git_evidence_read requires either id or path");
	}

	const relativePath = relative(evidenceDir, resolvedPath);
	if (
		relativePath === "" ||
		relativePath === ".." ||
		relativePath.startsWith(`..${sep}`) ||
		isAbsolute(relativePath)
	) {
		throw new Error("git_evidence_read can only read files under .pix/session-evidence/git");
	}
	return { path: resolvedPath, id: evidenceId };
}

function isMissingPathError(error: unknown): boolean {
	return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

async function listEvidenceFiles(
	cwd: string,
	ops: GitEvidenceReadOperations,
): Promise<Array<{ id: string; path: string; size: number; mtimeMs: number }>> {
	const evidenceDir = getEvidenceDir(cwd);
	let entries: string[];
	try {
		entries = await ops.readdir(evidenceDir);
	} catch (error) {
		if (isMissingPathError(error)) return [];
		throw error;
	}
	const files: Array<{ id: string; path: string; size: number; mtimeMs: number }> = [];
	for (const entry of entries) {
		if (!entry.endsWith(".txt")) continue;
		const id = entry.slice(0, -".txt".length);
		if (!EVIDENCE_ID_RE.test(id)) continue;
		const path = join(evidenceDir, entry);
		const fileStat = await ops.stat(path);
		files.push({ id, path, size: fileStat.size, mtimeMs: fileStat.mtimeMs });
	}
	files.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return files;
}

function clampPositive(value: number | undefined, fallback: number, max: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.min(Math.max(Math.floor(value), 1), max);
}

function isCappedLimit(value: number | undefined, max: number): boolean {
	return value !== undefined && Number.isFinite(value) && Math.floor(value) > max;
}

function formatRead(
	evidenceId: string | undefined,
	lines: string[],
	offset: number | undefined,
	limit: number | undefined,
): {
	text: string;
	details: GitEvidenceReadToolDetails;
} {
	const totalLines = lines.length;
	const startIndex = offset ? Math.max(0, Math.floor(offset) - 1) : 0;
	if (startIndex >= totalLines) {
		throw new Error(`Offset ${offset} is beyond end of evidence (${totalLines} lines total)`);
	}

	const effectiveLimit = clampPositive(limit, DEFAULT_LIMIT, MAX_LIMIT);
	const cappedLimit = isCappedLimit(limit, MAX_LIMIT);
	const endIndex = Math.min(startIndex + effectiveLimit, totalLines);
	const startLine = startIndex + 1;
	const endLine = endIndex;
	const visibleLines = lines.slice(startIndex, endIndex);
	const spanHash = hashText(visibleLines.join("\n"));
	let text = visibleLines.join("\n");
	if (endIndex < totalLines) {
		text += `\n\n[Showing lines ${startLine}-${endLine} of ${totalLines}. Use offset=${endIndex + 1} to continue.]`;
	} else {
		text += `\n\n[Showing lines ${startLine}-${endLine} of ${totalLines}.]`;
	}
	if (cappedLimit) {
		text += `\n[Requested limit ${Math.floor(limit!)} capped to ${MAX_LIMIT}; use narrower offsets/ranges for targeted evidence.]`;
	}
	if (evidenceId) text += `\n[Evidence span ${evidenceId}:${startLine}-${endLine} hash=${spanHash}]`;
	return { text, details: { evidenceId, totalLines, startLine, endLine, spanHash } };
}

function formatSearch(
	lines: string[],
	pattern: string,
	ignoreCase: boolean | undefined,
	context: number | undefined,
): { text: string; details: GitEvidenceReadToolDetails } {
	const needle = ignoreCase ? pattern.toLowerCase() : pattern;
	const contextLines = Math.min(Math.max(Math.floor(context ?? 0), 0), MAX_CONTEXT);
	const output: string[] = [];
	let matches = 0;
	for (let index = 0; index < lines.length; index++) {
		const haystack = ignoreCase ? lines[index].toLowerCase() : lines[index];
		if (!haystack.includes(needle)) continue;
		matches++;
		if (matches > MATCH_LIMIT) break;
		const start = Math.max(0, index - contextLines);
		const end = Math.min(lines.length, index + contextLines + 1);
		if (output.length > 0) output.push("--");
		for (let lineIndex = start; lineIndex < end; lineIndex++) {
			output.push(`${lineIndex + 1}: ${lines[lineIndex]}`);
		}
	}

	if (matches === 0) return { text: "(no matches)", details: { totalLines: lines.length } };
	if (matches > MATCH_LIMIT) output.push(`[${MATCH_LIMIT} matches shown. Narrow the pattern for more.]`);
	return {
		text: output.join("\n"),
		details: { totalLines: lines.length, matchLimitReached: matches > MATCH_LIMIT ? MATCH_LIMIT : undefined },
	};
}

function formatList(entries: Array<{ id: string; path: string; size: number }>): {
	text: string;
	details: GitEvidenceReadToolDetails;
} {
	if (entries.length === 0) return { text: "(no git evidence captured)", details: { entries: 0 } };
	const lines = entries.slice(0, 50).map((entry) => `- ${entry.id} (${entry.size} bytes) ${entry.path}`);
	if (entries.length > 50) lines.push(`- ... ${entries.length - 50} more evidence files omitted`);
	return { text: lines.join("\n"), details: { entries: entries.length } };
}

async function searchEvidenceFiles(
	cwd: string,
	ops: GitEvidenceReadOperations,
	pattern: string,
	ignoreCase: boolean | undefined,
	context: number | undefined,
): Promise<{ text: string; details: GitEvidenceReadToolDetails }> {
	const entries = await listEvidenceFiles(cwd, ops);
	const output: string[] = [];
	let shown = 0;
	for (const entry of entries) {
		if (shown >= MATCH_LIMIT) break;
		const lines = (await ops.readFile(entry.path)).split("\n");
		const result = formatSearch(lines, pattern, ignoreCase, context);
		if (result.text === "(no matches)") continue;
		if (output.length > 0) output.push("====");
		output.push(`[${entry.id}]`);
		const resultLines = result.text.split("\n");
		for (const line of resultLines) {
			if (shown >= MATCH_LIMIT) break;
			output.push(line);
			if (line !== "--") shown++;
		}
	}
	if (output.length === 0) return { text: "(no matches)", details: { entries: entries.length } };
	if (shown >= MATCH_LIMIT) output.push(`[${MATCH_LIMIT} matching lines shown. Narrow the pattern or provide an id.]`);
	return {
		text: output.join("\n"),
		details: { entries: entries.length, matchLimitReached: shown >= MATCH_LIMIT ? MATCH_LIMIT : undefined },
	};
}

function formatGitEvidenceReadCall(
	args:
		| { id?: string; path?: string; offset?: number; limit?: number; pattern?: string; ranges?: unknown[] }
		| undefined,
	theme: typeof import("../../modes/interactive/theme/theme.ts").theme,
): string {
	const target = str(args?.ranges ? `ranges(${args.ranges.length})` : (args?.id ?? args?.path));
	const invalidArg = invalidArgText(theme);
	let text = `${theme.fg("toolTitle", theme.bold("git_evidence_read"))} ${
		target === null ? invalidArg : theme.fg("accent", target ? shortenPath(target) : "...")
	}`;
	if (args?.pattern) text += theme.fg("toolOutput", ` /${args.pattern}/`);
	if (args?.offset !== undefined || args?.limit !== undefined) {
		text += theme.fg("toolOutput", `:${args.offset ?? 1}${args.limit ? `+${args.limit}` : ""}`);
	}
	return text;
}

export function createGitEvidenceReadToolDefinition(
	cwd: string,
	options?: GitEvidenceReadToolOptions,
): ToolDefinition<typeof gitEvidenceReadSchema, GitEvidenceReadToolDetails | undefined> {
	const ops = options?.operations ?? defaultGitEvidenceReadOperations;
	return {
		name: "git_evidence_read",
		label: "git evidence read",
		description:
			"Read or search raw git evidence captured from git log/show/diff/diff-tree/status/blame. Use id/path or ranges from a Git evidence digest. Supports offset/limit and literal pattern search.",
		promptSnippet: "Read/search captured raw git evidence by id or path",
		promptGuidelines: [
			"When a Git evidence digest shows hunk spans like git-show-abcdef123456:120-180, use git_evidence_read with offset/limit before making non-inventory claims.",
			"Read narrow spans only: default limit is 80 lines and max is 160 lines. Prefer exact hunk spans or pattern search before reading a range.",
			"Use ranges to read several targeted spans in one call instead of rerunning broad git show/diff commands.",
		],
		parameters: gitEvidenceReadSchema,
		async execute(_toolCallId, { id, path, offset, limit, ranges, pattern, ignoreCase, context }) {
			if (ranges && ranges.length > 0) {
				const outputs: string[] = [];
				const details: GitEvidenceReadToolDetails[] = [];
				for (const range of ranges.slice(0, MAX_RANGES)) {
					const target = resolveEvidenceTarget(cwd, range.id, range.path);
					const content = await ops.readFile(target.path);
					const result = formatRead(target.id, content.split("\n"), range.offset, range.limit);
					outputs.push(`==== ${target.id ?? target.path} ====\n${result.text}`);
					details.push(result.details);
				}
				if (ranges.length > MAX_RANGES)
					outputs.push(`[${ranges.length - MAX_RANGES} ranges omitted; max ${MAX_RANGES}.]`);
				return { content: [{ type: "text", text: outputs.join("\n\n") }], details: { ranges: details } };
			}
			if (!id && !path) {
				const result = pattern
					? await searchEvidenceFiles(cwd, ops, pattern, ignoreCase, context)
					: formatList(await listEvidenceFiles(cwd, ops));
				return { content: [{ type: "text", text: result.text }], details: result.details };
			}
			const target = resolveEvidenceTarget(cwd, id, path);
			const content = await ops.readFile(target.path);
			const lines = content.split("\n");
			const result = pattern
				? formatSearch(lines, pattern, ignoreCase, context)
				: formatRead(target.id, lines, offset, limit);
			const withSection =
				target.id && !pattern ? `==== Evidence: ${target.id} ====\n${result.text}\n====` : result.text;
			return { content: [{ type: "text", text: withSection }], details: result.details };
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatGitEvidenceReadCall(args, theme));
			return text;
		},
		renderResult(result, _options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const output = getTextOutput(result, context.showImages).trim();
			text.setText(
				output
					? `\n${output
							.split("\n")
							.slice(0, 20)
							.map((line) => theme.fg("toolOutput", line))
							.join("\n")}`
					: "",
			);
			return text;
		},
	};
}

export function createGitEvidenceReadTool(
	cwd: string,
	options?: GitEvidenceReadToolOptions,
): AgentTool<typeof gitEvidenceReadSchema> {
	return wrapToolDefinition(createGitEvidenceReadToolDefinition(cwd, options));
}
