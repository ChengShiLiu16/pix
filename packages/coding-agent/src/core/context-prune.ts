/**
 * Context-window optimization: stub out stale tool results.
 *
 * A tool result is "stale" when the model has since seen fresher information
 * about the same file/directory, so keeping its full contents in the prompt
 * only wastes tokens. We replace such results with a short placeholder; the
 * model can re-run the tool if it needs current data. This runs on the
 * outgoing context only and never mutates persisted session entries, so it is
 * fully reversible.
 *
 * Staleness rules depend on what information each tool returns and what each
 * mutation changes:
 *
 *   Content tools (read, read_many, grep, grep_many, bash-read) — results
 *   reflect FILE CONTENT.
 *     → stale when a later MUTATION (edit/write) changes content of a file
 *       in the tool's scope, OR a later duplicate read supersedes it.
 *
 *   Structure tools (find, ls, ls_many) — results reflect FILE SYSTEM
 *   STRUCTURE.
 *     → stale when a later STRUCTURAL mutation (write that creates a new file)
 *       adds/removes files in the tool's scope. Content-only mutations (edit)
 *       do NOT make structure tools stale.
 *
 * Scope matching:
 *   - read, read_many, bash-read: path is a FILE → exact match with mutation.
 *   - grep, grep_many: path is a search SCOPE (file or directory) → mutation
 *     file must be within that scope (exact match or prefix match with "/").
 *   - find, ls, ls_many: path is a DIRECTORY scope → mutation file must be
 *     within that scope. When path is absent, cwd is used as the scope.
 *
 * Batch tools (read_many, grep_many, ls_many) combine multiple paths into
 * one result. Since we cannot selectively prune parts of a combined result,
 * the entire result is marked stale when ANY of its paths is affected by a
 * later mutation. Conversely, a later batch read (read_many) that includes
 * the same file supersedes an earlier single-file read of that file.
 *
 * Note: we deliberately do NOT strip historical `thinking` blocks for
 * Anthropic. The Anthropic API already filters thinking from prior turns
 * server-side and only bills for the blocks actually shown to Claude, so
 * client-side stripping would save no billed tokens while invalidating the
 * prefix cache from the rewrite point.
 */

import type { AgentMessage } from "@earendil-works/pix-agent-core";
import type { AssistantMessage, TextContent, ToolResultMessage } from "@earendil-works/pix-ai";

/** Minimum text length (chars) of a result before stubbing is worth it. */
const MIN_STALE_RESULT_CHARS = 600;

const MUTATION_TOOLS = new Set(["edit", "write"]);

/**
 * Tools whose results reflect file CONTENT.
 * Stale when a mutation changes content of a file in their scope.
 */
const CONTENT_TOOLS = new Set(["read", "read_many", "grep", "grep_many", "bash"]);

/**
 * Tools whose results reflect file system STRUCTURE (file listings).
 * Stale when a structural mutation (write creating new file) changes the
 * file list in their scope. Content-only mutations (edit) do NOT affect them.
 */
const STRUCTURE_TOOLS = new Set(["find", "ls", "ls_many"]);

/** All trackable tools that can go stale. */
const STALEABLE_TOOLS = new Set([...CONTENT_TOOLS, ...STRUCTURE_TOOLS]);

/**
 * Tools whose `path` argument represents a search SCOPE (directory or file)
 * rather than a specific file. For these, a mutation on a file WITHIN the
 * scope makes the result stale (prefix match), not just exact path match.
 */
const DIR_SCOPE_TOOLS = new Set(["grep", "grep_many", "find", "ls", "ls_many"]);

/**
 * Regex patterns for bash commands that read file content.
 * Captured group 1 is the file path. Only simple, single-file reads are
 * detected — pipes, redirects, and heredocs are intentionally excluded.
 */
const BASH_READ_COMMAND_RE = /\b(?:cat|head|tail|less|more)\s+(?:--?\w+(?:=\S+)?\s+)*["']?([^\s"';|&<>]+)["']?/;

interface ReadOpKey {
	path: string;
	offset: number | undefined;
	limit: number | undefined;
}

/** Per-file details for read_many batch tools. */
interface ReadFileEntry {
	path: string;
	offset?: number;
	limit?: number;
}

function getPathArg(args: Record<string, unknown> | undefined): string | undefined {
	if (!args) return undefined;
	// Models call edit/write with `path`, `file_path`, or `filePath`; the
	// persisted tool call keeps whichever the model emitted, so accept all three.
	const path = args.path ?? args.file_path ?? args.filePath;
	return typeof path === "string" && path.length > 0 ? path : undefined;
}

