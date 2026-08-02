/**
 * TODO 列表工具（系统自动维护版）
 *
 * 模型不参与 todo 维护（不暴露工具），避免模型逐项 start/done 产生的
 * 额外 API 轮次（实测占会话成本 45%）。系统闭环：
 *
 *   1. before_agent_start：触发评分 + 步骤解析命中 → 系统解析用户 prompt
 *      直接建列表（唯一建入口）
 *   2. agent_settled：本轮干过活（执行过主要工具）→ 全部标完成；纯问答
 *      空转 → 清理本轮建的列表
 *
 * 跨轮语义：上一轮列表已全部 completed，下一轮开始前自动清空并按新
 * prompt 重建，无需保留中间状态。
 *
 * 命令：
 *   /todos           — 在对话中查看当前 todo 列表（按状态分组）
 *   /todos clear     — 清空所有 todo
 */

import type { ExtensionAPI } from "../../index.ts";
import { TodoOverlay } from "./lib/todo-overlay.ts";
import { applyMutations, type TodoAction, type TodoBatchEntry } from "./lib/todo-reducer.ts";
import { replayTodoFromBranch } from "./lib/todo-replay.ts";
import { cloneState, EMPTY_TODO_STATE, hasOpenTodos, MAX_TODOS, type TodoState } from "./lib/todo-state.ts";
import { AUTO_TODO_MIN_STEPS, parseStepsFromPrompt, parseStepsFromText, scoreTodoTrigger } from "./lib/todo-trigger.ts";

/**
 * Tools whose execution proves the agent is doing real work. Used to decide
 * whether auto-created todos should be completed (agent_settled) or dropped as
 * no-ops (pure Q&A turn).
 */
const MAJOR_TOOLS = new Set([
	"read",
	"read_many",
	"bash",
	"bash_many",
	"grep",
	"grep_many",
	"ffgrep",
	"fff-multi-grep",
	"multi_grep",
	"find",
	"ffind",
	"fffind",
	"ls",
	"ls_many",
	"write",
	"edit",
]);

