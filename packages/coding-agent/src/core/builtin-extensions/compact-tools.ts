/**
 * 紧凑工具渲染器
 *
 * 覆盖 read / bash / grep / find / ls / write / edit 的 call + result 渲染：
 * - read/grep/find/ls/bash:
 *   - 成功: call 显示 tree 标题 + 明细行, result 折叠为空, 展开显示完整输出
 *   - 失败: call 显示命令/路径, result 仅红色报错
 * - bash:
 *   - 普通命令: call 显示 `Bash` + command 明细行
 *   - 文件变更 (cat >>/> file <<EOF): call 显示 `Write/Append` + path 明细行
 * - write/edit:
 *   - renderShell=self, call 显示 `Write/Edit` + path 明细行
 *   - result 折叠为空, 展开显示完整内容/diff
 */

import { Container, Spacer, Text } from "@earendil-works/pix-tui";
import type { ExtensionAPI } from "../../index.ts";
import {
	type BashToolDetails,
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type EditToolDetails,
	type FindToolDetails,
	type GrepToolDetails,
	type LsToolDetails,
	type ReadToolDetails,
} from "../../index.ts";
import { formatBashCallWithBatch, getBashFileMutationPreview } from "./lib/bash-batch-display.ts";
import { formatToolPath, formatTreeCall, setDisplayCwd, shortenPath } from "./lib/format-tree-call.ts";
import { formatReadCallWithBatch, setReadBatchCwd } from "./lib/read-batch-display.ts";
import {
	dangerousShellCommandError,
	findDangerousShellCommand,
	findSensitiveShellReadPath,
	isSensitiveReadPath,
	sensitiveReadError,
} from "./lib/sensitive-files.ts";
import { installToolVisibilityPatch, restoreToolVisibilityPatch } from "./lib/tool-visibility-patch.ts";

const MAX_READ_LINES = 40;

type ThemeLike = {
	fg(name: string, text: string): string;
	bold(text: string): string;
};

function extractText(content: any[] | undefined): string {
	const parts: string[] = [];
	for (const c of content ?? []) {
		if (c.type === "text") parts.push(String(c.text ?? ""));
	}
	return parts.join("\n");
}

function hasImage(content: any[]): boolean {
	return (content ?? []).some((c: any) => c.type === "image");
}

function lineCount(text: string): number {
	return text ? text.split("\n").length : 0;
}

function renderErrorText(result: { content?: any[] }, theme: ThemeLike): Text {
	const text = extractText(result.content);
	// Per-line coloring survives wrapTextWithAnsi and terminal edge cases better than one big span.
	const colored = text
		.split("\n")
		.map((line) => theme.fg("error", line || " "))
		.join("\n");
	return new Text(colored, 0, 0);
}

function formatReadCall(
	args: { path?: string; offset?: number; limit?: number },
	theme: ThemeLike,
	toolCallId?: string,
	invalidate?: () => void,
	truncation?: { outputLines?: number; totalLines?: number },
	argsComplete = false,
): Text {
	return formatReadCallWithBatch(args, theme, toolCallId, invalidate, truncation, argsComplete);
}

function formatGrepCall(
	args: { pattern?: string; path?: string; glob?: string; limit?: number },
	theme: ThemeLike,
	argsComplete = false,
): Text {
	if (!argsComplete) return EMPTY;
	const pattern = args?.pattern ?? "";
	const path = shortenPath(args?.path || ".");
	let detail = theme.fg("accent", `/${pattern}/`) + theme.fg("toolOutput", " in ") + formatToolPath(path);
	if (args?.glob) detail += theme.fg("toolOutput", ` (${args.glob})`);
	if (args?.limit !== undefined) detail += theme.fg("toolOutput", ` limit ${args.limit}`);
	return formatTreeCall(theme, "Grep", [detail]);
}

function formatFindCall(args: { pattern?: string; path?: string; limit?: number }, theme: ThemeLike): Text {
	const pattern = args?.pattern ?? "";
	const path = shortenPath(args?.path || ".");
	let detail = theme.fg("accent", pattern) + theme.fg("toolOutput", " in ") + formatToolPath(path);
	if (args?.limit !== undefined) detail += theme.fg("toolOutput", ` limit ${args.limit}`);
	return formatTreeCall(theme, "Find", [detail]);
}