function getNumberArg(args: Record<string, unknown> | undefined, key: string): number | undefined {
	const value = args?.[key];
	return typeof value === "number" ? value : undefined;
}

/**
 * Extract a file path from a bash command if it reads file content.
 * Returns undefined for non-file-reading commands or ambiguous cases.
 */
function getBashReadPath(args: Record<string, unknown> | undefined): string | undefined {
	if (!args) return undefined;
	const command = args.command;
	if (typeof command !== "string") return undefined;
	// Skip heredocs and redirect-heavy commands — too ambiguous.
	if (/<<|>>|>/.test(command) && !/\bcat\s/.test(command)) return undefined;
	const match = BASH_READ_COMMAND_RE.exec(command);
	return match?.[1] || undefined;
}

/**
 * Extract all file paths from a read_many call.
 * read_many accepts either `files: [{path, offset?, limit?}]` or
 * `paths: [string]` with shared offset/limit.
 */
function getReadManyPaths(args: Record<string, unknown> | undefined): ReadFileEntry[] {
	if (!args) return [];
	const result: ReadFileEntry[] = [];
	const files = args.files;
	if (Array.isArray(files)) {
		for (const file of files) {
			if (typeof file === "object" && file !== null && typeof file.path === "string" && file.path.length > 0) {
				result.push({
					path: file.path,
					offset: typeof file.offset === "number" ? file.offset : undefined,
					limit: typeof file.limit === "number" ? file.limit : undefined,
				});
			}
		}
	}
	const paths = args.paths;
	if (result.length === 0 && Array.isArray(paths)) {
		const offset = typeof args.offset === "number" ? args.offset : undefined;
		const limit = typeof args.limit === "number" ? args.limit : undefined;
		for (const p of paths) {
			if (typeof p === "string" && p.length > 0) {
				result.push({ path: p, offset, limit });
			}
		}
	}
	return result;
}

/**
 * Extract all search scopes from a grep_many call.
 * grep_many accepts `searches: [{pattern, path?, ...}]` or single-search
 * shorthand with top-level `pattern`/`path`.
 * Returns paths only (patterns are not needed for staleness tracking).
 * When a search has no path, cwd is used as the default scope.
 */
function getGrepManyPaths(args: Record<string, unknown> | undefined, cwd?: string): string[] {
	if (!args) return [];
	const result: string[] = [];
	const searches = args.searches;
	if (Array.isArray(searches)) {
		for (const s of searches) {
			if (typeof s === "object" && s !== null) {
				const p = s.path;
				if (typeof p === "string" && p.length > 0) {
					result.push(p);
				} else if (cwd) {
					result.push(cwd);
				}
			}
		}
	}
	// Single-search shorthand
	if (result.length === 0) {
		const p = args.path;
		if (typeof p === "string" && p.length > 0) {
			result.push(p);
		} else if (cwd && typeof args.pattern === "string") {
			result.push(cwd);
		}
	}
	return result;
}

/**
 * Extract all directory paths from an ls_many call.
 * ls_many accepts `paths: [string]`.
 */
function getLsManyPaths(args: Record<string, unknown> | undefined, cwd?: string): string[] {
	if (!args) return [];
	const result: string[] = [];
	const paths = args.paths;
	if (Array.isArray(paths)) {
		for (const p of paths) {
			if (typeof p === "string" && p.length > 0) result.push(p);
		}
	}
	if (result.length === 0 && cwd) {
		result.push(cwd);
	}
	return result;
}

function textLength(content: ToolResultMessage["content"]): number {
	let chars = 0;
	for (const block of content) {
		if (block.type === "text") chars += block.text.length;
		else if (block.type === "image") chars += 4800; // rough token-equivalent weight
	}
	return chars;
}

/**
 * Normalize a path to absolute form if cwd is provided and the path is
 * relative. This allows matching between tools that use relative paths
 * (read_many, grep_many) and mutations that use absolute paths (edit, write).
 * When cwd is not provided, returns the path unchanged.
 */
function normalizePath(path: string, cwd: string | undefined): string {
	if (!cwd) return path;
	// Already absolute
	if (path.startsWith("/")) return path;
	// Resolve relative path against cwd
	return `${cwd.replace(/\/+$/, "")}/${path}`;
}

