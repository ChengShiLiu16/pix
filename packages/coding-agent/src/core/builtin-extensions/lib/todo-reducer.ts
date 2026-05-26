import { cloneState, type TodoItem, type TodoState } from "./todo-state.ts";

export type TodoAction = "add" | "start" | "done" | "remove" | "list";

export interface TodoMutationParams {
	text?: string;
	id?: number;
	activeForm?: string;
}

export type TodoOp =
	| { kind: "add"; id: number }
	| { kind: "start"; id: number }
	| { kind: "done"; id: number; clearedAll: boolean; clearedCount?: number }
	| { kind: "remove"; id: number }
	| { kind: "list" }
	| { kind: "error"; message: string };

export interface ApplyResult {
	state: TodoState;
	op: TodoOp;
}

function errorResult(state: TodoState, message: string): ApplyResult {
	return { state, op: { kind: "error", message } };
}

function demoteOtherInProgress(todos: TodoItem[], exceptId: number): TodoItem[] {
	return todos.map((t) =>
		t.id !== exceptId && t.status === "in_progress" ? { ...t, status: "pending" as const } : t,
	);
}

/** Pure reducer for todo_manage mutations. */
export function applyMutation(state: TodoState, action: TodoAction, params: TodoMutationParams): ApplyResult {
	switch (action) {
		case "add": {
			if (!params.text?.trim()) {
				return errorResult(state, "错误：add 操作需要 text 参数");
			}
			const id = state.nextId;
			const item: TodoItem = { id, text: params.text, status: "pending" };
			if (params.activeForm) item.activeForm = params.activeForm;
			return {
				state: {
					todos: [...state.todos, item],
					nextId: state.nextId + 1,
				},
				op: { kind: "add", id },
			};
		}
		case "start": {
			if (params.id === undefined) {
				return errorResult(state, "错误：start 操作需要 id 参数");
			}
			const item = state.todos.find((t) => t.id === params.id);
			if (!item) {
				return errorResult(state, `错误：找不到 #${params.id}`);
			}
			if (item.status === "completed") {
				return errorResult(state, `错误：#${params.id} 已完成，无法 start`);
			}
			let todos = demoteOtherInProgress(state.todos, params.id);
			todos = todos.map((t) => {
				if (t.id !== params.id) return t;
				const updated: TodoItem = { ...t, status: "in_progress" };
				if (params.activeForm !== undefined) {
					if (params.activeForm) updated.activeForm = params.activeForm;
					else delete updated.activeForm;
				}
				return updated;
			});
			return {
				state: { todos, nextId: state.nextId },
				op: { kind: "start", id: params.id },
			};
		}
		case "done": {
			if (params.id === undefined) {
				return errorResult(state, "错误：done 操作需要 id 参数");
			}
			const item = state.todos.find((t) => t.id === params.id);
			if (!item) {
				return errorResult(state, `错误：找不到 #${params.id}`);
			}
			const todos = state.todos.map((t) => (t.id === params.id ? { ...t, status: "completed" as const } : t));
			if (todos.every((t) => t.status === "completed")) {
				const count = todos.length;
				return {
					state: { todos: [], nextId: 1 },
					op: { kind: "done", id: params.id, clearedAll: true, clearedCount: count },
				};
			}
			return {
				state: { todos, nextId: state.nextId },
				op: { kind: "done", id: params.id, clearedAll: false },
			};
		}
		case "remove": {
			if (params.id === undefined) {
				return errorResult(state, "错误：remove 操作需要 id 参数");
			}
			const before = state.todos.length;
			const todos = state.todos.filter((t) => t.id !== params.id);
			if (todos.length === before) {
				return errorResult(state, `错误：找不到 #${params.id}`);
			}
			return {
				state: { todos, nextId: state.nextId },
				op: { kind: "remove", id: params.id },
			};
		}
		case "list": {
			return { state: cloneState(state), op: { kind: "list" } };
		}
	}
}

export function commitState(current: TodoState, result: ApplyResult): TodoState {
	return result.op.kind === "error" ? current : result.state;
}