function formatLsCall(args: { path?: string; limit?: number }, theme: ThemeLike, argsComplete = false): Text {
	if (!argsComplete) return EMPTY;
	const path = shortenPath(args?.path || ".");
	let detail = formatToolPath(path);
	if (args?.limit !== undefined) detail += theme.fg("toolOutput", ` limit ${args.limit}`);
	return formatTreeCall(theme, "List", [detail]);
}

function _truncateOneLine(text: string, maxLen = 80): string {
	const oneLine = text.split(/\r?\n/)[0] || text;
	if (oneLine.length <= maxLen) return oneLine;
	return `${oneLine.slice(0, maxLen - 1)}…`;
}

function formatBashCall(
	args: { command?: string },
	theme: ThemeLike,
	toolCallId?: string,
	invalidate?: () => void,
	argsComplete = false,
): Text {
	return formatBashCallWithBatch(args, theme, toolCallId, invalidate, argsComplete);
}

/** read_many / grep_many / ls_many embed per-item errors as "ERROR: …" with top-level isError still false */
function contentHasMarkedErrors(text: string): boolean {
	return /(?:^|\n)ERROR: /m.test(text);
}

function shouldRenderAsToolError(context: { isError?: boolean }, result: { content?: any[] }): boolean {
	return Boolean(context.isError) || contentHasMarkedErrors(extractText(result.content));
}

const EMPTY = new Text("", 0, 0);

