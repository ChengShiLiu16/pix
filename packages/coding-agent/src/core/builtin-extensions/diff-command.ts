/**
 * /diff 命令
 *
 * 查看 git 变更文件列表，选择后在 VS Code 中打开 diff 视图。
 * 无依赖，纯 git + code CLI。
 */
import type { ExtensionAPI } from "../../index.ts";

interface FileChange {
	status: string;
	file: string;
	staged: boolean;
}

const STATUS_LABELS: Record<string, string> = {
	M: "修改",
	A: "新增",
	D: "删除",
	R: "重命名",
	C: "复制",
	"?": "未跟踪",
};

export function builtin(pi: ExtensionAPI) {
	pi.registerCommand("diff", {
		description: "查看 git 变更文件，选择后在编辑器中打开 diff",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/diff 需要交互模式", "error");
				return;
			}

			// 获取所有变更文件
			const result = await pi.exec("git", ["status", "--porcelain"], { cwd: ctx.cwd });
			if (result.code !== 0) {
				ctx.ui.notify(`git status 失败: ${result.stderr}`, "error");
				return;
			}

			if (!result.stdout.trim()) {
				ctx.ui.notify("没有变更文件", "info");
				return;
			}

			const files: FileChange[] = result.stdout
				.split("\n")
				.filter((line) => line.trim().length >= 4)
				.map((line) => {
					const statusCode = line.slice(0, 2).trim();
					const file = line.slice(2).trimStart();
					// → 开头表示重命名目标
					const cleanFile = file.replace(/^-> /, "");
					return {
						status: statusCode[0] === "?" ? "?" : statusCode[0] || statusCode[1] || "~",
						file: cleanFile,
						staged: statusCode[0] !== " " && statusCode[0] !== "?",
					};
				});

			if (files.length === 0) {
				ctx.ui.notify("没有变更文件", "info");
				return;
			}

			// 构建选项列表
			const options = files.map((f) => {
				const label = STATUS_LABELS[f.status] || f.status;
				const prefix = f.staged ? "✓" : " ";
				return `${prefix} [${label}] ${f.file}`;
			});

			const selected = await ctx.ui.select("选择文件查看 diff:", options);
			if (!selected) return;

			const idx = options.indexOf(selected);
			if (idx === -1) return;
			const target = files[idx];

			if (target.status === "?") {
				// 未跟踪文件，直接打开
				await pi.exec("code", ["-g", target.file], { cwd: ctx.cwd });
			} else {
				// 已跟踪文件，打开 diff
				const diffResult = await pi.exec("git", ["difftool", "-y", "--tool=vscode", target.file], {
					cwd: ctx.cwd,
				});
				// difftool 可能失败，回退到直接打开
				if (diffResult.code !== 0) {
					await pi.exec("code", ["-g", target.file], { cwd: ctx.cwd });
				}
			}
		},
	});
}
