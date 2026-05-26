import { formatDuration, type WorkerRunMetrics } from "./spawn.ts";
import {
	formatWorkerShortcutKey,
	formatWorkerShortcutRange,
	formatWorkerViewActionHint,
	WORKER_VIEW_KEYMAP,
} from "./worker-shortcuts.ts";

export const MAX_BACKGROUND = 3;

/** Tools the coordinator must not call when Multitask is ON. */
export const COORDINATOR_BLOCKED_TOOLS = new Set([
	"read",
	"read_many",
	"grep",
	"grep_many",
	"bash",
	"edit",
	"write",
	"find",
	"ls",
	"ls_many",
]);

export function buildCoordinatorHint(): string {
	return `[MULTITASK 协调者模式 ON — 对齐 Cursor Multitask]

你是协调者（coordinator），不是执行者。本回合硬性规则：

1. **必须委派**：跨文件调查、代码库探索、实现、改代码、跑测试、多步 shell → 一律 \`task({ background: true, prompt, description })\` 派给 worker。禁止协调者自己调用 read/grep/bash/edit/write。
2. **spawn 后立即停**：调用 task(background:true) 后只给用户一句简短状态（如「已派发 worker，见上方 widget」），不要继续调查、不要等待、不要复述 worker 该做的事。
3. **并行**：互不依赖的子任务 → 同一回合内并行多个 task(background:true)，最多 ${MAX_BACKGROUND} 个并发。
4. **批量工具归 worker**：read_many / grep_many / ls_many 留给 worker；协调者不要调用。
5. **worker 完成**（followUp 到达后）：
   - followUp **仅一行状态**（如「✓ Worker #abc 完成 in 52s — ▸ ${formatWorkerShortcutKey(1)} 查看 worker #abc」）；**完整输出在 task 工具行**（${formatWorkerShortcutRange()} 全屏或 /expand-worker 内联展开），不在 followUp 里。
   - **可交付任务**（分析/报告/文档/全景调查/评审）：默认不向 chat 倾倒 worker 全文；若用户明确要求摘要或结论，协调者可基于展开后的 task 输出自行提炼。
   - **实现类任务**（改代码/跑测试/修 bug）：一行确认即可（如「#abc 已改完 X 文件」）。
   - **worker 失败**：向用户说明失败（exit code 等）；详情在 task 展开，不要假装成功，不要说「结果已在 widget 中」。

例外（协调者可自己做）：用户附带的小文件、一句澄清回复、调用 task 本身。`;
}

export function buildBlockedToolReason(toolName: string): string {
	return `Multitask ON：协调者禁止直接调用 \`${toolName}\`。请改用 task({ background: true, prompt: "...", description: "..." }) 委派 worker；read_many/grep_many 由 worker 使用。`;
}

export function buildTaskDisabledReason(): string {
	return "Multitask OFF：`task` 工具不可用。先用 /multitask 开启协调者模式后再委派 worker。";
}

export function buildWorkerViewDisabledReason(): string {
	return "Multitask OFF：无 worker 可查看。先用 /multitask 开启后再派发 worker；本会话已有的 worker 仍可用快捷键或 /view-worker 查看。";
}

export function buildToggleMessage(enabled: boolean): string {
	if (!enabled) {
		return [
			"Multitask OFF — 已恢复常规模式，可直接使用 read/bash/edit 等工具。",
			"· `task` 已禁用，不能再派发新 worker",
			"· 本会话已有的 worker 仍可用快捷键或 /view-worker 查看",
		].join("\n");
	}
	return [
		"Multitask ON — 协调者模式（对齐 Cursor Multitask）",
		"· 调查 / 实现 / 测试 → task(background:true) 委派，不要自己 read/bash/edit",
		"· spawn 后简短回复即可；worker 进度见上方 widget",
		`· 最多 ${MAX_BACKGROUND} 个并发 background worker；独立任务请并行派发`,
		`· worker 完成后：followUp 仅状态行；完整输出用 ${formatWorkerShortcutRange()} 全屏或 task 行 /expand-worker 内联`,
		`· 查看 worker：${WORKER_VIEW_KEYMAP}`,
		"· 分析/报告类：用户要求时再提炼摘要；实现类 → 一行确认",
	].join("\n");
}

export function buildWorkerCompleteFollowUp(
	id: string,
	description: string,
	ok: boolean,
	_output?: string,
	exitCode?: number,
	metrics?: WorkerRunMetrics,
	_diagnosis?: string,
): string {
	const label = description.slice(0, 60) || "worker";
	const icon = ok ? "✓" : "✗";
	const status = ok ? "完成" : "失败";
	const timing = metrics ? ` in ${formatDuration(metrics.durationMs)}` : "";
	const expandHint = formatWorkerViewActionHint(1, id, ok ? "report" : "error");

	let failureBits = "";
	if (!ok) {
		const parts: string[] = [];
		if (exitCode != null) parts.push(`exit ${exitCode}`);
		if (metrics?.toolCalls === 0) parts.push("tool calls: 0");
		if (parts.length) failureBits = ` — ${parts.join("，")}`;
	}

	return `${icon} Worker #${id} ${status}${timing}（${label}）${failureBits} — ${expandHint}`;
}

export const TASK_DESCRIPTION =
	"Spawn isolated Pi worker subprocess. Prefer background:true for async single workers; tasks[] runs a foreground parallel batch capped at 3 workers.";

export const TASK_PROMPT_GUIDELINES = [
	"Multitask ON (/multitask): ANY non-trivial work (explore, implement, test, multi-file) → task({ background: true, prompt, description }). Coordinator must NOT use read/bash/edit directly.",
	"After task(background:true), STOP — brief status to user only; workers show in widget above chat.",
	"Independent async subtasks → parallel task(background:true) calls in one turn (max 3 concurrent). `tasks[]` is a foreground parallel batch and is also capped at 3 items. EVERY item/call must include its own full `prompt` — `description` alone is invalid.",
	"Workers may use read_many/grep_many; coordinator should not.",
	"Use description for widget label only; prompt must contain complete worker instructions (paths, steps, output format).",
	"On completion: followUp is status-only; full output lives in expanded task tool row. Summarize in chat only if user asks.",
];
