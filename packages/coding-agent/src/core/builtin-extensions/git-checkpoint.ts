/**
 * Git 自动检查点
 *
 * 每轮对话开始前自动创建 git stash 检查点。
 * 在 /fork 或 /tree 导航时可以恢复到任意检查点的代码状态。
 * 如果不在 git 仓库中，静默跳过。
 *
 * Verification (no automated git tests):
 * 1. In a git repo with dirty files, send a prompt that triggers tool edits.
 * 2. /fork to the user message (not a tool-result node) — restore prompt should appear.
 * 3. Choose restore — working tree should match pre-turn stash.
 */
import type { ExtensionAPI, ExtensionContext } from "../../index.ts";

export function builtin(pix: ExtensionAPI) {
	const checkpoints = new Map<string, string>();
	let isGitRepo = false;
	/** User-message entry id for the current agent loop (set on message_end). */
	let pendingUserEntryId: string | undefined;

	const restoreCheckpoint = async (ref: string, ctx: ExtensionContext) => {
		const result = await pix.exec("git", ["stash", "apply", ref], { cwd: ctx.cwd });
		if (result.code === 0) {
			ctx.ui.notify("代码已恢复到检查点", "info");
			return;
		}

		const detail = (result.stderr || result.stdout || `git stash apply exited with ${result.code}`).trim();
		ctx.ui.notify(`恢复检查点失败：${detail}`, "error");
	};

	pix.on("session_start", async (_event, ctx) => {
		// 检测是否在 git 仓库中
		try {
			const result = await pix.exec("git", ["rev-parse", "--is-inside-work-tree"], {
				cwd: ctx.cwd,
			});
			isGitRepo = result.code === 0;
		} catch {
			isGitRepo = false;
		}
	});

	pix.on("message_end", async (event, ctx) => {
		if (event.message.role !== "user") return;
		const leaf = ctx.sessionManager.getLeafEntry();
		if (leaf) pendingUserEntryId = leaf.id;
	});

	pix.on("turn_start", async (event, ctx) => {
		if (!isGitRepo) return;

		// 检查是否有未提交的变更
		const statusResult = await pix.exec("git", ["status", "--porcelain"], { cwd: ctx.cwd });
		if (statusResult.code !== 0 || !statusResult.stdout.trim()) return;

		// 创建 git stash 检查点
		const { stdout } = await pix.exec("git", ["stash", "create"], { cwd: ctx.cwd });
		const ref = stdout.trim();
		if (!ref) return;

		// Key by current leaf at turn boundary (not stale tool_result id).
		const leaf = ctx.sessionManager.getLeafEntry();
		if (leaf) checkpoints.set(leaf.id, ref);

		// /fork on the user prompt entry uses turnIndex 0 stash, not last tool result.
		if (event.turnIndex === 0 && pendingUserEntryId) {
			checkpoints.set(pendingUserEntryId, ref);
		}
	});

	pix.on("session_before_fork", async (event, ctx) => {
		if (!isGitRepo || !ctx.hasUI) return;

		const ref = checkpoints.get(event.entryId);
		if (!ref) return;

		const choice = await ctx.ui.select("是否恢复代码到该检查点?", ["是，恢复代码状态", "否，保留当前代码"]);

		if (choice?.startsWith("是")) {
			await restoreCheckpoint(ref, ctx);
		}
	});

	pix.on("session_before_tree", async (event, ctx) => {
		if (!isGitRepo || !ctx.hasUI) return;

		// tree 导航时也提供恢复选项
		const ref = checkpoints.get(event.preparation.oldLeafId ?? "");
		if (!ref) return;
		if (!event.preparation.userWantsSummary) return;

		const choice = await ctx.ui.select("切换分支前是否恢复代码?", ["是，恢复到检查点", "否，保留当前代码"]);

		if (choice?.startsWith("是")) {
			await restoreCheckpoint(ref, ctx);
		}
	});

	pix.on("agent_end", async () => {
		checkpoints.clear();
		pendingUserEntryId = undefined;
	});
}
