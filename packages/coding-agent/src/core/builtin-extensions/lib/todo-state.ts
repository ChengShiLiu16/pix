export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
	id: number;
	text: string;
	status: TodoStatus;
	activeForm?: string;
}

export interface TodoState {
	todos: TodoItem[];
	nextId: number;
}

export interface TodoDetails {
	todos: TodoItem[];
	nextId: number;
}

/** Legacy shape before rpiv-port (done: boolean). */
type LegacyTodoItem = {
	id: number;
	text: string;
	done?: boolean;
	status?: TodoStatus;
	activeForm?: string;
};

export const EMPTY_TODO_STATE: TodoState = { todos: [], nextId: 1 };

export function isTodoDetails(value: unknown): value is TodoDetails {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return Array.isArray(v.todos) && typeof v.nextId === "number";
}

export function migrateLegacyTodo(raw: LegacyTodoItem): TodoItem {
	if (raw.status === "pending" || raw.status === "in_progress" || raw.status === "completed") {
		return {
			id: raw.id,
			text: raw.text,
			status: raw.status,
			...(raw.activeForm ? { activeForm: raw.activeForm } : {}),
		};
	}
	return {
		id: raw.id,
		text: raw.text,
		status: raw.done ? "completed" : "pending",
		...(raw.activeForm ? { activeForm: raw.activeForm } : {}),
	};
}

export function migrateLegacyState(raw: { todos: LegacyTodoItem[]; nextId: number }): TodoState {
	return {
		todos: raw.todos.map(migrateLegacyTodo),
		nextId: raw.nextId,
	};
}

export function cloneState(state: TodoState): TodoState {
	return {
		todos: state.todos.map((t) => ({ ...t })),
		nextId: state.nextId,
	};
}

export function hasOpenTodos(state: TodoState): boolean {
	return state.todos.some((t) => t.status === "pending" || t.status === "in_progress");
}

export function countByStatus(state: TodoState): {
	pending: number;
	in_progress: number;
	completed: number;
	total: number;
} {
	let pending = 0;
	let in_progress = 0;
	let completed = 0;
	for (const t of state.todos) {
		if (t.status === "pending") pending++;
		else if (t.status === "in_progress") in_progress++;
		else if (t.status === "completed") completed++;
	}
	return { pending, in_progress, completed, total: state.todos.length };
}
