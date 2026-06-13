import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Editor, type EditorOptions, type EditorTheme, type TUI } from "@chengshiliu16/pix-tui";
import { getAgentDir } from "../../../config.ts";
import {
	type EditorInputThemeLike,
	formatEditorInputRenderLines,
} from "../../../core/builtin-extensions/lib/editor-input-style.ts";
import {
	createInputHistoryFile,
	INPUT_HISTORY_LIMIT,
	mergeInputHistoryEntries,
	parseInputHistoryFile,
	recordInputHistoryEntry,
} from "../../../core/builtin-extensions/lib/persistent-input-history.ts";
import type { AppKeybinding, KeybindingsManager } from "../../../core/keybindings.ts";
import { theme } from "../theme/theme.ts";

// ---------------------------------------------------------------------------
// Persistent input history store
// ---------------------------------------------------------------------------

export type HistoryStore = {
	load(): string[];
	record(text: string, fallbackEntries: readonly unknown[]): string[];
};

function hasErrorCode(error: unknown, code: string): boolean {
	return (
		typeof error === "object" && error !== null && "code" in error && (error as Record<string, unknown>).code === code
	);
}

export function createHistoryStore(historyPath: string): HistoryStore {
	// Always read the file fresh rather than caching: the history file is shared
	// across every session/process, so a cached snapshot would be stale and the
	// next save() would clobber entries written by other sessions in the
	// meantime (last-writer-wins data loss when switching between sessions).
	function load(): string[] {
		try {
			return parseInputHistoryFile(JSON.parse(readFileSync(historyPath, "utf8")));
		} catch (error) {
			if (hasErrorCode(error, "ENOENT")) {
				return [];
			}
			console.warn(
				"[persistent-input-history] failed to load history:",
				error instanceof Error ? error.message : error,
			);
			return [];
		}
	}

	function save(nextEntries: readonly string[]): void {
		try {
			writeFileSync(historyPath, `${JSON.stringify(createInputHistoryFile(nextEntries), null, "\t")}\n`, "utf8");
		} catch (error) {
			console.warn(
				"[persistent-input-history] failed to save history:",
				error instanceof Error ? error.message : error,
			);
		}
	}

	return {
		load,
		record(text, fallbackEntries) {
			const mergedEntries = mergeInputHistoryEntries(load(), fallbackEntries, INPUT_HISTORY_LIMIT);
			const nextEntries = recordInputHistoryEntry(mergedEntries, text, INPUT_HISTORY_LIMIT);
			save(nextEntries);
			return nextEntries;
		},
	};
}

function getEditorHistory(editor: { history?: unknown }): string[] {
	return Array.isArray((editor as Record<string, unknown>).history)
		? ((editor as Record<string, unknown>).history as string[])
		: [];
}

function setEditorHistory(editor: { history?: unknown; historyIndex?: unknown }, entries: readonly string[]): void {
	(editor as Record<string, unknown>).history = [...entries];
	if (!Number.isInteger((editor as Record<string, unknown>).historyIndex)) {
		(editor as Record<string, unknown>).historyIndex = -1;
	}
}

function syncEditorHistory(editor: { history?: unknown; historyIndex?: unknown }, store: HistoryStore): void {
	const nextEntries = mergeInputHistoryEntries(store.load(), getEditorHistory(editor), INPUT_HISTORY_LIMIT);
	setEditorHistory(editor, nextEntries);
}

// Shared history store singleton (lazy-initialized)
let sharedHistoryStore: HistoryStore | undefined;

function getHistoryStore(): HistoryStore {
	if (!sharedHistoryStore) {
		const historyPath = join(getAgentDir(), "input-history.json");
		sharedHistoryStore = createHistoryStore(historyPath);
	}
	return sharedHistoryStore;
}

// ---------------------------------------------------------------------------
// CustomEditor
// ---------------------------------------------------------------------------

/**
 * Custom editor that handles app-level keybindings for coding-agent.
 * Includes built-in editor-input-style and persistent-input-history behavior.
 */
export class CustomEditor extends Editor {
	private keybindings: KeybindingsManager;
	public actionHandlers: Map<AppKeybinding, () => void> = new Map();

	// Special handlers that can be dynamically replaced
	public onEscape?: () => void;
	public onCtrlD?: () => void;
	public onPasteImage?: () => void;
	/** Handler for extension-registered shortcuts. Returns true if handled. */
	public onExtensionShortcut?: (data: string) => boolean;

	constructor(tui: TUI, editorTheme: EditorTheme, keybindings: KeybindingsManager, options?: EditorOptions) {
		super(tui, editorTheme, options);
		this.keybindings = keybindings;

		// Set up persistent history: override navigateHistory at the instance level
		// so that before each navigation the in-memory history is synced from the
		// persistent store (picks up entries from other sessions/processes).
		const store = getHistoryStore();
		const originalNavigateHistory = (Editor.prototype as unknown as Record<string, unknown>).navigateHistory as (
			this: Editor,
			direction: number,
		) => void;
		(this as unknown as Record<string, unknown>).navigateHistory = (direction: number): void => {
			syncEditorHistory(this as unknown as Record<string, unknown>, store);
			originalNavigateHistory.call(this, direction);
		};
	}

	/**
	 * Register a handler for an app action.
	 */
	onAction(action: AppKeybinding, handler: () => void): void {
		this.actionHandlers.set(action, handler);
	}

	handleInput(data: string): void {
		// Check extension-registered shortcuts first
		if (this.onExtensionShortcut?.(data)) {
			return;
		}

		// Check for paste image keybinding
		if (this.keybindings.matches(data, "app.clipboard.pasteImage")) {
			this.onPasteImage?.();
			return;
		}

		// Check app keybindings first

		// Escape/interrupt - only if autocomplete is NOT active
		if (this.keybindings.matches(data, "app.interrupt")) {
			if (!this.isShowingAutocomplete()) {
				// Use dynamic onEscape if set, otherwise registered handler
				const handler = this.onEscape ?? this.actionHandlers.get("app.interrupt");
				if (handler) {
					handler();
					return;
				}
			}
			// Let parent handle escape for autocomplete cancellation
			super.handleInput(data);
			return;
		}

		// Exit (Ctrl+D) - only when editor is empty
		if (this.keybindings.matches(data, "app.exit")) {
			if (this.getText().length === 0) {
				const handler = this.onCtrlD ?? this.actionHandlers.get("app.exit");
				if (handler) handler();
				return;
			}
			// Fall through to editor handling for delete-char-forward when not empty
		}

		// Check all other app actions
		for (const [action, handler] of this.actionHandlers) {
			if (action !== "app.interrupt" && action !== "app.exit" && this.keybindings.matches(data, action)) {
				handler();
				return;
			}
		}

		// Pass to parent for editor handling
		super.handleInput(data);
	}

	// -----------------------------------------------------------------------
	// Built-in editor-input-style: apply user accent colouring to render output
	// -----------------------------------------------------------------------

	override render(width: number): string[] {
		const lines = super.render(width);
		return formatEditorInputRenderLines(lines, theme as EditorInputThemeLike);
	}

	// -----------------------------------------------------------------------
	// Built-in persistent-input-history: persist addToHistory to file
	// -----------------------------------------------------------------------

	override addToHistory(text: string): void {
		const trimmed = text.trim();
		if (!trimmed) {
			super.addToHistory(text);
			return;
		}

		super.addToHistory(trimmed);
		const store = getHistoryStore();
		const nextEntries = store.record(text, getEditorHistory(this as unknown as Record<string, unknown>));
		setEditorHistory(this as unknown as Record<string, unknown>, nextEntries);
	}
}
