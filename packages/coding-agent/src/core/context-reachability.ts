/**
 * Context-window optimization: focus-aware reachability pruning.
 *
 * Rather than aging all old tool results uniformly, we compute which results
 * lie on the current demand chain (the paths the model is actively working
 * on) and skip aging for those. Unrelated results are aged more aggressively.
 *
 * This is applied in `transformContext` alongside aging and never mutates
 * persisted session entries.
 */

import type { AgentMessage } from "@earendil-works/pix-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pix-ai";

export type ReachabilityLevel = "active" | "adjacent" | "unrelated";

/**
 * Normalize a path to absolute form if cwd is provided and the path is
 * relative. When cwd is not provided, returns the path unchanged.
 */
function normalizePath(path: string, cwd: string | undefined): string {
	if (!cwd) return path;
	if (path.startsWith("/")) return path;
	return `${cwd.replace(/\/+$/, "")}/${path}`;
}

function getPathArg(args: Record<string, unknown> | undefined): string | undefined {
	if (!args) return undefined;
	const path = args.path ?? args.file_path ?? args.filePath;
	return typeof path === "string" && path.length > 0 ? path : undefined;
}

/**
 * Regex for bash commands that read file content.
 * Captured group 1 is the file path.
 */
const BASH_READ_COMMAND_RE = /\b(?:cat|head|tail|less|more)\s+(?:--?\w+(?:=\S+)?\s+)*["']?([^\s"';|&<>]+)["']?/;

function getBashReadPath(args: Record<string, unknown> | undefined): string | undefined {
	if (!args) return undefined;
	const command = args.command;
	if (typeof command !== "string") return undefined;
	if (/<<|>>|>/.test(command) && !/\bcat\s/.test(command)) return undefined;
	const match = BASH_READ_COMMAND_RE.exec(command);
	return match?.[1] || undefined;
}

interface ReadFileEntry {
	path: string;
	offset?: number;
	limit?: number;
}

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

/**
 * Extract the primary scope path from a tool call.
 * For scope tools (grep/find/ls), returns the directory/file scope.
 * For read/edit/write, returns the exact file path.
 * For bash, returns the read file path if detected.
 */
function extractToolScope(
	toolName: string,
	args: Record<string, unknown> | undefined,
	cwd?: string,
): { path?: string; scope?: string; allPaths?: string[] } | undefined {
	switch (toolName) {
		case "read":
		case "edit":
		case "write": {
			const path = getPathArg(args);
			return path ? { path } : undefined;
		}
		case "read_many": {
			const files = getReadManyPaths(args);
			if (files.length === 0) return undefined;
			return { path: files[0].path, allPaths: files.map((f) => f.path) };
		}
		case "grep": {
			const path = getPathArg(args) ?? cwd;
			return path ? { scope: path } : undefined;
		}
		case "grep_many": {
			const paths = getGrepManyPaths(args, cwd);
			if (paths.length === 0) return undefined;
			return { scope: paths[0], allPaths: paths };
		}
		case "ls":
		case "find": {
			const path = getPathArg(args) ?? cwd;
			return path ? { scope: path } : undefined;
		}
		case "ls_many": {
			const paths = getLsManyPaths(args, cwd);
			if (paths.length === 0) return undefined;
			return { scope: paths[0], allPaths: paths };
		}
		case "bash": {
			const path = getBashReadPath(args);
			return path ? { path } : undefined;
		}
		default:
			return undefined;
	}
}

/**
 * Collect target paths and scopes from the most recent user turns.
 *
 * We find the start of the last `lookbackUserTurns` user turns, then scan
 * forward from that point to collect every toolCall target path/scope.
 * This ensures we only capture tool calls that belong to the current demand
 * chain, not leftover work from earlier turns.
 */
