/**
 * Tracks consecutive same-type tool runs within one user turn (until next user message).
 *
 * Group assignment happens ONLY via tool_call handlers (activity-widget). renderCall is read-only.
 *
 * Same-type tool calls merge when back-to-back with no intervening user-visible assistant text,
 * thinking blocks, or other tools. A batch group breaks when:
 *   - Visible assistant text appears after at least one tool IN THE SAME assistant message
 *     (non-whitespace text_delta/text_end on a text block that started after that message's tools)
 *   - A thinking block starts after at least one tool (thinking_start; does not retroactively split)
 *   - A different tool type runs (recordOtherTool via tool_call only — never from renderCall)
 *   - The batch is reset (new user message or session start)
 *
 * text_start alone does not break. Empty/whitespace text blocks do not break.
 * Pre-tool text in a new assistant message does not break even when prior turns had tools.
 * Pre-tool text blocks that close after parallel tool_calls in one message do not break.
 */
import { getBatchGlobalStore, type ToolCategory } from "./batch-global-store.ts";

export type { ToolCategory };

function seq() {
	return getBatchGlobalStore().sequence;
}

export function registerContentBreakListener(listener: () => void): () => void {
	const listeners = seq().contentBreakListeners;
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function resetToolBatchSequence(): void {
	const s = seq();
	s.lastCategory = null;
	s.contentBreakSeq = 0;
	s.toolsSinceLastBreak = false;
	s.toolsInCurrentAssistantMessage = false;
	s.activeTextBlockFollowsToolsInMessage = null;
	s.activeBashBreakSeq = -1;
	s.activeReadBreakSeq = -1;
	s.bashGroupSeq = 0;
	s.readGroupSeq = 0;
	s.bashGroupByToolCall.clear();
	s.readGroupByToolCall.clear();
	toolCallOrderList().length = 0;
}

const toolCallOrderListeners = new Set<() => void>();

/** Subscribe to tool_call order changes (used by display-order patch). */
export function registerToolCallOrderListener(listener: () => void): () => void {
	toolCallOrderListeners.add(listener);
	return () => {
		toolCallOrderListeners.delete(listener);
	};
}

function notifyToolCallOrderListeners(): void {
	for (const listener of toolCallOrderListeners) {
		try {
			listener();
		} catch {
			// ignore stale listeners
		}
	}
}

function toolCallOrderList(): string[] {
	const order = seq().toolCallOrder;
	if (Array.isArray(order)) return order;
	seq().toolCallOrder = [];
	return seq().toolCallOrder;
}

/** Record tool_call / execution order for chat row placement. */
export function recordToolCallOrder(toolCallId: string): void {
	if (!toolCallId) return;
	const order = toolCallOrderList();
	if (order.includes(toolCallId)) return;
	order.push(toolCallId);
	notifyToolCallOrderListeners();
}

export function getToolCallDisplayIndex(toolCallId: string): number | undefined {
	if (!toolCallId) return undefined;
	const idx = toolCallOrderList().indexOf(toolCallId);
	return idx >= 0 ? idx : undefined;
}

/** Call on each assistant message_start — resets per-message text tracking, keeps batch groups. */
export function beginAssistantMessage(): void {
	const s = seq();
	s.toolsInCurrentAssistantMessage = false;
	s.activeTextBlockFollowsToolsInMessage = null;
}

function notifyContentBreakListeners(): void {
	for (const listener of seq().contentBreakListeners) {
		try {
			listener();
		} catch {
			// ignore stale listeners
		}
	}
}

function markToolActivity(): void {
	const s = seq();
	s.toolsSinceLastBreak = true;
	s.toolsInCurrentAssistantMessage = true;
}

function hasVisibleText(text: string): boolean {
	return /\S/.test(text);
}

/** Breaks bash/read runs when visible assistant text appears between tools. */
export function recordContentBreak(): void {
	const s = seq();
	if (!s.toolsSinceLastBreak) return;
	s.lastCategory = "other";
	s.contentBreakSeq += 1;
	s.toolsSinceLastBreak = false;
	s.activeTextBlockFollowsToolsInMessage = null;
	notifyContentBreakListeners();
}

/** Arms visible-text detection; text_start alone must not break batches. */
export function recordTextStreamingStart(): void {
	seq().activeTextBlockFollowsToolsInMessage = seq().toolsInCurrentAssistantMessage;
}

/** Breaks only when non-whitespace text arrives after tools in the same assistant message. */
export function recordTextStreamingDelta(delta: string): void {
	const s = seq();
	if (!hasVisibleText(delta) || !s.toolsSinceLastBreak) return;
	if (s.activeTextBlockFollowsToolsInMessage !== true) return;
	s.activeTextBlockFollowsToolsInMessage = null;
	recordContentBreak();
}

/** Fallback when providers emit text_end without deltas; empty blocks do not break. */
export function recordTextStreamingEnd(content: string): void {
	const s = seq();
	const followsTools = s.activeTextBlockFollowsToolsInMessage;
	s.activeTextBlockFollowsToolsInMessage = null;
	if (followsTools !== true) return;
	if (!hasVisibleText(content) || !s.toolsSinceLastBreak) return;
	recordContentBreak();
}

/** Breaks bash/read runs; call for any tool that is not batched. */
export function recordOtherTool(): void {
	markToolActivity();
	const s = seq();
	s.lastCategory = "other";
	s.contentBreakSeq += 1;
	s.toolsSinceLastBreak = false;
	s.activeTextBlockFollowsToolsInMessage = null;
	notifyContentBreakListeners();
}

export function assignBashGroup(toolCallId: string): number {
	const s = seq();
	const existing = s.bashGroupByToolCall.get(toolCallId);
	if (existing !== undefined) {
		return existing;
	}
	const needNewGroup = s.lastCategory !== "bash" || s.activeBashBreakSeq !== s.contentBreakSeq;
	if (needNewGroup) {
		s.bashGroupSeq += 1;
		s.activeBashBreakSeq = s.contentBreakSeq;
	}
	s.lastCategory = "bash";
	markToolActivity();
	s.bashGroupByToolCall.set(toolCallId, s.bashGroupSeq);
	return s.bashGroupSeq;
}

export function assignReadGroup(toolCallId: string): number {
	const s = seq();
	const existing = s.readGroupByToolCall.get(toolCallId);
	if (existing !== undefined) {
		return existing;
	}
	const needNewGroup = s.lastCategory !== "read" || s.activeReadBreakSeq !== s.contentBreakSeq;
	if (needNewGroup) {
		s.readGroupSeq += 1;
		s.activeReadBreakSeq = s.contentBreakSeq;
	}
	s.lastCategory = "read";
	markToolActivity();
	s.readGroupByToolCall.set(toolCallId, s.readGroupSeq);
	return s.readGroupSeq;
}

export function getBashGroupId(toolCallId: string): number | undefined {
	return seq().bashGroupByToolCall.get(toolCallId);
}

export function getReadGroupId(toolCallId: string): number | undefined {
	return seq().readGroupByToolCall.get(toolCallId);
}
