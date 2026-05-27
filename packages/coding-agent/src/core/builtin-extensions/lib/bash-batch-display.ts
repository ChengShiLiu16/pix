/**
 * Consecutive bash aggregation for compact tool UI.
 *
 * Group assignment happens ONLY via recordBashToolCall (activity-widget tool_call).
 * renderCall is read-only for grouping; updateDisplay patch renders aggregated batches.
 */
import { Text } from "@earendil-works/pix-tui";
import {
	bindCategoryContentBreak,
	registerBatchInvalidator,
	resetBatchSettleStore,
	scheduleSettleNotify,
} from "./batch-display-core.ts";
import { type BashBatchEntry, getBatchGlobalStore } from "./batch-global-store.ts";
import { formatTreeCall, type ThemeLike } from "./format-tree-call.ts";
import { assignBashGroup, getBashGroupId, registerContentBreakListener } from "./tool-batch-sequence.ts";

export type { BashBatchEntry };

export type BashFileMutationPreview = {
	kind: "Append" | "Write";
	path: string;
	content: string;
};

export const BASH_HEADER = "Bash";

export function bashHeaderLabel(count?: number): string {
	return count && count > 1 ? `${BASH_HEADER} (${count})` : BASH_HEADER;
}

export const EMPTY_BASH_TEXT = new Text("", 0, 0);

function bash() {
	return getBatchGlobalStore().bash;
}

function getGroupEntries(toolCallId: string): BashBatchEntry[] {
	const groupId = getBashGroupId(toolCallId);
	if (groupId === undefined) return [];
	return bash().bashGroups.get(groupId) ?? [];
}

function serializeGroupSnapshot(group: BashBatchEntry[]): string {
	return group.map((e) => `${e.toolCallId}:${e.command}`).join("|");
}

function removeBashEntryFromOtherGroups(toolCallId: string, targetGroupId: number): void {
	for (const [groupId, group] of bash().bashGroups) {
		if (groupId === targetGroupId) continue;
		const idx = group.findIndex((e) => e.toolCallId === toolCallId);
		if (idx >= 0) group.splice(idx, 1);
	}
}

function purgeOrphanBashEntries(): Set<number> {
	const affected = new Set<number>();
	for (const [groupId, group] of bash().bashGroups) {
		const before = group.length;
		for (let i = group.length - 1; i >= 0; i--) {
			const entry = group[i]!;
			if (getBashGroupId(entry.toolCallId) !== groupId) {
				group.splice(i, 1);
			}
		}
		if (group.length < before) {
			affected.add(groupId);
		}
		if (group.length === 0) {
			bash().bashGroups.delete(groupId);
		}
	}
	return affected;
}

function ensureBashSlot(toolCallId: string): { groupId: number; group: BashBatchEntry[] } {
	const groupId = assignBashGroup(toolCallId);
	removeBashEntryFromOtherGroups(toolCallId, groupId);
	let group = bash().bashGroups.get(groupId);
	if (!group) {
		group = [];
		bash().bashGroups.set(groupId, group);
	}
	if (!group.some((e) => e.toolCallId === toolCallId)) {
		group.push({ toolCallId, command: "" });
	}
	return { groupId, group };
}

function groupHasVisibleCommand(group: BashBatchEntry[]): boolean {
	return group.some((e) => Boolean(e.command));
}

function scheduleBashSettleNotify(groupId: number, group: BashBatchEntry[]): void {
	scheduleSettleNotify(bash(), groupId, group, serializeGroupSnapshot(group), {
		hasVisibleContent: groupHasVisibleCommand,
		isGroupValid: () => {
			const current = bash().bashGroups.get(groupId);
			return Boolean(current && current.length > 0);
		},
	});
}

export function resetBashBatch(): void {
	const b = bash();
	b.bashGroups.clear();
	b.recordedToolCallIds.clear();
	resetBatchSettleStore(b);
}

export function registerBashInvalidator(toolCallId: string, invalidate: () => void): void {
	registerBatchInvalidator(bash(), toolCallId, getBashGroupId(toolCallId), invalidate);
}

export function getBashBatch(toolCallId: string): readonly BashBatchEntry[] {
	return getGroupEntries(toolCallId);
}

/** True when two or more bash calls share a consecutive group. */
export function isBashBatchAggregated(toolCallId: string): boolean {
	return getGroupEntries(toolCallId).length > 1;
}

/** Assigned to a consecutive bash group (including while the first call is still settling). */
export function isInBashBatch(toolCallId: string): boolean {
	return getBashGroupId(toolCallId) !== undefined && getGroupEntries(toolCallId).length > 0;
}

/** Anchor = first recorded tool call in the group (sole visible bash block). */
export function getBashAnchorToolCallId(toolCallId: string): string | undefined {
	const group = getGroupEntries(toolCallId);
	if (group.length === 0) return undefined;
	return group[0]!.toolCallId;
}

export function isBashAnchor(toolCallId: string): boolean {
	return getBashAnchorToolCallId(toolCallId) === toolCallId;
}

export function isFirstBashInBatch(toolCallId: string): boolean {
	return isBashAnchor(toolCallId);
}

