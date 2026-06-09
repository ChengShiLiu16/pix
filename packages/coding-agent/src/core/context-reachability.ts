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

import type { AgentMessage } from "@chengshiliu16/pix-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@chengshiliu16/pix-ai";
import {
	getBashReadPath,
	getGrepManyPaths,
	getLsManyPaths,
	getPathArg,
	getReadManyPaths,
	normalizePath,
} from "./context-tool-scope.ts";

export type ReachabilityLevel = "active" | "adjacent" | "unrelated";

const FILE_PATH_RE =
	/\b(?:\.{1,2}\/|\/)?[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_.-]+)+\.(?:ts|js|tsx|jsx|py|rs|go|java|cpp|c|h|json|md|txt)\b/gu;

function addTargetPath(path: string, targetPaths: Set<string>, targetScopes: Set<string>, cwd?: string): void {
	targetPaths.add(normalizePath(path, cwd));
	const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) || "/" : ".";
	if (dir !== "/") {
		targetScopes.add(normalizePath(dir, cwd));
	}
}

function messageText(message: AgentMessage): string {
	if (message.role === "user" || message.role === "custom") {
		const content = message.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.filter((block): block is { type: "text"; text: string } => block.type === "text")
				.map((block) => block.text)
				.join("\n");
		}
	}
	if (message.role === "bashExecution") return message.command;
	return "";
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
		case "ffgrep": {
			const path = getPathArg(args) ?? cwd;
			return path ? { scope: path } : undefined;
		}
		case "grep_many": {
			const paths = getGrepManyPaths(args, cwd);
			if (paths.length === 0) return undefined;
			return { scope: paths[0], allPaths: paths };
		}
		case "fff-multi-grep":
		case "multi_grep": {
			return cwd ? { scope: cwd } : undefined;
		}
		case "ls":
		case "find": {
			const path = getPathArg(args) ?? cwd;
			return path ? { scope: path } : undefined;
		}
		case "ffind":
		case "fffind": {
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

	// 从 focus 窗口起点向后扫描，收集用户显式提到的路径和工具调用目标。
	for (let i = startIndex; i < messages.length; i++) {
		const msg = messages[i];
		if (msg.role === "user" || msg.role === "custom" || msg.role === "bashExecution") {
			for (const match of messageText(msg).matchAll(FILE_PATH_RE)) {
				addTargetPath(match[0], targetPaths, targetScopes, cwd);
			}
		}
		if (msg.role !== "assistant") continue;
		const assistant = msg as AssistantMessage;
		if (!("content" in assistant) || !Array.isArray(assistant.content)) continue;

		for (const block of assistant.content) {
			if (block.type !== "toolCall") continue;
			focusToolCallIds.add(block.id);
			const scope = extractToolScope(block.name, block.arguments as Record<string, unknown> | undefined, cwd);
			if (!scope) continue;

			if (scope.path) {
				addTargetPath(scope.path, targetPaths, targetScopes, cwd);
			}
			if (scope.scope) {
				const normalizedScope = normalizePath(scope.scope, cwd);
				// Skip root-level scopes (cwd = project root) — they make everything
				// in the project adjacent, which effectively disables aging for
				// unrelated history since every path falls within the project dir.
				const normalizedCwd = cwd ? normalizePath(cwd, cwd) : "";
				if (normalizedScope !== normalizedCwd) {
					targetScopes.add(normalizedScope);
				}
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
