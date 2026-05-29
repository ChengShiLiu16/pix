/**
 * TODO 列表工具（Widget 版）
 *
 * todo 状态通过 Widget 固定在编辑器上方，原地更新，不污染对话上下文。
 * 工具返回值只包含操作结果，不重复输出完整列表。
 *
 * 命令：
 *   /todos           — 在对话中查看当前 todo 列表（按状态分组）
 *   /todos clear     — 清空所有 todo
 *
 * 工具：
 *   todo_manage      — LLM 可调用的 todo 管理工具
 */

import { StringEnum } from "@earendil-works/pix-ai";
import { Text } from "@earendil-works/pix-tui";
import { Type } from "typebox";
import type { ExtensionAPI } from "../../index.ts";
import { TodoOverlay } from "./lib/todo-overlay.ts";
import { applyMutation, type TodoAction } from "./lib/todo-reducer.ts";
import { replayTodoFromBranch } from "./lib/todo-replay.ts";
import {
	cloneState,
	countByStatus,
	EMPTY_TODO_STATE,
	hasOpenTodos,
	MAX_ACTIVE_FORM_LENGTH,
	MAX_TODO_TEXT_LENGTH,
	type TodoState,
} from "./lib/todo-state.ts";
import { buildTodoTriggerHint, scoreTodoTrigger } from "./lib/todo-trigger.ts";

function formatListSummary(state: TodoState): string {
	const counts = countByStatus(state);
	if (state.todos.length === 0) return "没有待办事项";
	return `📋 ${counts.pending} 待做, ${counts.in_progress} 进行中, ${counts.completed} 已做`;
}

function formatCommandGroups(state: TodoState): string {
	const inProgress = state.todos.filter((t) => t.status === "in_progress");
	const pending = state.todos.filter((t) => t.status === "pending");
	const completed = state.todos.filter((t) => t.status === "completed");
	const parts: string[] = [];

	if (inProgress.length) {
		parts.push("◐ 进行中:");
		inProgress.forEach((t) => {
			const form = t.activeForm ? ` (${t.activeForm})` : "";
			parts.push(`   #${t.id} ${t.text}${form}`);
		});
	}
	if (pending.length) {
		parts.push("● 待完成:");
		pending.forEach((t) => {
			parts.push(`   #${t.id} ${t.text}`);
		});
	}
	if (completed.length) {
		parts.push(`✓ 已完成 (${completed.length}/${state.todos.length})`);
		completed.forEach((t) => {
			parts.push(`   #${t.id} ${t.text}`);
		});
	}
	return parts.join("\n");
}

