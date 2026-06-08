import { describe, expect, it } from "vitest";
import {
	ASK_USER_QUESTION_CUSTOM_INPUT_OPTION,
	type AskUserQuestionDetails,
	buildAskUserQuestionOptions,
	formatAskUserQuestionResultText,
	isAskUserQuestionCustomInputOption,
	normalizeAskUserQuestionInput,
} from "../src/core/builtin-extensions/lib/ask-user-question.ts";

describe("ask_user_question", () => {
	it("inserts custom input before cancel-like options and reports its index", () => {
		const presented = buildAskUserQuestionOptions(["继续", "取消"]);
		expect(presented.options).toEqual(["继续", ASK_USER_QUESTION_CUSTOM_INPUT_OPTION, "取消"]);
		expect(presented.customInputIndex).toBe(1);
		expect(presented.options[presented.customInputIndex]).toBe(ASK_USER_QUESTION_CUSTOM_INPUT_OPTION);
	});

	it("appends custom input when there is no cancel-like option", () => {
		const presented = buildAskUserQuestionOptions(["方案 A", "方案 B"]);
		expect(presented.options).toEqual(["方案 A", "方案 B", ASK_USER_QUESTION_CUSTOM_INPUT_OPTION]);
		expect(presented.customInputIndex).toBe(2);
	});

	it("deduplicates model-provided custom input options", () => {
		const presented = buildAskUserQuestionOptions(["继续", ASK_USER_QUESTION_CUSTOM_INPUT_OPTION, "不执行"]);
		expect(presented.options).toEqual(["继续", ASK_USER_QUESTION_CUSTOM_INPUT_OPTION, "不执行"]);
		expect(presented.customInputIndex).toBe(1);
	});

	it("matches cancel keywords exactly, not by prefix", () => {
		// 精确匹配：以取消词开头但语义不同的选项不再被当作取消项。
		const presented = buildAskUserQuestionOptions(["取消订阅功能", "确认"]);
		expect(presented.options).toEqual(["取消订阅功能", "确认", ASK_USER_QUESTION_CUSTOM_INPUT_OPTION]);
		expect(presented.customInputIndex).toBe(2);
	});

	it("recognizes only the built-in custom input option", () => {
		expect(isAskUserQuestionCustomInputOption(ASK_USER_QUESTION_CUSTOM_INPUT_OPTION)).toBe(true);
		expect(isAskUserQuestionCustomInputOption("自定义方案")).toBe(false);
	});

	it("keeps normalized model options separate from presented UI options", () => {
		const normalized = normalizeAskUserQuestionInput({
			question: "怎么处理?",
			options: ["继续", "取消"],
		});

		expect(normalized.ok).toBe(true);
		if (normalized.ok) {
			expect(normalized.value.options).toEqual(["继续", "取消"]);
			expect(buildAskUserQuestionOptions(normalized.value.options).options).toEqual([
				"继续",
				ASK_USER_QUESTION_CUSTOM_INPUT_OPTION,
				"取消",
			]);
		}
	});

	it("formats result text for selected, custom-input and cancelled states", () => {
		const base: AskUserQuestionDetails = { question: "q", options: ["继续", "取消"], cancelled: false };
		expect(formatAskUserQuestionResultText({ ...base, selected: "继续" })).toBe("用户选择：继续");
		expect(formatAskUserQuestionResultText({ ...base, selected: "自定义内容", customInput: true })).toBe(
			"用户自定义输入：自定义内容",
		);
		expect(formatAskUserQuestionResultText({ ...base, cancelled: true })).toBe("用户已取消选择");
	});
});
