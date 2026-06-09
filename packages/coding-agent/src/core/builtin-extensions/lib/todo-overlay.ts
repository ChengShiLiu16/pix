import { type TUI, truncateToWidth } from "@chengshiliu16/pix-tui";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import type { ExtensionUIContext } from "../../index.ts";
import { countByStatus, type TodoItem, type TodoState } from "./todo-state.ts";

export const WIDGET_ID = "todo-list";
export const MAX_WIDGET_LINES = 12;

function overlayGlyph(status: TodoItem["status"], theme: Theme): string {
	switch (status) {
		case "pending":
			return theme.fg("dim", "●");
		case "in_progress":
			return theme.fg("warning", "◐");
		case "completed":
			return theme.fg("success", "✓");
	}
}

function formatTaskLine(task: TodoItem, theme: Theme): string {
	const glyph = overlayGlyph(task.status, theme);
	const subjectColor = task.status === "completed" ? "dim" : "text";
	let subject = theme.fg(subjectColor, task.text);
	if (task.status === "completed") {
		subject = theme.strikethrough(subject);
	}
	let line = `${glyph} ${subject}`;
	if (task.status === "in_progress" && task.activeForm) {
		line += ` ${theme.fg("dim", `(${task.activeForm})`)}`;
	}
	return line;
}

function buildLayout(tasks: TodoItem[], maxBodyLines: number): { visible: TodoItem[]; hidden: number } {
	if (tasks.length <= maxBodyLines) {
		return { visible: tasks, hidden: 0 };
	}
	return {
		visible: tasks.slice(0, maxBodyLines),
		hidden: tasks.length - maxBodyLines,
	};
}

export class TodoOverlay {
	private uiCtx: ExtensionUIContext | undefined;
	private widgetRegistered = false;
	private tui: TUI | undefined;
	private getState: () => TodoState;

	constructor(getState: () => TodoState) {
		this.getState = getState;
	}

	setUICtx(ctx: ExtensionUIContext): void {
		if (ctx !== this.uiCtx) {
			this.uiCtx = ctx;
			this.widgetRegistered = false;
			this.tui = undefined;
		}
	}

	update(): void {
		if (!this.uiCtx) return;
		const state = this.getState();

		if (state.todos.length === 0) {
			if (this.widgetRegistered) {
				this.uiCtx.setWidget(WIDGET_ID, undefined);
				this.widgetRegistered = false;
				this.tui = undefined;
			}
			return;
		}

		if (!this.widgetRegistered) {
			this.uiCtx.setWidget(
				WIDGET_ID,
				(tui, theme) => {
					this.tui = tui;
					return {
						render: (width: number) => this.renderWidget(theme, width),
						invalidate: () => {
							this.widgetRegistered = false;
							this.tui = undefined;
						},
					};
				},
				{ placement: "aboveEditor" },
			);
			this.widgetRegistered = true;
		} else {
			this.tui?.requestRender();
		}
	}

	dispose(): void {
		if (this.uiCtx) this.uiCtx.setWidget(WIDGET_ID, undefined);
		this.widgetRegistered = false;
		this.tui = undefined;
		this.uiCtx = undefined;
	}

	private renderWidget(theme: Theme, width: number): string[] {
		const state = this.getState();
		if (state.todos.length === 0) return [];

		const truncate = (line: string): string => truncateToWidth(line, width, "…");
		const counts = countByStatus(state);
		const hasActive = state.todos.some((t) => t.status === "in_progress");
		const headingColor = hasActive ? "accent" : "dim";
		const headingIcon = hasActive ? "◐" : "●";
		const heading = truncate(
			`${theme.fg(headingColor, headingIcon)} ${theme.fg(headingColor, `计划 · ${counts.completed}/${counts.total}`)}`,
		);

		const lines: string[] = [heading];
		const layout = buildLayout(state.todos, MAX_WIDGET_LINES - 1);
		for (const task of layout.visible) {
			lines.push(truncate(`${theme.fg("dim", "├─")} ${formatTaskLine(task, theme)}`));
		}

		if (layout.hidden === 0) {
			const last = lines.length - 1;
			lines[last] = lines[last]!.replace("├─", "└─");
			return lines;
		}

		lines.push(truncate(`${theme.fg("dim", "└─")} ${theme.fg("dim", `+${layout.hidden} more`)}`));
		return lines;
	}
}