export function builtin(pi: ExtensionAPI) {
	let state: TodoState = cloneState(EMPTY_TODO_STATE);
	let widgetCtx: any = null;
	let todoOverlay: TodoOverlay | undefined;
	let agentAddedTodoIds = new Set<number>();
	let agentTouchedExistingTodos = false;

	function getState(): TodoState {
		return state;
	}

	function replaceState(next: TodoState): void {
		state = cloneState(next);
	}

	function restoreFromBranch(ctx: { sessionManager: { getBranch(): Iterable<unknown> } }): void {
		replaceState(replayTodoFromBranch(ctx as Parameters<typeof replayTodoFromBranch>[0]));
	}

	function persistState() {
		pi.appendEntry("todo-state", { todos: state.todos, nextId: state.nextId });
	}

	function refreshWidget(): void {
		if (!widgetCtx?.hasUI) return;
		todoOverlay ??= new TodoOverlay(getState);
		todoOverlay.setUICtx(widgetCtx.ui);
		todoOverlay.update();
	}

	function clearCompletedState(): void {
		if (state.todos.length === 0 || hasOpenTodos(state)) return;
		replaceState(cloneState(EMPTY_TODO_STATE));
		persistState();
		refreshWidget();
	}

	function resetAgentTodoTracking(): void {
		agentAddedTodoIds = new Set<number>();
		agentTouchedExistingTodos = false;
	}

	function clearAddOnlyAgentTodos(): void {
		if (agentAddedTodoIds.size === 0 || agentTouchedExistingTodos) return;
		const addedIds = agentAddedTodoIds;
		if (![...addedIds].every((id) => state.todos.find((t) => t.id === id)?.status === "pending")) return;

		const todos = state.todos.filter((t) => !addedIds.has(t.id));
		replaceState(todos.length === 0 ? EMPTY_TODO_STATE : { todos, nextId: state.nextId });
		persistState();
		refreshWidget();
	}

	function handleLifecycle(ctx: any): void {
		widgetCtx = ctx;
		restoreFromBranch(ctx);
		if (ctx.hasUI) {
			todoOverlay ??= new TodoOverlay(getState);
			todoOverlay.setUICtx(ctx.ui);
			todoOverlay.update();
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		handleLifecycle(ctx);
	});

	pi.on("session_compact", async (_event, ctx) => {
		restoreFromBranch(ctx);
		todoOverlay?.update();
	});

	pi.on("session_tree", async (_event, ctx) => {
		restoreFromBranch(ctx);
		todoOverlay?.update();
	});

	pi.on("before_agent_start", async (event) => {
		resetAgentTodoTracking();
		clearCompletedState();
		if (hasOpenTodos(state)) return;

		const trigger = scoreTodoTrigger(event.prompt);
		if (!trigger.shouldTrigger) return;

		return {
			message: {
				customType: "todo-hint",
				content: buildTodoTriggerHint(trigger),
				display: false,
			},
		};
	});

	pi.on("session_shutdown", async (_event, _ctx) => {
		todoOverlay?.dispose();
		todoOverlay = undefined;
		widgetCtx = null;
	});

	pi.on("agent_end", async () => {
		clearAddOnlyAgentTodos();
		resetAgentTodoTracking();
	});

	pi.on("tool_execution_end", async (event) => {
		if (event.toolName !== "todo_manage" || event.isError) return;
		refreshWidget();
	});

	// ---- 命令 ----
	pi.registerCommand("todos", {
		description: "查看或管理 todo 列表",
		handler: async (args, ctx) => {
			if (args?.trim() === "clear") {
				replaceState(cloneState(EMPTY_TODO_STATE));
				persistState();
				refreshWidget();
				ctx.ui.notify("已清空 todo 列表", "info");
				return;
			}
			const text = state.todos.length ? formatCommandGroups(state) : "📝 没有待办事项";
			ctx.ui.notify(text, "info");
		},
	});

	// ---- LLM 工具 ----
	const EMPTY = new Text("", 0, 0);

	pi.registerTool({
		name: "todo_manage",
		label: "Todo Manager",
		description:
			"管理任务列表。用 add 添加任务，start 标记进行中，done 标记完成，remove 删除，list 查看。适合跟踪多步骤任务的进度。",
		promptSnippet: "管理任务列表，跟踪多步骤工作进度",
		promptGuidelines: [
			"【何时使用 todo_manage】",
			"用户明确列出多个要做的事情时（如 '帮我做A、B、C' 或 '首先做X，然后做Y'），用 add 逐个添加到 todo 列表",
			"开始执行某一步时用 start 标记进行中（同时只能有一个 in_progress），完成后用 done 标记",
			"用户描述一个需要3步以上的任务时（如 '实现完整功能'、'重构模块'），先拆解为步骤 add 到 todo，再逐步执行",
			"【何时不要使用 todo_manage】",
			"简单问答、解释代码、单次操作（如 '解释这个函数'、'改一下变量名'、'看看这个文件'）——不要创建 todo",
			"用户只问一个问题或只需要一个回答——不要创建 todo",
			"任务只有1-2步且很直接——不需要 todo 跟踪",
			"【使用原则】",
			"todo 是跟踪工具不是计划工具，不要先创建一堆 todo 再开始工作，而是在确定需要做多步时边做边加",
			"不要把已完成的分析、验证结果、总结清单创建成 todo；如果只是要求列出/生成 todo 清单，请直接用文本回答，不要调用 todo_manage",
			"不要在最终总结阶段新建 todo；如果本轮只 add 而没有 start/done/remove，系统会把这些空转 todo 当作临时清单清理掉",
			"每个 todo 应该是一个具体的、可完成的动作，不要写模糊的描述",
			"start 会将其他进行中的任务降回 pending，确保同时只有一个任务处于 in_progress",
		],
		parameters: Type.Object({
			action: StringEnum(["add", "start", "done", "remove", "list"] as const, {
				description: "操作类型：add=添加, start=标记进行中, done=标记完成, remove=删除, list=查看列表",
			}),
			text: Type.Optional(Type.String({ description: "任务描述（add 时必填）", maxLength: MAX_TODO_TEXT_LENGTH })),
			id: Type.Optional(Type.Number({ description: "任务 ID（start/done/remove 时必填）" })),
			activeForm: Type.Optional(
				Type.String({ description: "进行中的简短描述（start 时可选）", maxLength: MAX_ACTIVE_FORM_LENGTH }),
			),
		}),
		renderCall() {
			return EMPTY;
		},
		renderResult(result: any, _opts: any, theme: any, context: any) {
			if (context.isError) {
				const text = result?.content?.[0]?.text ?? "";
				const colored = text
					.split("\n")
					.map((line: string) => theme.fg("error", line || " "))
					.join("\n");
				return new Text(colored, 0, 0);
			}
			return EMPTY;
		},
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			widgetCtx = ctx;

			const action = params.action as TodoAction;
			const result = applyMutation(state, action, {
				text: params.text,
				id: params.id,
				activeForm: params.activeForm,
			});

			const details = { todos: result.state.todos, nextId: result.state.nextId };

			if (result.op.kind === "error") {
				return {
					content: [{ type: "text", text: result.op.message }],
					isError: true,
					details: { todos: state.todos, nextId: state.nextId },
				} as any;
			}

			replaceState(result.state);
			if (result.op.kind === "add") {
				agentAddedTodoIds.add(result.op.id);
			} else if (result.op.kind === "start" || result.op.kind === "done" || result.op.kind === "remove") {
				agentTouchedExistingTodos = true;
			}
			persistState();

			switch (result.op.kind) {
				case "add":
					refreshWidget();
					return {
						content: [{ type: "text", text: `+#${result.op.id}` }],
						details,
					};
				case "start":
					refreshWidget();
					return {
						content: [{ type: "text", text: `◐#${result.op.id}` }],
						details,
					};
				case "done": {
					if (result.op.clearedAll) {
						refreshWidget();
						return {
							content: [{ type: "text", text: `✅ ${result.state.todos.length}` }],
							details,
						};
					}
					refreshWidget();
					return {
						content: [{ type: "text", text: `✓#${result.op.id}` }],
						details,
					};
				}
				case "remove":
					refreshWidget();
					return {
						content: [{ type: "text", text: `✕#${result.op.id}` }],
						details,
					};
				case "list":
					refreshWidget();
					return {
						content: [{ type: "text", text: formatListSummary(state) }],
						details,
					};
			}
		},
	});
}
