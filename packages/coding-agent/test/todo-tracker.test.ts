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

describe("todo reducer dedup", () => {
	it("rejects exact duplicate text for pending/in_progress todos", () => {
		const added = applyMutation(EMPTY_TODO_STATE, "add", { text: "移除 isScoped 残留字段" });
		const dup = applyMutation(added.state, "add", { text: "移除 isScoped 残留字段" });
		expect(dup.op.kind).toBe("error");
		if (dup.op.kind === "error") expect(dup.op.message).toContain("#1");
	});

	it("rejects duplicate differing only in whitespace", () => {
		const added = applyMutation(EMPTY_TODO_STATE, "add", { text: "移除 isScoped  残留字段" });
		const dup = applyMutation(added.state, "add", { text: "移除 isScoped 残留字段" });
		expect(dup.op.kind).toBe("error");
	});

	it("allows duplicate text for completed todos", () => {
		const added = applyMutation(EMPTY_TODO_STATE, "add", { text: "移除 isScoped 残留字段" });
		const done = applyMutation(added.state, "done", { id: 1 });
		const reAdd = applyMutation(done.state, "add", { text: "移除 isScoped 残留字段" });
		expect(reAdd.op.kind).toBe("add");
	});

	it("rejects in_progress duplicate", () => {
		const added = applyMutation(EMPTY_TODO_STATE, "add", { text: "移除 isScoped 残留字段" });
		const started = applyMutation(added.state, "start", { id: 1 });
		const dup = applyMutation(started.state, "add", { text: "移除 isScoped 残留字段" });
		expect(dup.op.kind).toBe("error");
	});

	it("allows rephrased tasks (model should avoid these via prompt guidance)", () => {
		const added = applyMutation(EMPTY_TODO_STATE, "add", { text: "清理 scoped models 残留 keybinding 定义" });
		const rephrased = applyMutation(added.state, "add", { text: "清理 scoped models 残留（keybindings + 文档）" });
		expect(rephrased.op.kind).toBe("add");
	});

	it("allows genuinely different tasks", () => {
		const added = applyMutation(EMPTY_TODO_STATE, "add", { text: "移除 isScoped 残留字段" });
		const diff = applyMutation(added.state, "add", { text: "添加新的 context 参数" });
		expect(diff.op.kind).toBe("add");
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

describe("todo tracker lifecycle (system-managed)", () => {
	function createHarness() {
		const handlers = new Map<string, (event: any, ctx: any) => Promise<any>>();
		const entries: Array<{ customType: string; data: unknown }> = [];
		const pi = {
			on(event: string, handler: (event: any, ctx: any) => Promise<any>) {
				handlers.set(event, handler);
			},
			registerCommand() {},
			registerTool() {},
			appendEntry(customType: string, data: unknown) {
				entries.push({ customType, data });
			},
		};
		const branch = [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "建议列表：\n1. 修复登录 bug\n2. 添加导出功能" }],
				},
			},
		];
		const ctx = {
			hasUI: true,
			ui: {
				setWidget() {},
				notify() {},
			},
			sessionManager: {
				getBranch: () => branch,
			},
		};

		todoTrackerBuiltin(pi as any);
		return { handlers, entries, ctx };
	}

	it("creates todos from numbered steps on agent start", async () => {
		const { handlers, entries, ctx } = createHarness();
		await handlers.get("session_start")?.({ type: "session_start" }, ctx);
		await handlers.get("before_agent_start")?.(
			{ type: "before_agent_start", prompt: "请完成：\n1. 修复登录 bug\n2. 添加导出功能\n3. 更新文档" },
			ctx,
		);

		const last = entries.at(-1);
		expect(last?.customType).toBe("todo-state");
		const todos = (last?.data as any).todos;
		expect(todos.map((t: any) => t.text)).toEqual(["修复登录 bug", "添加导出功能", "更新文档"]);
		expect(todos.every((t: any) => t.status === "pending")).toBe(true);
	});

	it("creates todos from enumerated actions when the scorer misses but steps parse", async () => {
		const { handlers, entries, ctx } = createHarness();
		await handlers.get("session_start")?.({ type: "session_start" }, ctx);
		await handlers.get("before_agent_start")?.(
			{ type: "before_agent_start", prompt: "帮我看看 A：重构核心模块、补充单元测试、提交代码" },
			ctx,
		);

		const todos = (entries.at(-1)?.data as any).todos;
		expect(todos.map((t: any) => t.text)).toEqual(["重构核心模块", "补充单元测试", "提交代码"]);
	});

	it("does not create todos for a simple prompt", async () => {
		const { handlers, entries, ctx } = createHarness();
		await handlers.get("session_start")?.({ type: "session_start" }, ctx);
		await handlers.get("before_agent_start")?.({ type: "before_agent_start", prompt: "你好" }, ctx);

		expect(entries.at(-1)).toBeUndefined();
	});

	it("creates todos from suggestions in the last assistant message when the prompt references them", async () => {
		const { handlers, entries, ctx } = createHarness();
		await handlers.get("session_start")?.({ type: "session_start" }, ctx);
		// 上一轮模型给出建议列表
		await handlers.get("message_end")?.(
			{
				type: "message_end",
				message: {
					role: "assistant",
					content: [
						{
							type: "text",
							text: "建议按以下顺序调整：\n- 重构核心模块接口\n- 补充单元测试\n- 更新文档",
						},
					],
				},
			},
			ctx,
		);
		await handlers.get("before_agent_start")?.({ type: "before_agent_start", prompt: "按建议调整进行修改" }, ctx);

		const todos = (entries.at(-1)?.data as any).todos;
		expect(todos.map((t: any) => t.text)).toEqual(["重构核心模块接口", "补充单元测试", "更新文档"]);
	});

	it("does not create todos from history for confirmation-only prompts", async () => {
		const { handlers, entries, ctx } = createHarness();
		await handlers.get("session_start")?.({ type: "session_start" }, ctx);
		await handlers.get("message_end")?.(
			{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "- 方案一\n- 方案二\n- 方案三" }],
				},
			},
			ctx,
		);
		await handlers.get("before_agent_start")?.({ type: "before_agent_start", prompt: "好的" }, ctx);

		expect(entries.at(-1)).toBeUndefined();
	});

	it("restores the last assistant text from the branch on session start", async () => {
		const { handlers, entries, ctx } = createHarness();
		// session_start 的 branch 里带历史 assistant 建议（重启场景）
		await handlers.get("session_start")?.({ type: "session_start" }, ctx);
		await handlers.get("before_agent_start")?.({ type: "before_agent_start", prompt: "按照上面建议继续修改" }, ctx);

		const todos = (entries.at(-1)?.data as any).todos;
		expect(todos.map((t: any) => t.text)).toEqual(["修复登录 bug", "添加导出功能"]);
	});

	it("creates todos from the model's own plan list in its first message", async () => {
		const { handlers, entries, ctx } = createHarness();
		await handlers.get("session_start")?.({ type: "session_start" }, ctx);
		await handlers.get("before_agent_start")?.({ type: "before_agent_start", prompt: "修复这个 bug" }, ctx);
		expect(entries.at(-1)).toBeUndefined();

		// 模型首条消息列计划
		await handlers.get("message_end")?.(
			{
				type: "message_end",
				message: {
					role: "assistant",
					content: [
						{
							type: "text",
							text: "我按以下步骤修复：\n1. 定位问题代码\n2. 修复逻辑错误\n3. 运行测试验证",
						},
					],
				},
			},
			ctx,
		);

		const todos = (entries.at(-1)?.data as any).todos;
		expect(todos.map((t: any) => t.text)).toEqual(["定位问题代码", "修复逻辑错误", "运行测试验证"]);
	});

	it("does not treat analysis conclusion lists as todos", async () => {
		const { handlers, entries, ctx } = createHarness();
		await handlers.get("session_start")?.({ type: "session_start" }, ctx);
		await handlers.get("before_agent_start")?.({ type: "before_agent_start", prompt: "为什么慢" }, ctx);
		await handlers.get("message_end")?.(
			{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "原因有三：\n1. 缓存未命中\n2. 网络延迟\n3. 磁盘 IO" }],
				},
			},
			ctx,
		);

		expect(entries.at(-1)).toBeUndefined();
	});

	it("backfills a summary todo when the agent works without any list source", async () => {
		const { handlers, entries, ctx } = createHarness();
		await handlers.get("session_start")?.({ type: "session_start" }, ctx);
		await handlers.get("before_agent_start")?.({ type: "before_agent_start", prompt: "修复这个 bug" }, ctx);
		expect(entries.at(-1)).toBeUndefined();

		await handlers.get("tool_execution_end")?.({ type: "tool_execution_end", toolName: "read", isError: false }, ctx);

		const todos = (entries.at(-1)?.data as any).todos;
		expect(todos.length).toBe(1);
		expect(todos[0].text).toBe("修复这个 bug");
		expect(todos[0].status).toBe("pending");
	});

	it("completes auto-created todos when real tools ran", async () => {
		const { handlers, entries, ctx } = createHarness();
		await handlers.get("session_start")?.({ type: "session_start" }, ctx);
		await handlers.get("before_agent_start")?.(
			{ type: "before_agent_start", prompt: "1. 读取文件\n2. 修复问题" },
			ctx,
		);
		await handlers.get("tool_execution_end")?.({ type: "tool_execution_end", toolName: "read", isError: false }, ctx);
		await handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);

		const last = entries.at(-1);
		expect((last?.data as any).todos.every((t: any) => t.status === "completed")).toBe(true);
	});

	it("clears no-op todos when no real tool ran", async () => {
		const { handlers, entries, ctx } = createHarness();
		await handlers.get("session_start")?.({ type: "session_start" }, ctx);
		await handlers.get("before_agent_start")?.(
			{ type: "before_agent_start", prompt: "1. 读取文件\n2. 修复问题" },
			ctx,
		);
		await handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);

		expect(entries.at(-1)).toEqual({ customType: "todo-state", data: EMPTY_TODO_STATE });
	});

	it("keeps historical pending todos untouched when settling the current turn", async () => {
		const { handlers, entries, ctx } = createHarness();
		await handlers.get("session_start")?.({ type: "session_start" }, ctx);
		await handlers.get("before_agent_start")?.(
			{ type: "before_agent_start", prompt: "1. 修复历史遗留 bug\n2. 整理历史文档" },
			ctx,
		);
		await handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);

		// 空转 → 清理
		expect(entries.at(-1)).toEqual({ customType: "todo-state", data: EMPTY_TODO_STATE });

		// 下一轮独立重建
		await handlers.get("before_agent_start")?.(
			{ type: "before_agent_start", prompt: "1. 新增导出功能\n2. 更新测试文档" },
			ctx,
		);
		const todos = (entries.at(-1)?.data as any).todos;
		expect(todos.map((t: any) => t.text)).toEqual(["新增导出功能", "更新测试文档"]);
		expect(todos[0].status).toBe("pending");
	});
});
