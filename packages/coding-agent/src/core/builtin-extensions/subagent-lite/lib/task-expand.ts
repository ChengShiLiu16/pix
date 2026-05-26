/** Per task-tool-call expand state (Pi's Ctrl+O is global — not used here). */

const expandedByToolCallId = new Map<string, boolean>();
const toolCallIdByWorkerId = new Map<string, string>();
let lastWorkerToolCallId: string | undefined;

export function clearWorkerExpandState(): void {
	expandedByToolCallId.clear();
	toolCallIdByWorkerId.clear();
	lastWorkerToolCallId = undefined;
}

export function registerWorkerToolCall(workerId: string, toolCallId: string): void {
	toolCallIdByWorkerId.set(workerId, toolCallId);
	lastWorkerToolCallId = toolCallId;
}

export function isWorkerExpanded(toolCallId: string): boolean {
	return expandedByToolCallId.get(toolCallId) ?? false;
}

export function toggleWorkerExpand(toolCallId: string): boolean {
	const next = !isWorkerExpanded(toolCallId);
	expandedByToolCallId.set(toolCallId, next);
	return next;
}

/** Match worker id by exact or prefix (e.g. `abc` → `abc12345`). */
export function resolveWorkerToolCallId(workerId?: string): string | undefined {
	if (workerId) {
		if (toolCallIdByWorkerId.has(workerId)) return toolCallIdByWorkerId.get(workerId);
		for (const [id, toolCallId] of toolCallIdByWorkerId) {
			if (id.startsWith(workerId)) return toolCallId;
		}
		return undefined;
	}
	return lastWorkerToolCallId;
}

export function listWorkerIds(): string[] {
	return [...toolCallIdByWorkerId.keys()];
}
