import { type Focusable, getKeybindings, type MouseEvent, truncateToWidth, visibleWidth } from "@chengshiliu16/pix-tui";
import { theme } from "../theme/theme.ts";

export type UserMessageAction = "revert" | "copy" | "fork";

interface ActionOption {
	label: string;
	description: string;
	action: UserMessageAction;
}

// Mirrors opencode's "Message Actions" dialog
// (opencode/packages/tui/src/routes/session/dialog-message.tsx): each action shows a
// bold title plus a muted description, and the active row is drawn with a full-width
// background highlight rather than an arrow cursor.
const ACTION_OPTIONS: ActionOption[] = [
	{ label: "Revert", description: "undo messages and file changes", action: "revert" },
	{ label: "Copy", description: "message text to clipboard", action: "copy" },
	{ label: "Fork", description: "create a new session", action: "fork" },
];

const TITLE = "Message Actions";
const ESC_HINT = "esc"; // clickable cancel affordance, mirrors opencode
const PAD_LEFT = 2; // left/right margin inside the panel
const ROW_INDENT = 3; // option row indent (opencode uses paddingLeft ~3)
const COLUMN_GAP = 2; // gap between the title column and the description column
const MIN_DESCRIPTION_WIDTH = 8;

const TITLE_ROW = 1;
const OPTIONS_START_ROW = 3;

function padToWidth(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

/** Full-screen modal action dialog for clicked user messages. */
export class UserMessageActionDialogComponent implements Focusable {
	private selectedIndex = 0;
	readonly width = 52;
	private lastWidth = this.width;
	private readonly titleColumnWidth = ACTION_OPTIONS.reduce((max, o) => Math.max(max, visibleWidth(o.label)), 0);
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
		this.lastWidth = Math.max(40, width);
		return this.renderDialog(this.lastWidth);
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

	handleMouse(evt: MouseEvent, localY: number): boolean {
		// The TUI delivers free-motion events as hover (highlight only) and a
		// click as a single "up" via dispatchClick (highlight + commit). Returning
		// false on an unchanged hover suppresses a needless full-screen repaint.
		const hover = evt.action === "move";

		// Esc hint on the title row: a click cancels; hovering it does nothing.
		if (localY === TITLE_ROW) {
			if (!hover && this.isWithinEscHint(evt.x)) this.onCancel();
			return false;
		}

		const row = localY - OPTIONS_START_ROW;
		if (row < 0 || row >= ACTION_OPTIONS.length) return false;

		const changed = this.selectedIndex !== row;
		this.selectedIndex = row; // hover and click both move the highlight
		if (!hover) {
			this.onSelect(ACTION_OPTIONS[row].action); // commit on click
			return true;
		}
		return changed; // hover: repaint only when the highlighted row changes
	}

	private isWithinEscHint(x: number): boolean {
		const end = this.lastWidth - PAD_LEFT;
		return x >= end - ESC_HINT.length && x < end;
	}

	private renderDialog(width: number): string[] {
		const lines = [this.blankLine(width), this.titleBar(width), this.blankLine(width)];

		for (let i = 0; i < ACTION_OPTIONS.length; i++) {
			lines.push(this.optionLine(ACTION_OPTIONS[i], i === this.selectedIndex, width));
		}

		lines.push(this.blankLine(width));
		return lines;
	}

	private blankLine(width: number): string {
		return theme.bg("customMessageBg", " ".repeat(width));
	}

	private titleBar(width: number): string {
		const inner = width - PAD_LEFT * 2;
		const gap = Math.max(1, inner - visibleWidth(TITLE) - ESC_HINT.length);
		const content =
			" ".repeat(PAD_LEFT) +
			theme.bold(theme.fg("customMessageText", TITLE)) +
			" ".repeat(gap) +
			theme.fg("muted", ESC_HINT);
		return theme.bg("customMessageBg", padToWidth(content, width));
	}

	private optionLine(option: ActionOption, isSelected: boolean, width: number): string {
		const labelText = isSelected
			? theme.bold(theme.fg("accent", option.label))
			: theme.fg("customMessageText", option.label);
		const spacer = " ".repeat(this.titleColumnWidth - visibleWidth(option.label) + COLUMN_GAP);

		const descStart = ROW_INDENT + this.titleColumnWidth + COLUMN_GAP;
		const descMaxWidth = Math.max(MIN_DESCRIPTION_WIDTH, width - descStart - PAD_LEFT);
		const descRaw = truncateToWidth(option.description, descMaxWidth, "");
		const descText = isSelected ? theme.fg("text", descRaw) : theme.fg("muted", descRaw);

		const content = " ".repeat(ROW_INDENT) + labelText + spacer + descText;
		return theme.bg(isSelected ? "selectedBg" : "customMessageBg", padToWidth(content, width));
	}
}
