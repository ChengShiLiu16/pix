import {
	cloneState,
	MAX_ACTIVE_FORM_LENGTH,
	MAX_TODO_TEXT_LENGTH,
	MAX_TODOS,
	type TodoItem,
	type TodoState,
} from "./todo-state.ts";

export type TodoAction = "add" | "start" | "done" | "remove" | "list";

export interface TodoMutationParams {
	text?: string;
	id?: number;
	activeForm?: string;
}

export type TodoOp =
	| { kind: "add"; id: number }
	| { kind: "start"; id: number }
	| { kind: "done"; id: number; clearedAll: boolean }
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

function normalizeSingleLine(value: string): string {
	return value.replace(/\s+/gu, " ").trim();
}

/**
 * Normalize text for dedup comparison: lowercase and collapse whitespace.
 */
function normalizeForDedup(text: string): string {
	return text
		.replace(/[\s\u3000]+/gu, " ")
		.trim()
		.toLowerCase();
}

/**
 * Check if two todo texts are identical after whitespace normalization.
 */
function isDuplicateText(a: string, b: string): boolean {
	return normalizeForDedup(a) === normalizeForDedup(b);
}

/** Pure reducer for todo_manage mutations. */
export function applyMutation(state: TodoState, action: TodoAction, params: TodoMutationParams): ApplyResult {
	switch (action) {
		case "add": {
			const text = typeof params.text === "string" ? normalizeSingleLine(params.text) : "";
			if (!text) {
				return errorResult(state, "错误：add 操作需要 text 参数");
			}
			if (text.length > MAX_TODO_TEXT_LENGTH) {
				return errorResult(state, `错误：任务描述不能超过 ${MAX_TODO_TEXT_LENGTH} 个字符`);
			}
			// Dedup: reject if a pending/in_progress todo has similar text
			const duplicate = state.todos.find((t) => t.status !== "completed" && isDuplicateText(t.text, text));
			if (duplicate) {
				return errorResult(state, `已存在相似任务 #${duplicate.id}: ${duplicate.text}`);
			}
			if (state.todos.length >= MAX_TODOS) {
				return errorResult(state, `错误：todo 数量不能超过 ${MAX_TODOS} 条`);
			}
			const id = state.nextId;
			const item: TodoItem = { id, text, status: "pending" };
			if (params.activeForm) {
				const activeForm = normalizeSingleLine(params.activeForm);
				if (activeForm.length > MAX_ACTIVE_FORM_LENGTH) {
					return errorResult(state, `错误：进行中描述不能超过 ${MAX_ACTIVE_FORM_LENGTH} 个字符`);
				}
				if (activeForm) item.activeForm = activeForm;
			}
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
			const activeForm = params.activeForm === undefined ? undefined : normalizeSingleLine(params.activeForm);
			if (activeForm !== undefined && activeForm.length > MAX_ACTIVE_FORM_LENGTH) {
				return errorResult(state, `错误：进行中描述不能超过 ${MAX_ACTIVE_FORM_LENGTH} 个字符`);
			}
			let todos = demoteOtherInProgress(state.todos, params.id);
			todos = todos.map((t) => {
				if (t.id !== params.id) return t;
				const updated: TodoItem = { ...t, status: "in_progress" };
				if (activeForm !== undefined) {
					if (activeForm) updated.activeForm = activeForm;
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
			return {
				state: { todos, nextId: state.nextId },
				op: { kind: "done", id: params.id, clearedAll: todos.every((t) => t.status === "completed") },
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
