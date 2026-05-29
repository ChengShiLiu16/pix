import { describe, expect, it } from "vitest";
import { TodoOverlay } from "../src/core/builtin-extensions/lib/todo-overlay.ts";
import { applyMutation } from "../src/core/builtin-extensions/lib/todo-reducer.ts";
import { replayTodoFromBranch } from "../src/core/builtin-extensions/lib/todo-replay.ts";
import {
	EMPTY_TODO_STATE,
	isTodoDetails,
	MAX_TODOS,
	type TodoItem,
} from "../src/core/builtin-extensions/lib/todo-state.ts";
import { builtin as todoTrackerBuiltin } from "../src/core/builtin-extensions/todo-tracker.ts";

function makeToolEntry(todos: TodoItem[], nextId: number) {
	return {
		type: "message",
		message: {
			role: "toolResult",
			toolName: "todo_manage",
			details: { todos, nextId },
		},
	};
}

function makeCustomEntry(todos: TodoItem[], nextId: number) {
	return {
		type: "custom",
		customType: "todo-state",
		data: { todos, nextId },
	};
}

describe("todo reducer", () => {
	it("keeps completed todos until the next user prompt cleanup", () => {
		const first = applyMutation(EMPTY_TODO_STATE, "add", { text: " first task " });
		const second = applyMutation(first.state, "add", { text: "second task" });
		const doneFirst = applyMutation(second.state, "done", { id: 1 });
		const doneSecond = applyMutation(doneFirst.state, "done", { id: 2 });

		expect(doneFirst.state.todos.map((t) => t.status)).toEqual(["completed", "pending"]);
		expect(doneSecond.op).toEqual({ kind: "done", id: 2, clearedAll: true });
		expect(doneSecond.state.todos.map((t) => t.status)).toEqual(["completed", "completed"]);
		expect(doneSecond.state.nextId).toBe(3);
	});

	it("normalizes text and rejects oversized inputs", () => {
		const added = applyMutation(EMPTY_TODO_STATE, "add", { text: "  one\n two\tthree  " });
		expect(added.state.todos[0]?.text).toBe("one two three");

		const longText = "x".repeat(201);
		expect(applyMutation(EMPTY_TODO_STATE, "add", { text: longText }).op.kind).toBe("error");

		const fullState = {
			todos: Array.from({ length: MAX_TODOS }, (_, index) => ({
				id: index + 1,
				text: `task ${index + 1}`,
				status: "pending" as const,
			})),
			nextId: MAX_TODOS + 1,
		};
		expect(applyMutation(fullState, "add", { text: "overflow" }).op.kind).toBe("error");
	});
});

describe("todo state validation and replay", () => {
	it("validates persisted todo details strictly", () => {
		expect(isTodoDetails({ todos: [{ id: 1, text: "task", status: "pending" }], nextId: 2 })).toBe(true);
		expect(isTodoDetails({ todos: [{ id: 1, text: "legacy", done: true }], nextId: 2 })).toBe(true);
		expect(isTodoDetails({ todos: [{ id: 1, text: "task", status: "bad" }], nextId: 2 })).toBe(false);
		expect(isTodoDetails({ todos: [{ id: 1, text: "", status: "pending" }], nextId: 2 })).toBe(false);
		expect(isTodoDetails({ todos: [{ id: 1.5, text: "task", status: "pending" }], nextId: 2 })).toBe(false);
		expect(isTodoDetails({ todos: [{ id: 1, text: "task", status: "pending" }], nextId: 0 })).toBe(false);
	});

	it("uses the latest valid state across tool results and custom entries", () => {
		const oldTask: TodoItem = { id: 1, text: "old", status: "pending" };
		const branch = [makeToolEntry([oldTask], 2), makeCustomEntry([], 1)];

		const state = replayTodoFromBranch({ sessionManager: { getBranch: () => branch } });

		expect(state).toEqual(EMPTY_TODO_STATE);
	});
});

