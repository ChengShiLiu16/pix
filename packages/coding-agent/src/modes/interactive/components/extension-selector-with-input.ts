/**
 * 带内嵌输入框的选择器组件。
 *
 * 在选项列表的 customInputIndex 位置嵌入一个 inline Input，
 * 用户可以直接在该行输入文字，无需先选中再弹出独立输入框。
 * 其他行的行为与普通选择器一致。
 */

import { Container, type Focusable, getKeybindings, Input, Spacer, Text, type TUI } from "@chengshiliu16/pix-tui";
import { theme } from "../theme/theme.ts";
import { CountdownTimer } from "./countdown-timer.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

export interface ExtensionSelectorWithInputOptions {
	tui?: TUI;
	timeout?: number;
	onToggleToolsExpanded?: () => void;
	/** 选项列表中内嵌输入框的索引位置 */
	customInputIndex: number;
	/** 内嵌输入框的 placeholder */
	customInputPlaceholder?: string;
}

/** 选择结果：普通选项或自定义输入 */
export interface SelectorWithInputResult {
	/** 用户最终选择的选项索引（非自定义输入时） */
	optionIndex?: number;
	/** 用户自定义输入的值（选择自定义输入行时） */
	customValue?: string;
	/** 用户是否取消 */
	cancelled: boolean;
}

export class ExtensionSelectorWithInputComponent extends Container implements Focusable {
	private options: string[];
	private selectedIndex = 0;
	private customInputIndex: number;
	private customInputPlaceholder: string;
	private listContainer: Container;
	private customInput: Input;
	private onSelectCallback: (result: SelectorWithInputResult) => void;
	private onCancelCallback: () => void;
	private titleText: Text;
	private baseTitle: string;
	private countdown: CountdownTimer | undefined;
	private onToggleToolsExpanded: (() => void) | undefined;

	// Focusable 实现 - 将 focus 状态传递给内嵌 Input
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		// 仅当光标在自定义输入行时激活内嵌 Input 的 focus
		this.customInput.focused = value && this.selectedIndex === this.customInputIndex;
	}

	constructor(
		title: string,
		options: string[],
		onSelect: (result: SelectorWithInputResult) => void,
		onCancel: () => void,
		opts: ExtensionSelectorWithInputOptions,
	) {
		super();

		this.options = options;
		this.customInputIndex = opts.customInputIndex;
		this.customInputPlaceholder = opts.customInputPlaceholder ?? "";
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;
		this.onToggleToolsExpanded = opts.onToggleToolsExpanded;
		this.baseTitle = title;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		this.titleText = new Text(theme.fg("accent", theme.bold(title)), 1, 0);
		this.addChild(this.titleText);
		this.addChild(new Spacer(1));

		if (opts.timeout && opts.timeout > 0 && opts.tui) {
			this.countdown = new CountdownTimer(
				opts.timeout,
				opts.tui,
				(s) => this.titleText.setText(theme.fg("accent", theme.bold(`${this.baseTitle} (${s}s)`))),
				() => this.onCancelCallback(),
			);
		}

		this.customInput = new Input();
		this.customInput.focused = false;
		this.customInput.placeholder = this.customInputPlaceholder;

		this.listContainer = new Container();
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				rawKeyHint("↑↓", "navigate") +
					"  " +
					keyHint("tui.select.confirm", "select") +
					"  " +
					keyHint("tui.select.cancel", "cancel"),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());

		this.updateList();
	}

	private isCustomInputRow(index: number): boolean {
		return index === this.customInputIndex;
	}

	private updateList(): void {
		this.listContainer.clear();

		for (let i = 0; i < this.options.length; i++) {
			if (this.isCustomInputRow(i)) {
				// 自定义输入行：直接使用内嵌 Input 占整行，
				// 通过 Input.prefix 体现选中箭头（与其它选项行的“→ ”一致），
				// 避免 Container 垂直堆叠导致箭头与输入框分行。
				const isSelected = i === this.selectedIndex;
				// 前缀多一个空格，对齐其它选项行 Text 的 paddingX=1 左缩进
				this.customInput.prefix = isSelected ? ` ${theme.fg("accent", "→ ")}` : "   ";
				this.listContainer.addChild(this.customInput);

				// 更新 Input focus 状态
				this.customInput.focused = this._focused && isSelected;
			} else {
				const isSelected = i === this.selectedIndex;
				const text = isSelected
					? theme.fg("accent", "→ ") + theme.fg("accent", this.options[i])
					: `  ${theme.fg("text", this.options[i])}`;
				this.listContainer.addChild(new Text(text, 1, 0));
			}
		}
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();

		// 光标在自定义输入行时，j/k 应作为文字输入而非导航键，
		// 否则用户无法输入含 j/k 的内容（如 "ok"、"json"）。
		const onCustomInputRow = this.selectedIndex === this.customInputIndex;

		if (onCustomInputRow) {
			// 仅拦截导航/确认/取消等控制键，其余键交给 Input 处理
			if (
				kb.matches(keyData, "tui.select.up") ||
				kb.matches(keyData, "tui.select.down") ||
				kb.matches(keyData, "tui.select.cancel") ||
				kb.matches(keyData, "tui.select.confirm") ||
				keyData === "\n"
			) {
				// 这些键由选择器自己处理，不走 Input
			} else {
				// 其他键交给 Input 处理（文字输入、删除等）
				this.customInput.handleInput(keyData);
				return;
			}
		}

		if (kb.matches(keyData, "app.tools.expand")) {
			this.onToggleToolsExpanded?.();
		} else if (kb.matches(keyData, "tui.select.up") || (!onCustomInputRow && keyData === "k")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.down") || (!onCustomInputRow && keyData === "j")) {
			this.selectedIndex = Math.min(this.options.length - 1, this.selectedIndex + 1);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			if (this.isCustomInputRow(this.selectedIndex)) {
				// 自定义输入行：取出 Input 的值
				const value = this.customInput.getValue().trim();
				if (value.length > 0) {
					this.onSelectCallback({ customValue: value, cancelled: false });
				}
				// 输入为空时不提交、不取消，停留在原地等待输入；取消统一走 Esc
			} else {
				this.onSelectCallback({ optionIndex: this.selectedIndex, cancelled: false });
			}
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
		}
	}

	dispose(): void {
		this.countdown?.dispose();
	}
}
