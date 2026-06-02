/**
 * 自动压缩增强
 *
 * 替代原 auto-compact.ts。不再自行触发 compact，
 * 而是在内置自动压缩前注入自定义压缩指令，
 * 确保压缩保留关键信息。
 *
 * /compact-here 命令可自定义压缩指令。
 */
import type { ExtensionAPI, SessionBeforeCompactEvent } from "../../index.ts";

export function builtin(pi: ExtensionAPI) {
	// 在内置自动压缩触发前，注入自定义指令
	pi.on("session_before_compact", async (event: SessionBeforeCompactEvent, _ctx) => {
		// 只在自动压缩时注入指令（手动 /compact 由用户自己控制）
		if (event.reason !== "manual") {
			return {
				customInstructions: "保留最近的工作内容、文件变更记录和下一步计划。精简中间的探索过程和失败尝试。",
			};
		}
	});

	// 手动压缩命令
	pi.registerCommand("compact-here", {
		description: "压缩上下文，可附加自定义指令",
		handler: async (args, ctx) => {
			const customInstructions = args?.trim() || undefined;
			ctx.compact({
				customInstructions: customInstructions || "保留目标、关键决策、已修改文件和下一步。精简过程细节。",
				onComplete: () => {
					ctx.ui.notify("压缩完成", "info");
				},
				onError: (err) => {
					ctx.ui.notify(`压缩失败: ${err.message}`, "error");
				},
			});
		},
	});
}
