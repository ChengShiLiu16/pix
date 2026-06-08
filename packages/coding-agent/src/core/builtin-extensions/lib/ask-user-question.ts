export const ASK_USER_QUESTION_TOOL_NAME = "ask_user_question";
export const ASK_USER_QUESTION_STATE_FILE = "ask-user-question.json";
export const DEFAULT_ASK_USER_QUESTION_ENABLED = true;
export const MAX_QUESTION_OPTIONS = 8;
export const ASK_USER_QUESTION_CUSTOM_INPUT_OPTION = "自定义输入";

export interface AskUserQuestionInput {
	question: string;
	options: string[];
	details?: string;
}

export interface NormalizedAskUserQuestion {
	question: string;
	options: string[];
	details?: string;
}

export interface AskUserQuestionDetails {
	question: string;
	options: string[];
	selected?: string;
	cancelled: boolean;
	customInput?: boolean;
}

export type AskUserQuestionCommandAction = "on" | "off" | "status";

export const ASK_USER_QUESTION_PROMPT_GUIDELINES = [
	"当继续执行需要真实用户决策、选择或确认时，使用 ask_user_question；不要用普通文本假装已经阻塞等待用户。",
	"典型触发：用户明确说“确认后再做/让我选/先问我”；将执行不可逆、外部可见或高风险操作；存在多个有效业务方案；信息不足且继续会引入猜测。",
	"典型不触发：只读查看、搜索、diff/status、低风险且用户已明确授权的实现细节、常规测试或格式化。",
	"调用 ask_user_question 的同一轮 assistant 消息不得调用任何其他工具；先问一个问题，等待工具结果，再继续。",
	"选项应简短、互斥、可执行，通常 2-5 个；如果用户可以拒绝，提供“取消”或“不执行”选项。",
	"不要手动添加“自定义输入”选项；Pi UI 会自动在取消类选项前提供用户自定义输入入口。",
	"拿到工具结果后，只有当 selected 明确授权后才能继续；cancelled=true 或未选择时必须停止并说明已取消。",
];

export function normalizeAskUserQuestionInput(
	input: AskUserQuestionInput,
): { ok: true; value: NormalizedAskUserQuestion } | { ok: false; message: string } {
	const question = typeof input.question === "string" ? input.question.trim() : "";
	if (!question) return { ok: false, message: "question 不能为空" };

	if (!Array.isArray(input.options)) {
		return { ok: false, message: "options 必须是字符串数组" };
	}

	const options = input.options.map((option) => option.trim()).filter(Boolean);
	if (options.length < 2) return { ok: false, message: "至少需要 2 个非空选项" };
	if (options.length > MAX_QUESTION_OPTIONS) {
		return { ok: false, message: `最多支持 ${MAX_QUESTION_OPTIONS} 个选项` };
	}

	const seen = new Set<string>();
	for (const option of options) {
		if (seen.has(option)) return { ok: false, message: `选项重复：${option}` };
		seen.add(option);
	}

	const details = typeof input.details === "string" && input.details.trim() ? input.details.trim() : undefined;

	return {
		ok: true,
		value: {
			question,
			options,
			details,
		},
	};
}

// 取消类选项关键字：自定义输入入口会插在第一个取消类选项之前，使“取消”保持在末尾。
// 集中维护、可扩展；采用精确匹配（规范化后全等），避免前缀匹配带来的中英文口径不一致与误判。
export const CANCEL_OPTION_KEYWORDS: readonly string[] = ["cancel", "abort", "取消", "不执行", "不继续", "停止"];

function isCancelOption(option: string): boolean {
	return CANCEL_OPTION_KEYWORDS.includes(option.trim().toLowerCase());
}

export function isAskUserQuestionCustomInputOption(option: string): boolean {
	return option.trim() === ASK_USER_QUESTION_CUSTOM_INPUT_OPTION;
}

export interface PresentedAskUserQuestionOptions {
	options: string[];
	customInputIndex: number;
}

export function buildAskUserQuestionOptions(options: string[]): PresentedAskUserQuestionOptions {
	const withoutCustomInput = options.filter((option) => !isAskUserQuestionCustomInputOption(option));
	const cancelIndex = withoutCustomInput.findIndex(isCancelOption);
	const customInputIndex = cancelIndex === -1 ? withoutCustomInput.length : cancelIndex;
	const result = [...withoutCustomInput];
	result.splice(customInputIndex, 0, ASK_USER_QUESTION_CUSTOM_INPUT_OPTION);
	return { options: result, customInputIndex };
}

export function formatAskUserQuestionResultText(details: AskUserQuestionDetails): string {
	if (details.cancelled) return "用户已取消选择";
	return details.customInput ? `用户自定义输入：${details.selected}` : `用户选择：${details.selected}`;
}

export function buildAskUserQuestionLabel(question: string, details?: string): string {
	return details ? `${question}\n\n${details}` : question;
}

export function parseAskUserQuestionCommand(args?: string): AskUserQuestionCommandAction | undefined {
	const command = (args ?? "").trim().toLowerCase();
	if (!command || command === "status") return "status";
	if (["on", "enable", "enabled", "true", "1"].includes(command)) return "on";
	if (["off", "disable", "disabled", "false", "0"].includes(command)) return "off";
	return undefined;
}

export function askUserQuestionStatusText(enabled: boolean): string {
	return enabled
		? "ask_user_question 已启用：模型可在需要真实用户确认/选择时调用该工具。"
		: "ask_user_question 已关闭：下次加载时不会注册工具，也不会提供触发提示。";
}

export function disabledToolMessage(): string {
	return "ask_user_question 当前已关闭。不要继续调用该工具；如果确实需要用户确认，请用普通文本提问并停止。";
}
