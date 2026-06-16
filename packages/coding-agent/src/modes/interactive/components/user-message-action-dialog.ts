import { type Focusable, getKeybindings, truncateToWidth, visibleWidth } from "@chengshiliu16/pix-tui";
import { theme } from "../theme/theme.ts";
import { keyText } from "./keybinding-hints.ts";

export type UserMessageAction = "revert" | "copy" | "fork";

interface ActionOption {
	label: string;
	action: UserMessageAction;
}

const ACTION_OPTIONS: ActionOption[] = [
	{ label: "Revert", action: "revert" },
	{ label: "Copy", action: "copy" },
	{ label: "Fork", action: "fork" },
];

function padToWidth(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function centerText(text: string, width: number): string {
	const left = Math.max(0, Math.floor((width - visibleWidth(text)) / 2));
	return " ".repeat(left) + text;
}

/** Full-screen modal action dialog for clicked user messages. */
export class UserMessageActionDialogComponent implements Focusable {
	private selectedIndex = 0;
	readonly width = 42;
	private readonly onSelect: (action: UserMessageAction) => void;
	private readonly onCancel: () => void;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
	}

	constructor(onSelect: (action: UserMessageAction) => void, onCancel: () => void) {
		this.onSelect = onSelect;
		this.onCancel = onCancel;
	}

	invalidate(): void {}

	render(width: number): string[] {
		return this.renderDialog(Math.max(24, width));
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.up")) {
			this.selectedIndex = this.selectedIndex === 0 ? ACTION_OPTIONS.length - 1 : this.selectedIndex - 1;
		} else if (kb.matches(keyData, "tui.select.down")) {
			this.selectedIndex = this.selectedIndex === ACTION_OPTIONS.length - 1 ? 0 : this.selectedIndex + 1;
		} else if (kb.matches(keyData, "tui.select.confirm")) {
			this.onSelect(ACTION_OPTIONS[this.selectedIndex].action);
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancel();
		}
	}

	handleMouse(_evt: { x: number }, localY: number): void {
		const row = localY;
		if (row < 3 || row >= 3 + ACTION_OPTIONS.length) return;

		this.selectedIndex = row - 3;
		this.onSelect(ACTION_OPTIONS[this.selectedIndex].action);
	}

	private renderDialog(width: number): string[] {
		const innerWidth = width - 2;
		const title = "User message";
		const top = `+${"-".repeat(innerWidth)}+`;
		const bottom = `+${"-".repeat(innerWidth)}+`;
		const lines = [
			top,
			this.boxLine(theme.bold(title), width),
			this.boxLine(theme.fg("muted", "Choose an action"), width),
		];

		for (let i = 0; i < ACTION_OPTIONS.length; i++) {
			const option = ACTION_OPTIONS[i];
			const prefix = i === this.selectedIndex ? "> " : "  ";
			const text = i === this.selectedIndex ? theme.bold(option.label) : option.label;
			lines.push(this.boxLine(prefix + text, width));
		}

		const hint = `${keyText("tui.select.confirm")}: select | ${keyText("tui.select.cancel")}: cancel`;
		lines.push(this.boxLine(theme.fg("muted", hint), width));
		lines.push(bottom);
		return lines.map((line) => theme.bg("customMessageBg", line));
	}

	private boxLine(content: string, width: number): string {
		const innerWidth = width - 2;
		const centered = truncateToWidth(centerText(content, innerWidth), innerWidth);
		return `|${padToWidth(centered, innerWidth)}|`;
	}
}