/**
 * Check whether a mutation on `mutationPath` affects a tool result with
 * scope `scopePath`. For DIR_SCOPE_TOOLS, the scope is a directory or file
 * prefix, so a mutation on any file within that scope makes the result stale.
 * For other tools (read, bash-read), the scope is a specific file, so only
 * exact matches count.
 *
 * Paths are normalized to absolute form using cwd before comparison, so
 * relative paths from batch tools (read_many, grep_many) can match absolute
 * paths from mutations (edit, write).
 */
function isPathInScope(mutationPath: string, scopePath: string, isDirScope: boolean, cwd?: string): boolean {
	const m = normalizePath(mutationPath, cwd).replace(/\/+$/, "");
	const s = normalizePath(scopePath, cwd).replace(/\/+$/, "");
	if (m === s) return true;
	if (isDirScope && m.startsWith(`${s}/`)) return true;
	return false;
}

/**
 * Determine whether a mutation makes a single-path tool result stale,
 * considering both scope matching and information type (content vs structure).
 */
function isStaleMutation(opName: string, laterName: string, opPath: string, laterPath: string, cwd?: string): boolean {
	if (!MUTATION_TOOLS.has(laterName)) return false;
	const isDirScope = DIR_SCOPE_TOOLS.has(opName);
	if (!isPathInScope(laterPath, opPath, isDirScope, cwd)) return false;
	if (CONTENT_TOOLS.has(opName)) return true;
	return laterName === "write";
}

/**
 * Determine whether a mutation makes a batch tool result stale.
 * A batch result is stale if the mutation affects ANY of its paths.
 */
function isBatchStaleMutation(
	opName: string,
	opPaths: string[],
	laterName: string,
	laterPath: string,
	cwd?: string,
): boolean {
	if (!MUTATION_TOOLS.has(laterName)) return false;
	const isDirScope = DIR_SCOPE_TOOLS.has(opName);
	const isContentTool = CONTENT_TOOLS.has(opName);
	for (const opPath of opPaths) {
		if (isPathInScope(laterPath, opPath, isDirScope, cwd)) {
			if (isContentTool) return true;
			if (laterName === "write") return true;
		}
	}
	return false;
}

/**
 * Determine whether a later read covers (supersedes) an earlier read.
 * A read with no offset/limit reads the entire file and covers any partial
 * read. A partial read covers another partial read only when its range is
 * a strict superset — i.e. it starts at the same or earlier line AND ends
 * at the same or later line.
 *
 * Offset is 1-indexed (line number). When undefined, it means "from the
 * start of the file". Limit is the max number of lines; when undefined,
 * it means "to the end of the file".
 */
function readCovers(later: ReadOpKey, earlier: ReadOpKey): boolean {
	// If the later read has no offset/limit, it reads the whole file
	// and covers any earlier read of the same file.
	if (later.offset === undefined && later.limit === undefined) return true;

	// If the earlier read has no offset/limit (whole file), it can only
	// be covered by another whole-file read (handled above).
	if (earlier.offset === undefined && earlier.limit === undefined) return false;

	// Both are partial reads. Check if later's range is a superset.
	const laterStart = later.offset ?? 1;
	const earlierStart = earlier.offset ?? 1;
	if (laterStart > earlierStart) return false;

	// later starts at the same or earlier line. Check end.
	const laterEnd = later.limit === undefined ? Infinity : laterStart + later.limit;
	const earlierEnd = earlier.limit === undefined ? Infinity : earlierStart + earlier.limit;
	return laterEnd >= earlierEnd;
}

/** Stale placeholder text per tool category. */
function stalePlaceholder(toolName: string): string {
	switch (toolName) {
		case "read":
		case "read_many":
			return "[Stale read omitted to save context — this file was re-read or modified later. Re-read it if you need its current contents.]";
		case "grep":
		case "grep_many":
			return "[Stale grep result omitted to save context — a file in the search scope was modified later. Re-grep if you need current matches.]";
		case "find":
			return "[Stale find result omitted to save context — a file was added in the search scope later. Re-run find if needed.]";
		case "ls":
		case "ls_many":
			return "[Stale ls result omitted to save context — a file was added in the listed directory later. Re-run ls if needed.]";
		case "bash":
			return "[Stale command output omitted to save context — the read file was modified later. Re-run if needed.]";
		default:
			return "[Stale result omitted to save context — the referenced file was modified later. Re-run the tool if needed.]";
	}
}

