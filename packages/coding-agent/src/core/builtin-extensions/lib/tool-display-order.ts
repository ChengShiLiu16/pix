/**
 * Preserve chat tool row order by tool_call / execution sequence.
 *
 * Pi inserts ToolExecutionComponents in assistant message.content order during
 * streaming, which can differ from beforeToolCall (tool_call event) order when
 * heterogeneous tools run back-to-back — e.g. ls_many executes before read_many
 * but read appears first in content. Batch read rows also hide until ready, so
 * the mismatch only becomes visible once read un-hides above an already-visible ls.
 */
import { getToolCallDisplayIndex } from "./tool-batch-sequence.ts";

export type ToolExecutionLike = {
	toolCallId: string;
};

export type ToolOrderContainer = {
	children: unknown[];
};

export function isKnownToolExecutionComponent(child: unknown): child is ToolExecutionLike {
	return (
		typeof child === "object" &&
		child !== null &&
		"toolCallId" in child &&
		typeof (child as ToolExecutionLike).toolCallId === "string"
	);
}

/** Compare two tool rows; unknown-order rows keep stable DOM index. */
export function compareToolDisplayOrder(
	a: ToolExecutionLike,
	aDomIndex: number,
	b: ToolExecutionLike,
	bDomIndex: number,
): number {
	const orderA = getToolCallDisplayIndex(a.toolCallId);
	const orderB = getToolCallDisplayIndex(b.toolCallId);
	if (orderA !== undefined && orderB !== undefined) return orderA - orderB;
	if (orderA !== undefined) return -1;
	if (orderB !== undefined) return 1;
	return aDomIndex - bDomIndex;
}

function containerChildren(container: ToolOrderContainer): unknown[] {
	if (Array.isArray(container.children)) return container.children;
	container.children = [];
	return container.children;
}

export function findToolInsertIndex(container: ToolOrderContainer, newTool: ToolExecutionLike): number {
	const children = containerChildren(container);
	const newOrder = getToolCallDisplayIndex(newTool.toolCallId);
	if (newOrder === undefined) {
		return children.length;
	}

	for (let i = 0; i < children.length; i++) {
		const child = children[i];
		if (!isKnownToolExecutionComponent(child)) continue;
		const childOrder = getToolCallDisplayIndex(child.toolCallId);
		if (childOrder !== undefined && childOrder > newOrder) {
			return i;
		}
	}

	return children.length;
}

/** Consecutive ToolExecutionComponent run containing `instance`, if any. */
export function findToolExecutionSiblingGroup(
	container: ToolOrderContainer,
	instance: ToolExecutionLike,
): { start: number; end: number } | undefined {
	const children = containerChildren(container);
	const idx = children.indexOf(instance);
	if (idx < 0 || !isKnownToolExecutionComponent(instance)) return undefined;

	let start = idx;
	let end = idx;
	while (start > 0 && isKnownToolExecutionComponent(children[start - 1])) {
		start -= 1;
	}
	while (end + 1 < children.length && isKnownToolExecutionComponent(children[end + 1])) {
		end += 1;
	}
	return { start, end };
}

/** Reorder only the consecutive tool row group containing `instance`. */
export function reorderToolExecutionSiblingGroup(container: ToolOrderContainer, instance: ToolExecutionLike): boolean {
	const group = findToolExecutionSiblingGroup(container, instance);
	if (!group || group.end <= group.start) return false;

	const children = containerChildren(container);
	const slice = children.slice(group.start, group.end + 1);
	const subContainer: ToolOrderContainer = { children: [...slice] };
	const changed = reorderToolExecutionSiblings(subContainer);
	if (!changed) return false;

	children.splice(group.start, slice.length, ...subContainer.children);
	return true;
}

/** Reorder consecutive ToolExecutionComponent siblings in one container. Returns true when changed. */
export function reorderToolExecutionSiblings(container: ToolOrderContainer): boolean {
	const children = containerChildren(container);
	const toolEntries: { index: number; comp: ToolExecutionLike }[] = [];
	for (let i = 0; i < children.length; i++) {
		const child = children[i];
		if (isKnownToolExecutionComponent(child)) {
			toolEntries.push({ index: i, comp: child });
		}
	}
	if (toolEntries.length < 2) return false;

	const sorted = [...toolEntries].sort((a, b) => compareToolDisplayOrder(a.comp, a.index, b.comp, b.index));

	const alreadySorted = sorted.every((entry, i) => entry.comp === toolEntries[i]!.comp);
	if (alreadySorted) return false;

	for (let i = toolEntries.length - 1; i >= 0; i--) {
		children.splice(toolEntries[i]!.index, 1);
	}

	const insertAt = toolEntries[0]!.index;
	for (let i = 0; i < sorted.length; i++) {
		children.splice(insertAt + i, 0, sorted[i]!.comp);
	}
	return true;
}
