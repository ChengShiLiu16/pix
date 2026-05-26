import { cloneState, EMPTY_TODO_STATE, isTodoDetails, migrateLegacyState, type TodoState } from "./todo-state.ts";

type BranchEntry = {
	type?: string;
	customType?: string;
	data?: unknown;
	message?: {
		role?: string;
		toolName?: string;
		details?: unknown;
	};
};

type ReplayContext = {
	sessionManager: { getBranch(): Iterable<BranchEntry> };
};

/**
 * Scan branch for the last todo_manage toolResult with valid details (last-write-wins).
 */
function replayFromToolResults(branch: Iterable<BranchEntry>): TodoState | undefined {
	let result: TodoState | undefined;
	for (const entry of branch) {
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (!msg || msg.role !== "toolResult" || msg.toolName !== "todo_manage") continue;
		if (!isTodoDetails(msg.details)) continue;
		result = migrateLegacyState(
			msg.details as { todos: Parameters<typeof migrateLegacyState>[0]["todos"]; nextId: number },
		);
	}
	return result;
}

/**
 * Fallback: last custom todo-state entry from appendEntry dual-write.
 */
function replayFromCustomEntries(branch: Iterable<BranchEntry>): TodoState | undefined {
	let result: TodoState | undefined;
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== "todo-state") continue;
		const data = entry.data as { todos?: unknown[]; nextId?: number } | undefined;
		if (!data || !Array.isArray(data.todos) || typeof data.nextId !== "number") continue;
		result = migrateLegacyState(data as Parameters<typeof migrateLegacyState>[0]);
	}
	return result;
}

/** Dual-track replay: toolResult details first, appendEntry fallback, else empty. */
export function replayTodoFromBranch(ctx: ReplayContext): TodoState {
	const branch = Array.from(ctx.sessionManager.getBranch());
	const fromTool = replayFromToolResults(branch);
	if (fromTool) return cloneState(fromTool);
	const fromCustom = replayFromCustomEntries(branch);
	if (fromCustom) return cloneState(fromCustom);
	return cloneState(EMPTY_TODO_STATE);
}
