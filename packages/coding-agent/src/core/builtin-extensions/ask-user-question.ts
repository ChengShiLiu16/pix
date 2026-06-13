/**
 * ask_user_question — 通用用户确认/选择工具。
 *
 * 设计目标：
 * - 独立扩展，后续可单独拆包。
 * - 默认启用，可通过 /ask-user-question on|off|status 持久切换。
 * - 关闭后下次加载不注册工具，也不暴露触发提示。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Text } from "@chengshiliu16/pix-tui";
import { Type } from "typebox";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "../../index.ts";
import {
	ASK_USER_QUESTION_PROMPT_GUIDELINES,
	ASK_USER_QUESTION_STATE_FILE,
	ASK_USER_QUESTION_TOOL_NAME,
	type AskUserQuestionDetails,
	type AskUserQuestionInput,
	askUserQuestionStatusText,
	buildAskUserQuestionLabel,
	buildAskUserQuestionOptions,
	DEFAULT_ASK_USER_QUESTION_ENABLED,
	disabledToolMessage,
	formatAskUserQuestionResultText,
	normalizeAskUserQuestionInput,
	parseAskUserQuestionCommand,
} from "./lib/ask-user-question.ts";

const STATE_TYPE = "ask-user-question-state";
const EMPTY = new Text("", 0, 0);

const schema = Type.Object({
	question: Type.String({
		description: "要向用户确认的问题。必须清晰说明下一步将做什么，以及为什么需要用户选择。",
	}),
	options: Type.Array(Type.String(), {
		minItems: 2,
		maxItems: 8,
		description: "可选项。保持简短、互斥、可执行；如果用户可以拒绝，包含“取消”或“不执行”。",
	}),
	details: Type.Optional(
		Type.String({
			description: "可选补充说明。用于展示风险、影响范围或即将执行的命令。",
		}),
	),
});

function statePath(): string {
	const home = process.env.HOME?.trim() || homedir();
	return join(home, ".pix", "agent", "state", ASK_USER_QUESTION_STATE_FILE);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function readEnabled(): Promise<boolean> {
	try {
		const raw = await readFile(statePath(), "utf8");
		const parsed = JSON.parse(raw) as { enabled?: unknown };
		return typeof parsed.enabled === "boolean" ? parsed.enabled : DEFAULT_ASK_USER_QUESTION_ENABLED;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return DEFAULT_ASK_USER_QUESTION_ENABLED;
		}
		throw new Error(`读取 ask_user_question 开关失败：${errorMessage(error)}`);
	}
}

async function writeEnabled(enabled: boolean): Promise<void> {
	const file = statePath();
	try {
		await mkdir(dirname(file), { recursive: true });
		await writeFile(file, `${JSON.stringify({ enabled }, null, 2)}\n`, "utf8");
	} catch (error) {
		throw new Error(`保存 ask_user_question 开关失败：${errorMessage(error)}`);
	}
}

function unregisterToolIfPossible(pix: ExtensionAPI): boolean {
	const candidate = pix as ExtensionAPI & {
		unregisterTool?: (name: string) => void;
		removeTool?: (name: string) => void;
	};
	if (typeof candidate.unregisterTool === "function") {
		candidate.unregisterTool(ASK_USER_QUESTION_TOOL_NAME);
		return true;
	}
	if (typeof candidate.removeTool === "function") {
		candidate.removeTool(ASK_USER_QUESTION_TOOL_NAME);
		return true;
	}
	return false;
}

function renderToolText(
	text: string,
	theme: { fg?: (name: string, text: string) => string },
	color = "toolOutput",
): Text {
	const styled = typeof theme.fg === "function" ? theme.fg(color, text) : text;
	return new Text(styled, 0, 0);
}

export function builtin(pix: ExtensionAPI) {
	let enabled = DEFAULT_ASK_USER_QUESTION_ENABLED;

	const registerQuestionTool = () => {
		pix.registerTool<typeof schema, AskUserQuestionDetails>({
			name: ASK_USER_QUESTION_TOOL_NAME,
			label: "Ask User Question",
			description:
				"向用户提出一个真实阻塞的确认/选择问题，并等待用户选择后再继续。适用于通用决策、风险确认和多方案选择。",
			promptSnippet: "Ask the user a blocking question when real confirmation or choice is required.",
			promptGuidelines: ASK_USER_QUESTION_PROMPT_GUIDELINES,
			parameters: schema,
			renderCall(args: Partial<AskUserQuestionInput>, theme: any) {
				const question = typeof args.question === "string" ? args.question.trim() : "等待用户选择";
				return renderToolText(`? ${question}`, theme, "toolTitle");
			},
			renderResult(
				result: AgentToolResult<AskUserQuestionDetails>,
				_opts: unknown,
				theme: any,
				context: { isError?: boolean },
			) {
				if (context.isError || (result as any).isError) {
					const text = result.content?.[0]?.type === "text" ? result.content[0].text : "ask_user_question failed";
					return renderToolText(text, theme, "error");
				}
				const details = result.details;
				if (!details) return EMPTY;
				return renderToolText(formatAskUserQuestionResultText(details), theme);
			},
			async execute(
				_toolCallId: string,
				params: AskUserQuestionInput,
				_signal: AbortSignal | undefined,
				_onUpdate: unknown,
				ctx: ExtensionContext,
			): Promise<AgentToolResult<AskUserQuestionDetails>> {
				if (!enabled) {
					return {
						content: [{ type: "text", text: disabledToolMessage() }],
						isError: true,
					} as any;
				}

				if (!ctx.hasUI) {
					return {
						content: [
							{
								type: "text",
								text: "ask_user_question 需要 Pix 交互 UI。请用普通文本提问并停止，等待用户回复。",
							},
						],
						isError: true,
					} as any;
				}

				const normalized = normalizeAskUserQuestionInput(params);
				if (!normalized.ok) {
					return {
						content: [{ type: "text", text: normalized.message }],
						isError: true,
					} as any;
				}

				const { question, details, options } = normalized.value;
				const presented = buildAskUserQuestionOptions(options);

				// 使用内嵌输入框的选择器，用户可以直接在“自定义输入”行输入文字
				const result = await ctx.ui.selectWithInput(
					buildAskUserQuestionLabel(question, details),
					presented.options,
					presented.customInputIndex,
					"输入你的回复",
				);

				let selected: string | undefined;
				let choseCustomInput = false;

				if (result.cancelled) {
					selected = undefined;
				} else if (result.customValue !== undefined) {
					selected = result.customValue;
					choseCustomInput = true;
				} else if (result.selected !== undefined) {
					selected = result.selected;
				}

				const cancelled = !selected;
				const toolDetails: AskUserQuestionDetails = {
					question,
					options: presented.options,
					selected,
					cancelled,
				};
				if (choseCustomInput && !cancelled) {
					toolDetails.customInput = true;
				}

				return {
					content: [{ type: "text", text: formatAskUserQuestionResultText(toolDetails) }],
					details: toolDetails,
				};
			},
		});
	};

	pix.registerCommand("ask-user-question", {
		description: "开启、关闭或查看 ask_user_question 工具状态",
		handler: async (args, ctx) => {
			const action = parseAskUserQuestionCommand(args);
			if (!action) {
				ctx.ui.notify("用法：/ask-user-question on|off|status", "warning");
				return;
			}

			if (action === "status") {
				enabled = await readEnabled();
				ctx.ui.notify(askUserQuestionStatusText(enabled), "info");
				return;
			}

			enabled = action === "on";
			await writeEnabled(enabled);
			pix.appendEntry(STATE_TYPE, { enabled });

			if (enabled) {
				registerQuestionTool();
				ctx.ui.notify("ask_user_question 已启用。", "info");
				return;
			}

			const removed = unregisterToolIfPossible(pix);
			const suffix = removed
				? "工具已从当前注册表移除。"
				: "当前 Pix 版本未暴露 unregister API；本会话内残留调用会被拒绝，执行 /reload 后会从工具列表彻底移除。";
			ctx.ui.notify(`ask_user_question 已关闭。${suffix}`, "info");
		},
	});

	pix.on("session_start", async (_event, ctx) => {
		try {
			enabled = await readEnabled();
			if (enabled) registerQuestionTool();
		} catch (error) {
			enabled = false;
			if (ctx.hasUI) ctx.ui.notify(errorMessage(error), "warning");
		}
	});
}