describe("todo overlay", () => {
	it("renders completed todos and removes the widget only for empty state", () => {
		let todos: TodoItem[] = [{ id: 1, text: "done task", status: "completed" }];
		const setCalls: Array<unknown> = [];
		const ui = {
			setWidget(_key: string, content: unknown) {
				setCalls.push(content);
			},
		};
		const overlay = new TodoOverlay(() => ({ todos, nextId: 2 }));

		overlay.setUICtx(ui as any);
		overlay.update();

		const factory = setCalls[0] as (tui: unknown, theme: unknown) => { render(width: number): string[] };
		const component = factory(
			{ requestRender() {} },
			{
				fg: (_color: string, text: string) => text,
				strikethrough: (text: string) => `~${text}~`,
			},
		);
		expect(component.render(80).join("\n")).toContain("done task");

		todos = [];
		overlay.update();
		expect(setCalls.at(-1)).toBeUndefined();
	});
});

describe("todo tracker lifecycle", () => {
	function createHarness() {
		const handlers = new Map<string, (event: any, ctx: any) => Promise<any>>();
		let tool: any;
		const entries: Array<{ customType: string; data: unknown }> = [];
		const pi = {
			on(event: string, handler: (event: any, ctx: any) => Promise<any>) {
				handlers.set(event, handler);
			},
			registerCommand() {},
			registerTool(definition: unknown) {
				tool = definition;
			},
			appendEntry(customType: string, data: unknown) {
				entries.push({ customType, data });
			},
		};
		const ctx = {
			hasUI: true,
			ui: {
				setWidget() {},
			},
			sessionManager: {
				getBranch: () => [],
			},
		};

		todoTrackerBuiltin(pi as any);
		return {
			handlers,
			get tool() {
				return tool;
			},
			entries,
			ctx,
		};
	}

	it("clears completed state on the next user prompt", async () => {
		const { handlers, tool, entries, ctx } = createHarness();
		await handlers.get("session_start")?.({ type: "session_start" }, ctx);
		await tool.execute("add", { action: "add", text: "task" }, undefined, undefined, ctx);
		await tool.execute("done", { action: "done", id: 1 }, undefined, undefined, ctx);
		await handlers.get("before_agent_start")?.({ type: "before_agent_start", prompt: "继续" }, ctx);

		expect(entries.at(-1)).toEqual({ customType: "todo-state", data: EMPTY_TODO_STATE });
	});

	it("clears add-only todos when an agent turn ends", async () => {
		const { handlers, tool, entries, ctx } = createHarness();
		await handlers.get("session_start")?.({ type: "session_start" }, ctx);
		await handlers.get("before_agent_start")?.({ type: "before_agent_start", prompt: "列出至少 10 个 todo" }, ctx);
		await tool.execute("add-1", { action: "add", text: "first" }, undefined, undefined, ctx);
		await tool.execute("add-2", { action: "add", text: "second" }, undefined, undefined, ctx);
		await handlers.get("agent_end")?.({ type: "agent_end", messages: [] }, ctx);

		expect(entries.at(-1)).toEqual({ customType: "todo-state", data: EMPTY_TODO_STATE });
	});

	it("preserves historical pending todos when clearing add-only todos", async () => {
		const { handlers, tool, entries, ctx } = createHarness();
		await handlers.get("session_start")?.({ type: "session_start" }, ctx);
		await tool.execute("historical", { action: "add", text: "historical" }, undefined, undefined, ctx);

		await handlers.get("before_agent_start")?.({ type: "before_agent_start", prompt: "列出至少 10 个 todo" }, ctx);
		await tool.execute("new", { action: "add", text: "new task" }, undefined, undefined, ctx);
		await handlers.get("agent_end")?.({ type: "agent_end", messages: [] }, ctx);

		expect(entries.at(-1)).toEqual({
			customType: "todo-state",
			data: { todos: [{ id: 1, text: "historical", status: "pending" }], nextId: 3 },
		});
	});

	it("keeps todos when the same agent turn starts work", async () => {
		const { handlers, tool, entries, ctx } = createHarness();
		await handlers.get("session_start")?.({ type: "session_start" }, ctx);
		await handlers.get("before_agent_start")?.({ type: "before_agent_start", prompt: "实现功能" }, ctx);
		await tool.execute("add", { action: "add", text: "task" }, undefined, undefined, ctx);
		await tool.execute("start", { action: "start", id: 1 }, undefined, undefined, ctx);
		await handlers.get("agent_end")?.({ type: "agent_end", messages: [] }, ctx);

		expect(entries.at(-1)).toEqual({
			customType: "todo-state",
			data: { todos: [{ id: 1, text: "task", status: "in_progress" }], nextId: 2 },
		});
	});
});