/** Info extracted from a tool call for staleness tracking. */
interface CallInfoEntry {
	name: string;
	/** Primary path (for single-path tools and mutations). */
	path: string;
	offset?: number;
	limit?: number;
	/** All paths for batch tools. Undefined for single-path tools. */
	allPaths?: string[];
	/** Per-file details for read_many. Undefined for other tools. */
	files?: ReadFileEntry[];
	/** Whether this is a batch tool. */
	isBatch: boolean;
}

/** A tracked tool result in the staleness check loop. */
interface ResultOp {
	index: number;
	name: string;
	key: ReadOpKey;
	isError: boolean;
	/** All paths for batch tools. [key.path] for single tools. */
	allPaths: string[];
	/** Whether this is a batch tool result. */
	isBatch: boolean;
	/** Per-file details for read_many. */
	files?: ReadFileEntry[];
}

/**
 * Replace stale tool results with a short placeholder to reduce context size.
 * Returns the original array when nothing is stubbed.
 *
 * @param messages - The conversation messages to process
 * @param cwd - Working directory, used as default scope for tools with
 *   optional path parameters (grep, find, ls, and their batch variants).
 *   When omitted, tools without an explicit path are not tracked for staleness.
 */
export function pruneStaleReads(messages: AgentMessage[], cwd?: string): AgentMessage[] {
	// Map each tool call id -> CallInfoEntry for tracked tools.
	const callInfo = new Map<string, CallInfoEntry>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		const assistant = message as AssistantMessage;
		for (const block of assistant.content) {
			if (block.type !== "toolCall") continue;
			const args = block.arguments as Record<string, unknown> | undefined;

			if (block.name === "bash") {
				const path = getBashReadPath(args);
				if (path) {
					callInfo.set(block.id, { name: "bash", path, isBatch: false });
				}
			} else if (block.name === "read_many") {
				const files = getReadManyPaths(args);
				if (files.length > 0) {
					callInfo.set(block.id, {
						name: "read_many",
						path: files[0].path,
						allPaths: files.map((f) => f.path),
						files,
						isBatch: true,
					});
				}
			} else if (block.name === "grep_many") {
				const paths = getGrepManyPaths(args, cwd);
				if (paths.length > 0) {
					callInfo.set(block.id, {
						name: "grep_many",
						path: paths[0],
						allPaths: paths,
						isBatch: true,
					});
				}
			} else if (block.name === "ls_many") {
				const paths = getLsManyPaths(args, cwd);
				if (paths.length > 0) {
					callInfo.set(block.id, {
						name: "ls_many",
						path: paths[0],
						allPaths: paths,
						isBatch: true,
					});
				}
			} else if (STALEABLE_TOOLS.has(block.name)) {
				let path = getPathArg(args);
				if (!path && DIR_SCOPE_TOOLS.has(block.name) && cwd) {
					path = cwd;
				}
				if (path) {
					callInfo.set(block.id, {
						name: block.name,
						path,
						offset: getNumberArg(args, "offset"),
						limit: getNumberArg(args, "limit"),
						isBatch: false,
					});
				}
			} else if (MUTATION_TOOLS.has(block.name)) {
				const path = getPathArg(args);
				if (path) {
					callInfo.set(block.id, { name: block.name, path, isBatch: false });
				}
			}
		}
	}

	// Walk tool results in order, recording per-path op history.
	const ops: ResultOp[] = [];
	messages.forEach((message, index) => {
		if (message.role !== "toolResult") return;
		const result = message as ToolResultMessage;
		const info = callInfo.get(result.toolCallId);
		if (!info) return;
		ops.push({
			index,
			name: info.name,
			key: { path: info.path, offset: info.offset, limit: info.limit },
			isError: result.isError,
			allPaths: info.allPaths ?? [info.path],
			isBatch: info.isBatch,
			files: info.files,
		});
	});

	const staleIndices = new Map<number, string>(); // index -> toolName
	for (let i = 0; i < ops.length; i++) {
		const op = ops[i];
		// Only staleable results can go stale. Mutations and unrecognized
		// tools are never stubbed themselves.
		if (!STALEABLE_TOOLS.has(op.name)) continue;
		if (op.isError) continue;

		for (let j = i + 1; j < ops.length; j++) {
			const later = ops[j];
			// A failed op did not change the file or return fresh content, so it
			// cannot supersede an earlier result.
			if (later.isError) continue;

			// --- Mutation makes result stale ---

			if (op.isBatch) {
				// Batch: stale if mutation affects ANY of the batch's paths.
				if (isBatchStaleMutation(op.name, op.allPaths, later.name, later.key.path, cwd)) {
					staleIndices.set(op.index, op.name);
					break;
				}
			} else {
				// Single: existing logic.
				if (isStaleMutation(op.name, later.name, op.key.path, later.key.path, cwd)) {
					staleIndices.set(op.index, op.name);
					break;
				}
			}

			// --- Later read supersedes earlier read ---

			// Only reads supersede earlier reads. Other tools (grep/find/ls/bash)
			// do NOT supersede each other or reads — they return partial/different
			// views. Batch results are NOT superseded by later reads of individual
			// files (we can't selectively prune parts of a combined result).

			if (op.name === "read" && !op.isBatch) {
				const opNormPath = normalizePath(op.key.path, cwd);
				// Later single read supersedes earlier read of the same file
				if (later.name === "read" && !later.isBatch) {
					const laterNormPath = normalizePath(later.key.path, cwd);
					if (opNormPath === laterNormPath) {
						// Check if the later read covers the earlier read's range.
						// A read with no offset/limit reads the whole file and
						// covers any partial read. A partial read covers another
						// partial read if its range is a superset.
						if (readCovers(later.key, op.key)) {
							staleIndices.set(op.index, op.name);
							break;
						}
					}
				}
				// Later read_many supersedes earlier read if it includes the same
				// file with a range that covers the earlier read
				if (later.name === "read_many" && later.files) {
					const match = later.files.find(
						(f) =>
							normalizePath(f.path, cwd) === opNormPath &&
							readCovers({ path: "", offset: f.offset, limit: f.limit }, op.key),
					);
					if (match) {
						staleIndices.set(op.index, op.name);
						break;
					}
				}
			}
		}
	}

	if (staleIndices.size === 0) return messages;

	let changed = false;
	const result = messages.map((message, index) => {
		if (!staleIndices.has(index) || message.role !== "toolResult") return message;
		const toolResult = message as ToolResultMessage;
		if (textLength(toolResult.content) < MIN_STALE_RESULT_CHARS) return message;
		changed = true;
		const toolName = staleIndices.get(index)!;
		const stub: TextContent = {
			type: "text",
			text: stalePlaceholder(toolName),
		};
		return { ...toolResult, content: [stub], details: undefined } satisfies ToolResultMessage;
	});

	return changed ? result : messages;
}

