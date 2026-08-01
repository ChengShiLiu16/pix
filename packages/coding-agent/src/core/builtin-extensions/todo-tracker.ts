/**
 * TODO 列表工具（系统自动维护版）
 *
 * todo 状态通过 Widget 固定在编辑器上方，原地更新，不污染对话上下文。
 * 任务列表由系统在会话开始时从用户 prompt 自动解析创建（触发评分 + 步骤
 * 解析双重检测），agent 结束时自动标记完成——不再暴露 todo_manage 工具给
 * 模型，消除模型逐项 start/done 维护产生的额外 API 轮次（实测占会话成本
 * 45%）。
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
import { AUTO_TODO_MIN_STEPS, parseStepsFromPrompt, scoreTodoTrigger } from "./lib/todo-trigger.ts";

/**
 * Tools whose execution proves the agent is doing real work. Used to decide
 * whether auto-created todos should be completed (agent_end) or dropped as
 * no-ops (pure Q&A turn), and to backfill todos mid-turn when the initial
 * prompt did not look multi-step but the agent started working anyway.
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
	let didMajorToolRun = false;
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

	function clearCompletedState(): void {
		if (state.todos.length === 0 || hasOpenTodos(state)) return;
		replaceState(cloneState(EMPTY_TODO_STATE));
		persistState();
		refreshWidget();
	}

	function resetAgentTodoTracking(): void {
		agentAddedTodoIds = new Set<number>();
		agentTouchedExistingTodos = false;
		didMajorToolRun = false;
		lastPrompt = "";
	}

	/** Drop todos this turn added when the agent never started any work. */
	function clearAddOnlyAgentTodos(): void {
		if (agentAddedTodoIds.size === 0 || agentTouchedExistingTodos) return;
		const addedIds = agentAddedTodoIds;
		if (![...addedIds].every((id) => state.todos.find((t) => t.id === id)?.status === "pending")) return;

		const todos = state.todos.filter((t) => !addedIds.has(t.id));
		replaceState(todos.length === 0 ? EMPTY_TODO_STATE : { todos, nextId: state.nextId });
		persistState();
		refreshWidget();
	}

	/** Auto-create todos from the user prompt when the trigger fires or enough
	 * explicit steps parse out. With `allowFallback`, a summary todo is created
	 * for prompts without a step structure (used for mid-turn backfill once the
	 * agent demonstrably started working). When todos already exist, only newly
	 * parsed steps are appended (cross-turn follow-ups); the single-task fallback
	 * is skipped. Returns the number of created todos. */
	function autoCreateTodos(prompt: string, allowFallback: boolean): number {
		const steps = parseStepsFromPrompt(prompt);
		const trigger = scoreTodoTrigger(prompt);
		if (!trigger.shouldTrigger && steps.length < AUTO_TODO_MIN_STEPS && !allowFallback) return 0;

		let entries: TodoBatchEntry[];
		if (hasOpenTodos(state)) {
			// 跨轮续做：只追加新解析出的步骤，避免重复建总任务
			if (steps.length < AUTO_TODO_MIN_STEPS) return 0;
			entries = steps.slice(0, MAX_TODOS).map((text) => ({ action: "add" as TodoAction, text }));
		} else {
			entries = steps.length
				? steps.slice(0, MAX_TODOS).map((text) => ({ action: "add" as TodoAction, text }))
				: [{ action: "add" as TodoAction, text: prompt.replace(/\s+/gu, " ").trim().slice(0, 120) }];
		}

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

	/**
	 * Settle todos added this turn:
	 * - real tools ran AND the turn ended with a final text reply → complete them;
	 * - real tools ran but the turn was cut off (no final reply) → keep pending
	 *   so cross-turn work stays tracked;
	 * - no real tools at all (pure Q&A) → drop them as no-ops.
	 * Historical todos are never touched.
	 */
	function settleAgentTodos(finished: boolean): void {
		if (agentAddedTodoIds.size === 0) return;
		if (!didMajorToolRun) {
			clearAddOnlyAgentTodos();
			return;
		}
		if (!finished) return;
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
		lastPrompt = event.prompt ?? "";
		autoCreateTodos(lastPrompt, false);
	});

	// Mid-turn backfill: the prompt did not look multi-step, but the agent
	// started executing real tools anyway — give the user a progress list.
	// Also auto-advance “in progress”: with no in_progress item, promote the
	// first pending todo (sequential-execution assumption) so the widget shows
	// what the agent is working on — without any model round trips.
	pix.on("tool_execution_end", async (event) => {
		if (!MAJOR_TOOLS.has(event.toolName)) return;
		didMajorToolRun = true;
		if (state.todos.length === 0 && agentAddedTodoIds.size === 0 && lastPrompt) {
			autoCreateTodos(lastPrompt, true);
		}
		if (!state.todos.some((t) => t.status === "in_progress")) {
			const next = state.todos.find((t) => t.status === "pending");
			if (next) {
				const batch = applyMutations(state, [{ action: "start" as TodoAction, id: next.id }]);
				if (batch.ops.some((op) => op.kind !== "error")) {
					replaceState(batch.state);
					persistState();
				}
			}
		}
		refreshWidget();
	});

	pix.on("session_shutdown", async (_event, _ctx) => {
		todoOverlay?.dispose();
		todoOverlay = undefined;
		widgetCtx = null;
	});

	let lastAssistantFinalText = false;
	let pendingSettle = false;

	pix.on("message_end", async (event) => {
		const message = event.message;
		if (message?.role !== "assistant") return;
		const content = (message.content ?? []) as Array<{ type?: string }>;
		lastAssistantFinalText = content.some((b) => b.type === "text") && !content.some((b) => b.type === "toolCall");
	});

	// 结算推迟到 agent_settled：agent_end 可能在 error 轮触发（随后 willRetry
	// 重试成功），此时用 message_end 累积的最终消息判定，避免误判。
	pix.on("agent_end", async () => {
		pendingSettle = true;
	});

	pix.on("agent_settled", async () => {
		if (!pendingSettle) return;
		pendingSettle = false;
		settleAgentTodos(lastAssistantFinalText);
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
