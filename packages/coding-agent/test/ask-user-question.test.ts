import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { builtin as askUserQuestionBuiltin } from "../src/core/builtin-extensions/ask-user-question.ts";
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

type SelectWithInputResult = { selected?: string; customValue?: string; cancelled: boolean };

/**
 * 注册 ask_user_question 工具并返回其 execute 入口。
 * 通过假的 ExtensionAPI 捕获 registerTool，再触发 session_start 完成注册。
 */
async function registerAskUserQuestionTool() {
	// 指向不存在的目录，使开关状态读取走默认（启用），不受本机 state 文件影响。
	process.env.HOME = join(tmpdir(), `ask-user-question-test-${process.pid}`);

	let tool: any;
	let sessionStart: ((event: unknown, ctx: unknown) => Promise<void> | void) | undefined;

	const pix = {
		registerTool: (def: any) => {
			tool = def;
		},
		registerCommand: () => {},
		appendEntry: () => {},
		on: (event: string, handler: any) => {
			if (event === "session_start") sessionStart = handler;
		},
	} as any;

	askUserQuestionBuiltin(pix);
	await sessionStart?.({}, { hasUI: true });

	if (!tool) throw new Error("ask_user_question 工具未注册");
	return tool;
}

function makeCtx(selectWithInput: (...args: any[]) => Promise<SelectWithInputResult>) {
	return {
		hasUI: true,
		ui: { selectWithInput: vi.fn(selectWithInput) },
	} as any;
}

describe("ask_user_question tool integration", () => {
	it("以内嵌输入框选择器呈现选项，并传入正确的自定义输入索引", async () => {
		const tool = await registerAskUserQuestionTool();
		const ctx = makeCtx(async () => ({ selected: "继续", cancelled: false }));

		await tool.execute("call-1", { question: "怎么处理?", options: ["继续", "取消"] }, undefined, undefined, ctx);

		const presented = buildAskUserQuestionOptions(["继续", "取消"]);
		expect(ctx.ui.selectWithInput).toHaveBeenCalledTimes(1);
		const [, options, customInputIndex] = ctx.ui.selectWithInput.mock.calls[0];
		expect(options).toEqual(presented.options);
		expect(customInputIndex).toBe(presented.customInputIndex);
	});

	it("选中预设选项时回填 selected 且不标记为取消", async () => {
		// 回归 Bug：interactive 层若未把 optionIndex 映射成 selected，会被误判为取消。
		const tool = await registerAskUserQuestionTool();
		const ctx = makeCtx(async () => ({ selected: "继续", cancelled: false }));

		const result = await tool.execute(
			"call-2",
			{ question: "怎么处理?", options: ["继续", "取消"] },
			undefined,
			undefined,
			ctx,
		);

		expect(result.details).toMatchObject({ selected: "继续", cancelled: false });
		expect(result.details.customInput).toBeUndefined();
		expect(result.content[0].text).toBe("用户选择：继续");
	});

	it("自定义输入时回填 customValue 并标记 customInput", async () => {
		const tool = await registerAskUserQuestionTool();
		const ctx = makeCtx(async () => ({ customValue: "我的方案", cancelled: false }));

		const result = await tool.execute(
			"call-3",
			{ question: "怎么处理?", options: ["继续", "取消"] },
			undefined,
			undefined,
			ctx,
		);

		expect(result.details).toMatchObject({ selected: "我的方案", cancelled: false, customInput: true });
		expect(result.content[0].text).toBe("用户自定义输入：我的方案");
	});

	it("取消时标记 cancelled 且不带 selected", async () => {
		const tool = await registerAskUserQuestionTool();
		const ctx = makeCtx(async () => ({ cancelled: true }));

		const result = await tool.execute(
			"call-4",
			{ question: "怎么处理?", options: ["继续", "取消"] },
			undefined,
			undefined,
			ctx,
		);

		expect(result.details.cancelled).toBe(true);
		expect(result.details.selected).toBeUndefined();
		expect(result.content[0].text).toBe("用户已取消选择");
	});
});