/**
 * Strip historical `thinking` blocks from assistant messages for non-Anthropic
 * providers. The Anthropic API already filters thinking from prior turns
 * server-side and only bills for the blocks shown to Claude, so client-side
 * stripping would save no billed tokens while invalidating the prefix cache.
 *
 * For other providers (OpenAI, Google, etc.), thinking blocks are included in
 * the full prompt and consume tokens. We replace them with a short summary
 * that preserves the reasoning direction without the full text.
 *
 * Thinking blocks that carry API signatures (thinkingSignature) or are
 * redacted are preserved intact — they are needed for multi-turn reasoning
 * continuity with OpenAI and Google APIs.
 *
 * Returns the original array when nothing is changed.
 */
export function pruneThinkingForNonAnthropic(messages: AgentMessage[], provider: string): AgentMessage[] {
	if (provider === "anthropic") return messages;

	let changed = false;
	const result = messages.map((message) => {
		if (message.role !== "assistant") return message;
		const assistant = message as AssistantMessage;
		if (!("content" in assistant) || !Array.isArray(assistant.content)) return message;

		let msgChanged = false;
		const newContent = assistant.content.map((block) => {
			if (block.type !== "thinking") return block;
			// Preserve thinking blocks that carry API signatures or are
			// redacted — they are needed for multi-turn reasoning continuity
			// with OpenAI (reasoning item ID) and Google (thought signature).
			if ("thinkingSignature" in block && block.thinkingSignature) return block;
			if ("redacted" in block && block.redacted) return block;
			msgChanged = true;
			const thinking = block.thinking;
			const summary =
				thinking.length > 100
					? `${thinking.slice(0, 100)}... [${thinking.length} chars of thinking omitted]`
					: thinking;
			return { type: "text" as const, text: `[Thinking: ${summary}]` };
		});

		if (!msgChanged) return message;
		changed = true;
		return { ...assistant, content: newContent } satisfies AssistantMessage;
	});

	return changed ? result : messages;
}
