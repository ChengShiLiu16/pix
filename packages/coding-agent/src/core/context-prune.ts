/**
 * Context-window optimization: stub out stale `read` tool results.
 *
 * A read result is "stale" when the model has since seen fresher information
 * about the same file, so keeping its full contents in the prompt only wastes
 * tokens. We replace such results with a short placeholder; the model can
 * re-read the file if it needs the current contents. This runs on the
 * outgoing context only and never mutates persisted session entries, so it is
 * fully reversible.
 *
 * A read of path P is stale when, later in the conversation, there is either:
 *   - a mutation (`edit`/`write`) of P — the file changed, so the read is no
 *     longer accurate, or
 *   - another `read` of P with the same `offset`/`limit` window — an exact
 *     duplicate that supersedes it.
 *
 * Reads with different offset/limit windows are preserved (they show different
 * parts of the file), and error results are left untouched.
 *
 * Note: we deliberately do NOT strip historical `thinking` blocks. The Anthropic
 * API already filters thinking from prior turns server-side and only bills for
 * the blocks actually shown to Claude, so client-side stripping would save no
 * billed tokens while invalidating the prefix cache from the rewrite point.
 */

import type { AgentMessage } from "@earendil-works/pix-agent-core";
import type { AssistantMessage, TextContent, ToolResultMessage } from "@earendil-works/pix-ai";

/** Minimum text length (chars) of a read result before stubbing is worth it. */
const MIN_STALE_READ_CHARS = 600;

const MUTATION_TOOLS = new Set(["edit", "write"]);

interface ReadOpKey {
	path: string;
	offset: number | undefined;
	limit: number | undefined;
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

function textLength(content: ToolResultMessage["content"]): number {
	let chars = 0;
	for (const block of content) {
		if (block.type === "text") chars += block.text.length;
		else if (block.type === "image") chars += 4800; // rough token-equivalent weight
	}
	return chars;
}

/**
 * Replace stale `read` tool results with a short placeholder to reduce context size.
 * Returns the original array when nothing is stubbed.
 */
export function pruneStaleReads(messages: AgentMessage[]): AgentMessage[] {
	// Map each tool call id -> { name, path, offset, limit } for read/edit/write calls.
	const callInfo = new Map<string, { name: string; path: string; offset?: number; limit?: number }>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		const assistant = message as AssistantMessage;
		for (const block of assistant.content) {
			if (block.type !== "toolCall") continue;
			if (block.name !== "read" && !MUTATION_TOOLS.has(block.name)) continue;
			const path = getPathArg(block.arguments);
			if (!path) continue;
			callInfo.set(block.id, {
				name: block.name,
				path,
				offset: getNumberArg(block.arguments, "offset"),
				limit: getNumberArg(block.arguments, "limit"),
			});
		}
	}

	// Walk tool results in order, recording per-path op history so we can decide
	// staleness in a single pass from the end.
	interface ResultOp {
		index: number;
		name: string;
		key: ReadOpKey;
		isError: boolean;
	}
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
		});
	});

	const staleIndices = new Set<number>();
	for (let i = 0; i < ops.length; i++) {
		const op = ops[i];
		if (op.name !== "read" || op.isError) continue;
		for (let j = i + 1; j < ops.length; j++) {
			const later = ops[j];
			if (later.key.path !== op.key.path) continue;
			// A failed op did not change the file or return fresh content, so it
			// cannot supersede an earlier read.
			if (later.isError) continue;
			const isLaterMutation = MUTATION_TOOLS.has(later.name);
			const isDuplicateRead =
				later.name === "read" && later.key.offset === op.key.offset && later.key.limit === op.key.limit;
			if (isLaterMutation || isDuplicateRead) {
				staleIndices.add(op.index);
				break;
			}
		}
	}

	if (staleIndices.size === 0) return messages;

	let changed = false;
	const result = messages.map((message, index) => {
		if (!staleIndices.has(index) || message.role !== "toolResult") return message;
		const toolResult = message as ToolResultMessage;
		if (textLength(toolResult.content) < MIN_STALE_READ_CHARS) return message;
		changed = true;
		const stub: TextContent = {
			type: "text",
			text: "[Stale read omitted to save context — this file was re-read or modified later. Re-read it if you need its current contents.]",
		};
		return { ...toolResult, content: [stub], details: undefined } satisfies ToolResultMessage;
	});

	return changed ? result : messages;
}