function unquoteShellToken(token: string): string {
	const trimmed = token.trim();
	if (trimmed.length < 2) return trimmed;
	const quote = trimmed[0];
	if ((quote === "'" || quote === '"') && trimmed[trimmed.length - 1] === quote) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

export function getBashFileMutationPreview(command: unknown): BashFileMutationPreview | undefined {
	if (typeof command !== "string") return undefined;

	const lines = command.split(/\r?\n/);
	const header = lines[0]?.trim() ?? "";
	const match = header.match(/^cat\s+(>>|>)\s+(.+?)\s+<<\s*(['"]?)([A-Za-z0-9_.:-]+)\3\s*$/);
	if (!match) return undefined;

	const [, operator, rawPath, , delimiter] = match;
	const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === delimiter);
	if (endIndex < 0) return undefined;

	return {
		kind: operator === ">>" ? "Append" : "Write",
		path: unquoteShellToken(rawPath),
		content: lines.slice(1, endIndex).join("\n"),
	};
}

/** cat >>/ > file <<EOF — rendered as Write/Append, not batched bash. */
export function isBashFileMutationCommand(command: unknown): boolean {
	return getBashFileMutationPreview(command) !== undefined;
}

export function recordBashToolCall(toolCallId: string, command: string): void {
	if (isBashFileMutationCommand(command)) return;

	const { groupId, group } = ensureBashSlot(toolCallId);
	const entry = group.find((e) => e.toolCallId === toolCallId)!;
	const hadCommand = Boolean(entry.command);
	if (command && entry.command !== command) {
		entry.command = command;
	}

	if (!bash().recordedToolCallIds.has(toolCallId)) {
		bash().recordedToolCallIds.add(toolCallId);
		if (!command && !hadCommand) {
			scheduleBashSettleNotify(groupId, group);
			return;
		}
	}

	if (command) {
		scheduleBashSettleNotify(groupId, group);
	}
}

function truncateOneLine(text: string, maxLen = 120): string {
	const oneLine = text.split(/\r?\n/)[0] || text;
	if (oneLine.length <= maxLen) return oneLine;
	return `${oneLine.slice(0, maxLen - 1)}…`;
}

export function formatBashCommandForDisplay(command: string, _theme: ThemeLike): string {
	return truncateOneLine(command);
}

function formatBashDetailLine(command: string, theme: ThemeLike): string {
	return formatBashCommandForDisplay(command, theme);
}

/** True when the batch has at least one command worth showing. */
export function bashBatchHasContent(toolCallId: string): boolean {
	return groupHasVisibleCommand(getGroupEntries(toolCallId));
}

export type BashVisibilityContext = {
	command?: string;
	argsComplete?: boolean;
};

/** Batch store command, or args.command once argsComplete (tool_call may arrive empty). */
export function bashHasVisibleCommand(toolCallId: string, context: BashVisibilityContext = {}): boolean {
	if (bashBatchHasContent(toolCallId)) return true;
	if (!context.argsComplete) return false;
	return typeof context.command === "string" && context.command.length > 0;
}

/** Hide the tool row until solo or aggregated bash content is ready (avoids empty slots). */
export function bashCallShouldHideUntilReady(toolCallId: string, context: BashVisibilityContext = {}): boolean {
	if (!isInBashBatch(toolCallId)) return false;
	const hasContent = bashHasVisibleCommand(toolCallId, context);
	if (isBashBatchAggregated(toolCallId)) {
		return !isBashAnchor(toolCallId) || !hasContent;
	}
	return !hasContent;
}

export function formatAggregatedBashCall(theme: ThemeLike, toolCallId: string): Text {
	const batch = getGroupEntries(toolCallId);
	const items = batch.filter((e) => Boolean(e.command)).map((e) => formatBashDetailLine(e.command, theme));
	if (items.length === 0) return EMPTY_BASH_TEXT;
	return formatTreeCall(theme, bashHeaderLabel(batch.length), items);
}

export function formatBashCallWithBatch(
	args: { command?: string },
	theme: ThemeLike,
	toolCallId?: string,
	invalidate?: () => void,
	argsComplete = false,
): Text {
	if (toolCallId && invalidate) {
		registerBashInvalidator(toolCallId, invalidate);
	}

	const command = typeof args?.command === "string" ? args.command : "";

	// Batch rendering: always return EMPTY for batch bash (including solo anchors).
	// updateDisplay (buildFallbackCall) paints content and stays fresh when the
	// batch grows — same pattern as read. renderCall progressive display caused
	// empty Box rows while argsComplete was still false.
	if (toolCallId && isInBashBatch(toolCallId)) {
		return EMPTY_BASH_TEXT;
	}

	// Standalone rendering: only show when argsComplete and command is present.
	if (!command || !argsComplete) {
		return EMPTY_BASH_TEXT;
	}
	return formatTreeCall(theme, BASH_HEADER, [formatBashDetailLine(command, theme)]);
}

bindCategoryContentBreak(registerContentBreakListener, bash(), purgeOrphanBashEntries);