/** Prompts that reference the previous turn's suggestions without restating them. */
const REFERENCES_ADVICE = /(?:按|照|根据|依据|按照|上面|上述|建议|继续|接着|都|全部|这些|那些|逐一|逐条|接着改)/u;

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
	let didMajorToolRun = false;
	// 最近一条 assistant 文本（含重启后从 branch 恢复），供“按建议修改”类
	// prompt 从历史建议列表建 todo；以及当前轮用户 prompt（回填用）
	let lastAssistantText = "";
	let lastPrompt = "";

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

	function resetAgentTodoTracking(): void {
		agentAddedTodoIds = new Set<number>();
		didMajorToolRun = false;
		lastPrompt = "";
	}

	/** Drop todos this turn added when the agent never started any work. */
	function clearAddOnlyAgentTodos(): void {
		if (agentAddedTodoIds.size === 0) return;
		const addedIds = agentAddedTodoIds;
		if (![...addedIds].every((id) => state.todos.find((t) => t.id === id)?.status === "pending")) return;

		const todos = state.todos.filter((t) => !addedIds.has(t.id));
		replaceState(todos.length === 0 ? EMPTY_TODO_STATE : { todos, nextId: state.nextId });
		persistState();
		refreshWidget();
	}

	/**
	 * Create todos from the user prompt when the scorer fires or enough explicit
	 * steps parse out. Parsed steps become individual todos; a prompt the scorer
	 * approves but yields no steps becomes a single summary todo. Historical
	 * todos are left untouched (cross-turn follow-ups append nothing by design —
	 * the previous round's list is completed and cleared at the next start).
	 */
	function autoCreateTodos(prompt: string): number {
		if (hasOpenTodos(state)) return 0;
		const steps = parseStepsFromPrompt(prompt);
		const trigger = scoreTodoTrigger(prompt);
		if (!trigger.shouldTrigger && steps.length < AUTO_TODO_MIN_STEPS) {
			// 无结构 prompt 但引用了上一轮的建议（“按建议修改”类）→ 从历史列表建
			if (REFERENCES_ADVICE.test(prompt)) {
				const hist = parseStepsFromText(lastAssistantText);
				if (hist.length >= AUTO_TODO_MIN_STEPS) {
					const created = createTodos(
						hist.slice(0, MAX_TODOS).map((text) => ({ action: "add" as TodoAction, text })),
					);
					if (created > 0) return created;
				}
			}
			return 0;
		}

		const entries: TodoBatchEntry[] = steps.length
			? steps.slice(0, MAX_TODOS).map((text) => ({ action: "add" as TodoAction, text }))
			: [{ action: "add" as TodoAction, text: prompt.replace(/\s+/gu, " ").trim().slice(0, 120) }];
		return createTodos(entries);
	}

	/** Apply a batch of adds and persist. Returns the number created. */
	function createTodos(entries: TodoBatchEntry[]): number {
		const batch = applyMutations(state, entries);
		if (batch.ops.every((op) => op.kind === "error")) return 0;

		replaceState(batch.state);
		for (const op of batch.ops) {
			if (op.kind === "add") agentAddedTodoIds.add(op.id);
		}
		persistState();
		refreshWidget();
		return batch.ops.filter((op) => op.kind === "add").length;
	}

	/** Complete todos added this turn when real work happened; clear them as
	 * no-ops otherwise. Historical todos are never touched. */
	function settleAgentTodos(): void {
		if (agentAddedTodoIds.size === 0) return;
		if (!didMajorToolRun) {
			clearAddOnlyAgentTodos();
			return;
		}
		const ids = [...agentAddedTodoIds].filter((id) => state.todos.find((t) => t.id === id)?.status !== "completed");
		if (ids.length === 0) return;
		const batch = applyMutations(
			state,
			ids.map((id) => ({ action: "done" as TodoAction, id })),
		);
		replaceState(batch.state);
		persistState();
		refreshWidget();
	}

	function handleLifecycle(ctx: any): void {
		widgetCtx = ctx;
		restoreFromBranch(ctx);
		// 重启场景：从历史 branch 恢复最近一条 assistant 文本
		try {
			for (const entry of ctx.sessionManager.getBranch()) {
				const m = entry?.message;
				if (m?.role === "assistant") {
					const text = (m.content ?? [])
						.filter((b: any) => b.type === "text")
						.map((b: any) => b.text ?? "")
						.join("\n");
					if (text.trim()) lastAssistantText = text;
				}
			}
		} catch {
			// branch 不可读时忽略，仅影响历史建议解析
		}
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
		// 每轮独立：上一轮列表（无论 pending/completed）一律清空，按新 prompt 重建
		if (state.todos.length > 0) {
			replaceState(cloneState(EMPTY_TODO_STATE));
			persistState();
			refreshWidget();
		}
		lastPrompt = event.prompt ?? "";
		autoCreateTodos(lastPrompt);
	});

	// 累积最近一条 assistant 文本，供"按建议修改"类 prompt 解析历史建议；
	// 同时：列表仍为空时，从模型首条消息的列表（计划/清单）直接建 todo——
	// 覆盖无结构 prompt 下模型自主列计划的任务（信号源④）。
	pix.on("message_end", async (event) => {
		const message = event.message;
		if (message?.role !== "assistant") return;
		const text = (message.content ?? [])
			.filter((b: any) => b.type === "text")
			.map((b: any) => b.text ?? "")
			.join("\n");
		if (!text.trim()) return;
		lastAssistantText = text;
		if (state.todos.length === 0 && agentAddedTodoIds.size === 0) {
			const steps = parseStepsFromText(text);
			if (steps.length >= AUTO_TODO_MIN_STEPS) {
				createTodos(steps.slice(0, MAX_TODOS).map((t) => ({ action: "add" as TodoAction, text: t })));
			}
		}
	});

	// 只记录"干过活"标记；列表仍为空时回填单条总任务（信号源⑤，最后兜底）
	pix.on("tool_execution_end", async (event) => {
		if (!MAJOR_TOOLS.has(event.toolName)) return;
		didMajorToolRun = true;
		if (state.todos.length === 0 && agentAddedTodoIds.size === 0 && lastPrompt) {
			createTodos([{ action: "add" as TodoAction, text: lastPrompt.replace(/\s+/gu, " ").trim().slice(0, 120) }]);
		}
	});

	pix.on("session_shutdown", async (_event, _ctx) => {
		todoOverlay?.dispose();
		todoOverlay = undefined;
		widgetCtx = null;
	});

	// agent_settled 在 willRetry 重试全部结束后触发，避免 error 轮误判
	pix.on("agent_settled", async () => {
		settleAgentTodos();
		resetAgentTodoTracking();
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
}
