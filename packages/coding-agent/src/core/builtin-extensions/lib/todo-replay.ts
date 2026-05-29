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

function readTodoState(entry: BranchEntry): TodoState | undefined {
	if (entry.type === "message") {
		const msg = entry.message;
		if (!msg || msg.role !== "toolResult" || msg.toolName !== "todo_manage") return undefined;
		if (!isTodoDetails(msg.details)) return undefined;
		return migrateLegacyState(msg.details);
	}
	if (entry.type === "custom" && entry.customType === "todo-state" && isTodoDetails(entry.data)) {
		return migrateLegacyState(entry.data);
	}
	return undefined;
}

/** Replay todo state from branch with last valid state winning across both persistence tracks. */
export function replayTodoFromBranch(ctx: ReplayContext): TodoState {
	let result: TodoState | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		result = readTodoState(entry) ?? result;
	}
	return cloneState(result ?? EMPTY_TODO_STATE);
}
