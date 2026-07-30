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

import { StringEnum } from "@chengshiliu16/pix-ai";
import { Text } from "@chengshiliu16/pix-tui";
import { Type } from "typebox";
import type { ExtensionAPI } from "../../index.ts";
import { TodoOverlay } from "./lib/todo-overlay.ts";
import { applyMutations, type TodoAction, type TodoBatchEntry, type TodoOp } from "./lib/todo-reducer.ts";
import { replayTodoFromBranch } from "./lib/todo-replay.ts";
import {
	cloneState,
	countByStatus,
	EMPTY_TODO_STATE,
	hasOpenTodos,
	MAX_ACTIVE_FORM_LENGTH,
	MAX_TODO_TEXT_LENGTH,
	MAX_TODOS,
	type TodoState,
} from "./lib/todo-state.ts";
import { buildTodoTriggerHint, scoreTodoTrigger } from "./lib/todo-trigger.ts";

function formatListSummary(state: TodoState): string {
	const counts = countByStatus(state);
	if (state.todos.length === 0) return "没有待办事项";
	return `📋 ${counts.pending} 待做, ${counts.in_progress} 进行中, ${counts.completed} 已做`;
}

/** Compact per-op marker; the model only needs the id and what happened to it. */
function opMarker(op: TodoOp): string {
	switch (op.kind) {
		case "add":
			return `+#${op.id}`;
		case "start":
			return `◐#${op.id}`;
		case "done":
			return `✓#${op.id}`;
		case "remove":
			return `✕#${op.id}`;
		case "list":
			return "";
		case "error":
			return `⚠ ${op.message}`;
	}
}

/**
 * Render a batch outcome. Single-entry calls keep their original one-line shape
 * so nothing downstream has to special-case the common path.
 */
function formatBatchResultText(ops: TodoOp[], state: TodoState): string {
	if (ops.length === 1) {
		const op = ops[0];
		if (op.kind === "list") return formatListSummary(state);
		if (op.kind === "done" && op.clearedAll) return `✅ ${state.todos.length}`;
		return `${opMarker(op)} ${formatListSummary(state)}`;
	}
	const markers = ops.map(opMarker).filter((marker) => marker.length > 0);
	return `${markers.join(" ")} ${formatListSummary(state)}`.trim();
}

/**
 * Accept either the batched `ops` array or the single-action shape, so existing
 * sessions and simple one-off calls keep working unchanged.
 */