export function builtin(pi: ExtensionAPI) {
	let lastRegisteredCwd = "";

	void installToolVisibilityPatch().catch((err) => {
		console.error(
			"[compact-tools] installToolVisibilityPatch failed — batch aggregation UI will not work:",
			err instanceof Error ? err.message : err,
		);
	});

	pi.on("session_start", async (_event, ctx) => {
		try {
			await installToolVisibilityPatch();
		} catch (err) {
			console.error(
				"[compact-tools] installToolVisibilityPatch failed — batch aggregation UI will not work:",
				err instanceof Error ? err.message : err,
			);
		}
		setDisplayCwd(ctx.cwd);
		setReadBatchCwd(ctx.cwd);
		const cwd = ctx.cwd;
		if (cwd === lastRegisteredCwd) {
			// Same cwd but still register — /reload clears Pi's tool registry.
		} else {
			lastRegisteredCwd = cwd;
		}
		const readDef = createReadToolDefinition(cwd);
		const executeRead: typeof readDef.execute = async (toolCallId, params, signal, onUpdate, ctx) => {
			const readPath = typeof params.path === "string" ? params.path : "";
			if (isSensitiveReadPath(readPath)) {
				return {
					content: [{ type: "text", text: sensitiveReadError(readPath) }],
					isError: true,
				} as any;
			}
			return readDef.execute(toolCallId, params, signal, onUpdate, ctx);
		};
		pi.registerTool({
			name: readDef.name,
			label: readDef.label,
			description: readDef.description,
			parameters: readDef.parameters,
			promptSnippet: readDef.promptSnippet,
			promptGuidelines: [
				...(readDef.promptGuidelines ?? []),
				"Use read_many instead of multiple read calls when reading two or more files.",
				"Use ls/ls_many for directories; read is only for files.",
				"Do not read credential files such as .env*, auth.json, token files, .npmrc, or private keys.",
			],
			execute: executeRead,
			renderCall(args: any, theme: any, context: any) {
				const result = (context as { result?: { details?: ReadToolDetails } }).result;
				return formatReadCall(
					args,
					theme,
					context.toolCallId,
					context.invalidate,
					result?.details?.truncation,
					context.argsComplete,
				);
			},
			renderResult(result: any, { expanded }: any, theme: any, context: any) {
				if (shouldRenderAsToolError(context, result)) {
					return renderErrorText(result, theme);
				}

				if (!expanded) return EMPTY;

				const args = context.args as { path?: string; offset?: number; limit?: number };
				const details = result.details as ReadToolDetails | undefined;

				const textContent = extractText(result.content);
				const img = hasImage(result.content);
				const lines = lineCount(textContent);

				if (img && !textContent) return new Text(`[image]`, 0, 0);

				const isTargetedRead = typeof args?.offset === "number" || typeof args?.limit === "number";
				let display = textContent;
				if (!isTargetedRead && lines > MAX_READ_LINES) {
					display =
						display.split("\n").slice(0, MAX_READ_LINES).join("\n") +
						`\n··· ${lines - MAX_READ_LINES} more lines`;
				}
				if (details?.truncation) {
					const t = details.truncation;
					display += `\n[truncated ${t.outputLines ?? "?"}/${t.totalLines ?? "?"} lines]`;
				}
				return new Text(display, 0, 0);
			},
		});

		// ======== bash ========
		const bashDef = createBashToolDefinition(cwd);
		const executeBash: typeof bashDef.execute = async (toolCallId, params, signal, onUpdate, ctx) => {
			const command = typeof params.command === "string" ? params.command : "";
			const dangerousCommand = findDangerousShellCommand(command);
			if (dangerousCommand) {
				return {
					content: [{ type: "text", text: dangerousShellCommandError(dangerousCommand) }],
					isError: true,
				} as any;
			}
			const sensitivePath = findSensitiveShellReadPath(command);
			if (sensitivePath) {
				return {
					content: [{ type: "text", text: sensitiveReadError(sensitivePath) }],
					isError: true,
				} as any;
			}
			return bashDef.execute(toolCallId, params, signal, onUpdate, ctx);
		};
		pi.registerTool({
			name: bashDef.name,
			label: bashDef.label,
			description: bashDef.description,
			parameters: bashDef.parameters,
			promptSnippet: bashDef.promptSnippet,
			promptGuidelines: [
				...(bashDef.promptGuidelines ?? []),
				"Do not use bash for routine listing, reading, or searching; use ls/ls_many, read/read_many, or grep/grep_many instead.",
				"Never run git push --force. Ask for explicit approval before any history-rewriting push, and prefer --force-with-lease only after approval.",
			],
			execute: executeBash,
			renderCall(args: any, theme: any, context: any) {
				const mutationPreview = getBashFileMutationPreview(args?.command);
				if (mutationPreview) {
					const path = shortenPath(mutationPreview.path);
					const lines = lineCount(mutationPreview.content);
					const kindLabel = mutationPreview.kind === "Append" ? "Append" : "Write";
					return formatTreeCall(theme, kindLabel, [
						`${formatToolPath(path)} ${theme.fg("toolOutput", `(${lines} lines)`)}`,
					]);
				}
				return formatBashCall(args, theme, context.toolCallId, context.invalidate, context.argsComplete);
			},
			renderResult(result: any, { expanded }: any, theme: any, context: any) {
				const mutationPreview = getBashFileMutationPreview(context.args?.command);
				if (mutationPreview && !context.isError) {
					if (!expanded) return EMPTY;
					return new Text(mutationPreview.content, 0, 0);
				}

				if (shouldRenderAsToolError(context, result)) {
					return renderErrorText(result, theme);
				}

				if (!expanded) return EMPTY;

				let display = extractText(result.content);
				const details = result.details as BashToolDetails | undefined;
				if (details?.truncation) {
					const t = details.truncation;
					display += `\n[truncated ${t.outputLines ?? "?"}/${t.totalLines ?? "?"} lines]`;
					if (details.fullOutputPath) display += `\nsaved: ${details.fullOutputPath}`;
				}
				return new Text(display, 0, 0);
			},
		});

		// ======== grep ========
		const grepDef = createGrepToolDefinition(cwd);
		pi.registerTool({
			name: grepDef.name,
			label: grepDef.label,
			description: grepDef.description,
			parameters: grepDef.parameters,
			promptSnippet: grepDef.promptSnippet,
			promptGuidelines: grepDef.promptGuidelines,
			execute: grepDef.execute,
			renderCall(args: any, theme: any, context: any) {
				return formatGrepCall(args, theme, context.argsComplete);
			},
			renderResult(result: any, { expanded }: any, theme: any, context: any) {
				if (shouldRenderAsToolError(context, result)) {
					return renderErrorText(result, theme);
				}

				if (!expanded) return EMPTY;

				const text = extractText(result.content);
				const details = result.details as GrepToolDetails | undefined;

				let display = text;
				if (details?.matchLimitReached) display += "\n[limit reached]";
				return new Text(display, 0, 0);
			},
		});

		// ======== find ========
		const findDef = createFindToolDefinition(cwd);
		pi.registerTool({
			name: findDef.name,
			label: findDef.label,
			description: findDef.description,
			parameters: findDef.parameters,
			promptSnippet: findDef.promptSnippet,
			promptGuidelines: findDef.promptGuidelines,
			execute: findDef.execute,
			renderCall(args: any, theme: any) {
				return formatFindCall(args, theme);
			},
			renderResult(result: any, { expanded }: any, theme: any, context: any) {
				if (shouldRenderAsToolError(context, result)) {
					return renderErrorText(result, theme);
				}

				if (!expanded) return EMPTY;

				const text = extractText(result.content);
				const details = result.details as FindToolDetails | undefined;

				let display = text;
				if (details?.resultLimitReached) display += `\n[limit: ${details.resultLimitReached}]`;
				if (details?.truncation) {
					const t = details.truncation;
					display += `\n[truncated ${t.outputLines ?? "?"}/${t.totalLines ?? "?"}]`;
				}
				return new Text(display, 0, 0);
			},
		});

		// ======== ls ========
		const lsDef = createLsToolDefinition(cwd);
		pi.registerTool({
			name: lsDef.name,
			label: lsDef.label,
			description: lsDef.description,
			parameters: lsDef.parameters,
			promptSnippet: lsDef.promptSnippet,
			promptGuidelines: [
				...(lsDef.promptGuidelines ?? []),
				"Use ls_many instead of multiple ls calls when listing two or more directories.",
			],
			execute: lsDef.execute,
			renderCall(args: any, theme: any, context: any) {
				return formatLsCall(args, theme, context.argsComplete);
			},
			renderResult(result: any, { expanded }: any, theme: any, context: any) {
				if (shouldRenderAsToolError(context, result)) {
					return renderErrorText(result, theme);
				}

				if (!expanded) return EMPTY;

				const text = extractText(result.content);
				const details = result.details as LsToolDetails | undefined;

				let display = text;
				if (details?.entryLimitReached) display += `\n[limit: ${details.entryLimitReached}]`;
				if (details?.truncation) {
					const t = details.truncation;
					display += `\n[truncated ${t.outputLines ?? "?"}/${t.totalLines ?? "?"}]`;
				}
				return new Text(display, 0, 0);
			},
		});

		// ======== write ========
		const writeDef = createWriteToolDefinition(cwd);
		pi.registerTool({
			name: writeDef.name,
			label: writeDef.label,
			description: writeDef.description,
			parameters: writeDef.parameters,
			promptSnippet: writeDef.promptSnippet,
			promptGuidelines: writeDef.promptGuidelines,
			execute: writeDef.execute,
			renderShell: "self",
			renderCall(args: any, theme: any, context: any) {
				const rawPath = args?.path ?? args?.file_path;
				if (!rawPath && !context.argsComplete) return EMPTY;
				const path = rawPath ? shortenPath(rawPath) : context.argsComplete ? "?" : "...";
				const lines = args?.content ? lineCount(args.content) : 0;
				return formatTreeCall(theme, "Write", [
					`${formatToolPath(path)} ${theme.fg("toolOutput", `(${lines} lines)`)}`,
				]);
			},
			renderResult(result: any, { expanded }: any, theme: any, context: any) {
				const args = context.args as { path?: string; file_path?: string; content?: string };
				const content = args?.content ?? "";

				if (shouldRenderAsToolError(context, result)) {
					return renderErrorText(result, theme);
				}

				if (!expanded) return EMPTY;
				return new Text(content, 0, 0);
			},
		});

		// ======== edit ========
		const editDef = createEditToolDefinition(cwd);
		pi.registerTool({
			name: editDef.name,
			label: editDef.label,
			description: editDef.description,
			parameters: editDef.parameters,
			promptSnippet: editDef.promptSnippet,
			promptGuidelines: editDef.promptGuidelines,
			execute: editDef.execute,
			prepareArguments: (editDef as any).prepareArguments,
			renderShell: "self",
			renderCall(args: any, theme: any, context: any) {
				const rawPath = args?.path ?? args?.file_path;
				if (!rawPath && !context.argsComplete) return EMPTY;
				const path = rawPath ? shortenPath(rawPath) : context.argsComplete ? "?" : "...";
				const editCount = Array.isArray(args?.edits) ? args.edits.length : 0;
				const countLabel = editCount > 0 ? ` (${editCount} edit${editCount > 1 ? "s" : ""})` : "";
				return formatTreeCall(theme, "Edit", [
					`${formatToolPath(path)}${countLabel ? theme.fg("toolOutput", countLabel) : ""}`,
				]);
			},
			renderResult(result: any, { expanded }: any, theme: any, context: any) {
				if (shouldRenderAsToolError(context, result)) {
					return renderErrorText(result, theme);
				}

				const details = result.details as EditToolDetails | undefined;
				const diff = details?.diff;
				if (!diff || !expanded) return EMPTY;

				const comp = new Container();
				comp.addChild(new Spacer(1));
				comp.addChild(new Text(diff, 0, 0));
				return comp;
			},
		});
	});

	pi.on("session_shutdown", async () => {
		restoreToolVisibilityPatch();
	});
}