function buildFocusContext(
	messages: AgentMessage[],
	lookbackUserTurns: number,
	cwd?: string,
): { targetPaths: Set<string>; targetScopes: Set<string>; focusToolCallIds: Set<string> } {
	const targetPaths = new Set<string>();
	const targetScopes = new Set<string>();
	const focusToolCallIds = new Set<string>();

	// Find the index of the Nth-most-recent user message.
	let userCount = 0;
	let startIndex = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "user" || msg.role === "bashExecution" || msg.role === "custom") {
			userCount++;
			if (userCount >= lookbackUserTurns) {
				startIndex = i;
				break;
			}
		}
	}

	// Scan forward from startIndex, collecting all toolCall targets.
	for (let i = startIndex; i < messages.length; i++) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		const assistant = msg as AssistantMessage;
		if (!("content" in assistant) || !Array.isArray(assistant.content)) continue;

		for (const block of assistant.content) {
			if (block.type !== "toolCall") continue;
			focusToolCallIds.add(block.id);
			const scope = extractToolScope(block.name, block.arguments as Record<string, unknown> | undefined, cwd);
			if (!scope) continue;

			if (scope.path) {
				targetPaths.add(normalizePath(scope.path, cwd));
				const dir = scope.path.includes("/") ? scope.path.slice(0, scope.path.lastIndexOf("/")) || "/" : ".";
				// Root directory as a scope is too broad to be useful.
				if (dir !== "/") {
					targetScopes.add(normalizePath(dir, cwd));
				}
			}
			if (scope.scope) {
				targetScopes.add(normalizePath(scope.scope, cwd));
			}
			if (scope.allPaths) {
				for (const p of scope.allPaths) {
					targetPaths.add(normalizePath(p, cwd));
				}
			}
		}
	}

	return { targetPaths, targetScopes, focusToolCallIds };
}

/**
 * Check whether a path overlaps any of the target scopes.
 * Overlap means either the path is within the scope, or the scope is within
 * the path (bidirectional prefix match). This handles cases like a grep on
 * /src being adjacent to a read on /src/core/a.ts.
 */
function isInAnyScope(path: string, scopes: Set<string>, cwd?: string): boolean {
	const norm = normalizePath(path, cwd).replace(/\/+$/, "");
	for (const scope of scopes) {
		const s = scope.replace(/\/+$/, "");
		if (norm === s || norm.startsWith(`${s}/`) || s.startsWith(`${norm}/`)) return true;
	}
	return false;
}

/**
 * Compute the reachability level for each toolResult message.
 *
 * @param messages - The conversation messages
 * @param lookbackUserTurns - How many recent user turns to consider as the
 *   active focus. Default is 2.
 * @param cwd - Working directory for resolving relative paths.
 * @returns A map from message index to its ReachabilityLevel.
 */
export function computeReachability(
	messages: AgentMessage[],
	lookbackUserTurns: number = 2,
	cwd?: string,
): Map<number, ReachabilityLevel> {
	const { targetPaths, targetScopes, focusToolCallIds } = buildFocusContext(messages, lookbackUserTurns, cwd);

	// Pre-scan: map toolCallId → scope info
	const callInfo = new Map<string, { toolName: string; path?: string; scope?: string; allPaths?: string[] }>();
	for (const msg of messages) {
		if (msg.role !== "assistant") continue;
		const assistant = msg as AssistantMessage;
		if (!("content" in assistant) || !Array.isArray(assistant.content)) continue;
		for (const block of assistant.content) {
			if (block.type !== "toolCall") continue;
			const scope = extractToolScope(block.name, block.arguments as Record<string, unknown> | undefined, cwd);
			if (scope) {
				callInfo.set(block.id, { toolName: block.name, ...scope });
			}
		}
	}

	const levels = new Map<number, ReachabilityLevel>();

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (msg.role !== "toolResult") continue;
		const result = msg as ToolResultMessage;
		const info = callInfo.get(result.toolCallId);
		if (!info) {
			// Unrecognized tool — leave as unrelated.
			levels.set(i, "unrelated");
			continue;
		}

		let level: ReachabilityLevel = "unrelated";

		// Results whose tool call was issued within the focus window are active.
		if (focusToolCallIds.has(result.toolCallId)) {
			level = "active";
		}
		// Exact path match with a focus target → adjacent (relevant but not current)
		else if (info.path && targetPaths.has(normalizePath(info.path, cwd))) {
			level = "adjacent";
		}
		// Scope prefix match → adjacent
		else if (info.scope && isInAnyScope(info.scope, targetScopes, cwd)) {
			level = "adjacent";
		}
		// Batch: any path matches exactly → adjacent
		else if (info.allPaths) {
			for (const p of info.allPaths) {
				if (targetPaths.has(normalizePath(p, cwd))) {
					level = "adjacent";
					break;
				}
			}
			if (level !== "adjacent" && info.path && isInAnyScope(info.path, targetScopes, cwd)) {
				level = "adjacent";
			}
		}
		// Fallback: single path in scope → adjacent
		else if (info.path && isInAnyScope(info.path, targetScopes, cwd)) {
			level = "adjacent";
		}

		levels.set(i, level);
	}

	return levels;
}