function normalizeTodoEntries(params: {
	action?: string;
	text?: string;
	id?: number;
	activeForm?: string;
	ops?: Array<{ action?: string; text?: string; id?: number; activeForm?: string }>;
}): TodoBatchEntry[] {
	const source = params.ops?.length
		? params.ops
		: params.action
			? [{ action: params.action, text: params.text, id: params.id, activeForm: params.activeForm }]
			: [];
	return source
		.filter((entry): entry is { action: string; text?: string; id?: number; activeForm?: string } =>
			Boolean(entry?.action),
		)
		.map((entry) => ({
			action: entry.action as TodoAction,
			text: entry.text,
			id: entry.id,
			activeForm: entry.activeForm,
		}));
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

export function builtin(pix: ExtensionAPI) {
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
		pix.appendEntry("todo-state", { todos: state.todos, nextId: state.nextId });
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

	pix.on("session_start", async (_event, ctx) => {
		handleLifecycle(ctx);
	});

	pix.on("session_compact", async (_event, ctx) => {
		restoreFromBranch(ctx);
		todoOverlay?.update();
	});

	pix.on("session_tree", async (_event, ctx) => {
		restoreFromBranch(ctx);
		todoOverlay?.update();
	});

	pix.on("before_agent_start", async (event) => {
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

	pix.on("session_shutdown", async (_event, _ctx) => {
		todoOverlay?.dispose();
		todoOverlay = undefined;
		widgetCtx = null;
	});

	pix.on("agent_end", async () => {
		clearAddOnlyAgentTodos();
		resetAgentTodoTracking();
	});

	pix.on("tool_execution_end", async (event) => {
		if (event.toolName !== "todo_manage" || event.isError) return;
		refreshWidget();
	});

	// ---- 命令 ----
	pix.registerCommand("todos", {
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

	pix.registerTool({
		name: "todo_manage",
		label: "Todo Manager",
		description:
			"管理任务列表：add 添加, start 标记进行中, done 完成, remove 删除, list 查看。多个操作用 ops 数组一次提交。",
		promptSnippet: "管理任务列表，跟踪多步骤工作进度",
		promptGuidelines: [
			"多步任务（≥3 步）或用户一次列出多件事时用 todo_manage 跟踪；简单问答、解释代码、1-2 步的直接操作不要建 todo。",
			"多个操作放进一次调用的 ops 数组（一次 add 多条，或 add 完直接 start），不要每个操作单独调一次。",
			"start 标记进行中并把其他进行中的降回 pending（同时只能有一个），做完用 done。",
			"todo 是跟踪工具不是计划工具：边做边加，不要先铺一堆再开工。",
			"不要把分析结论、验证结果、最终总结变成 todo；用户只要求“列出清单”时直接用文本回答。本轮只 add 而没有 start/done/remove 的空转 todo 会被清理。",
			"每条 todo 是一个具体、可完成的动作；add 前看返回摘要避免重复，描述不准时 remove 后重建而不是再加一条。",
		],
		parameters: Type.Object({
			action: Type.Optional(
				StringEnum(["add", "start", "done", "remove", "list"] as const, {
					description: "单个操作；批量时改用 ops。add=添加, start=标记进行中, done=完成, remove=删除, list=查看",
				}),
			),
			text: Type.Optional(Type.String({ description: "任务描述（add 时必填）", maxLength: MAX_TODO_TEXT_LENGTH })),
			id: Type.Optional(Type.Number({ description: "任务 ID（start/done/remove 时必填）" })),
			activeForm: Type.Optional(
				Type.String({ description: "进行中的简短描述（start 时可选）", maxLength: MAX_ACTIVE_FORM_LENGTH }),
			),
			ops: Type.Optional(
				Type.Array(
					Type.Object({
						action: StringEnum(["add", "start", "done", "remove", "list"] as const, {
							description: "操作类型",
						}),
						text: Type.Optional(
							Type.String({ description: "任务描述（add 时必填）", maxLength: MAX_TODO_TEXT_LENGTH }),
						),
						id: Type.Optional(Type.Number({ description: "任务 ID（start/done/remove 时必填）" })),
						activeForm: Type.Optional(
							Type.String({ description: "进行中的简短描述", maxLength: MAX_ACTIVE_FORM_LENGTH }),
						),
					}),
					{ description: "按顺序执行的一批操作；优先用它代替多次单操作调用", maxItems: MAX_TODOS },
				),
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

			const entries = normalizeTodoEntries(params);
			if (entries.length === 0) {
				return {
					content: [{ type: "text", text: "错误：需要 action 或非空的 ops 数组" }],
					isError: true,
					details: { todos: state.todos, nextId: state.nextId },
				} as any;
			}

			const batch = applyMutations(state, entries);
			const details = { todos: batch.state.todos, nextId: batch.state.nextId };

			// A batch that failed outright is an error; a partial failure is not —
			// the successful entries were applied and the model needs to see that.
			if (batch.ops.every((op) => op.kind === "error")) {
				const message = batch.ops.map((op) => (op.kind === "error" ? op.message : "")).join("; ");
				return {
					content: [{ type: "text", text: message }],
					isError: true,
					details: { todos: state.todos, nextId: state.nextId },
				} as any;
			}

			replaceState(batch.state);
			for (const op of batch.ops) {
				if (op.kind === "add") agentAddedTodoIds.add(op.id);
				else if (op.kind === "start" || op.kind === "done" || op.kind === "remove") {
					agentTouchedExistingTodos = true;
				}
			}
			persistState();
			refreshWidget();

			return {
				content: [{ type: "text", text: formatBatchResultText(batch.ops, batch.state) }],
				details,
			};
		},
	});
}
