import { describe, expect, it } from "vitest";
import {
	ExtensionSelectorWithInputComponent,
	type SelectorWithInputResult,
} from "../src/modes/interactive/components/extension-selector-with-input.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

initTheme("dark");

// 按键转义序列（与 tui 默认 keybindings 一致）
const KEY = {
	up: "\x1b[A",
	down: "\x1b[B",
	enter: "\r",
	esc: "\x1b",
} as const;

interface Captured {
	select: SelectorWithInputResult | undefined;
	cancelled: boolean;
}

function makeSelector(options: string[], customInputIndex: number) {
	const captured: Captured = { select: undefined, cancelled: false };
	const component = new ExtensionSelectorWithInputComponent(
		"问题",
		options,
		(result) => {
			captured.select = result;
		},
		() => {
			captured.cancelled = true;
		},
		{ customInputIndex, customInputPlaceholder: "输入你的回复" },
	);
	return { component, captured };
}

describe("ExtensionSelectorWithInputComponent", () => {
	it("自定义输入行为空时按回车不提交、不取消", () => {
		// 选项：[继续, <自定义输入>, 取消]，默认聚焦第一项
		const { component, captured } = makeSelector(["继续", "自定义输入", "取消"], 1);

		// 移动到自定义输入行
		component.handleInput(KEY.down);
		expect(captured.select).toBeUndefined();
		expect(captured.cancelled).toBe(false);

		// 直接按回车（输入框为空）：不应提交也不应取消
		component.handleInput(KEY.enter);
		expect(captured.select).toBeUndefined();
		expect(captured.cancelled).toBe(false);
	});

	it("在自定义输入行打字后回车提交自定义内容", () => {
		const { component, captured } = makeSelector(["继续", "自定义输入", "取消"], 1);

		component.handleInput(KEY.down);
		// 打字（非控制键交给内嵌 Input）
		component.handleInput("m");
		component.handleInput("y");
		component.handleInput(KEY.enter);

		expect(captured.cancelled).toBe(false);
		expect(captured.select).toEqual({ customValue: "my", cancelled: false });
	});

	it("在自定义输入行按 Esc 才取消", () => {
		const { component, captured } = makeSelector(["继续", "自定义输入", "取消"], 1);

		component.handleInput(KEY.down);
		component.handleInput(KEY.esc);

		expect(captured.cancelled).toBe(true);
		expect(captured.select).toBeUndefined();
	});

	it("选中预设选项时按回车提交对应索引", () => {
		const { component, captured } = makeSelector(["继续", "自定义输入", "取消"], 1);

		// 默认在第一项，直接回车
		component.handleInput(KEY.enter);
		expect(captured.select).toEqual({ optionIndex: 0, cancelled: false });
		expect(captured.cancelled).toBe(false);
	});
});
