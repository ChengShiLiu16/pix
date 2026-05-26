import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionAPI } from "../../index.ts";
import {
	createInputHistoryFile,
	INPUT_HISTORY_LIMIT,
	mergeInputHistoryEntries,
	parseInputHistoryFile,
	recordInputHistoryEntry,
} from "./lib/persistent-input-history.ts";

const PI_INTERNAL_MODULES = {
	customEditor: "dist/modes/interactive/components/custom-editor.js",
} as const;

const PATCH_STATE_KEY = Symbol.for("pi.extensions.persistent-input-history-patch.v1");

type PersistentHistoryEditor = {
	history?: unknown;
	historyIndex?: unknown;
	addToHistory(text: string): void;
	navigateHistory(direction: number): void;
};

type CustomEditorPrototype = PersistentHistoryEditor;

type PatchState = {
	prototype: CustomEditorPrototype;
	originalAddToHistory: (text: string) => void;
	originalNavigateHistory: (direction: number) => void;
	patchedAddToHistory: (text: string) => void;
	patchedNavigateHistory: (direction: number) => void;
};

type HistoryStore = {
	load(): string[];
	record(text: string, fallbackEntries: readonly unknown[]): string[];
};

function agentRootFromImportUrl(importUrl: string): string {
	return dirname(dirname(fileURLToPath(importUrl)));
}

function getPackageRoot(packageName: string): string {
	const entryUrl = import.meta.resolve(packageName);
	const entryPath = fileURLToPath(entryUrl);
	return dirname(dirname(entryPath));
}

function resolveInternalModuleUrl(relativePath: string): string {
	const packageRoot = getPackageRoot("@earendil-works/pi-coding-agent");
	return pathToFileURL(join(packageRoot, relativePath)).href;
}

async function importInternal<TModule>(relativePath: string): Promise<TModule> {
	return (await import(resolveInternalModuleUrl(relativePath))) as TModule;
}

function getPatchState(): PatchState | undefined {
	return (globalThis as Record<symbol, PatchState | undefined>)[PATCH_STATE_KEY];
}

function setPatchState(state: PatchState | undefined): void {
	(globalThis as Record<symbol, PatchState | undefined>)[PATCH_STATE_KEY] = state;
}

function hasErrorCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function getEditorHistory(editor: PersistentHistoryEditor): string[] {
	return Array.isArray(editor.history) ? editor.history : [];
}

function setEditorHistory(editor: PersistentHistoryEditor, entries: readonly string[]): void {
	editor.history = [...entries];
	if (!Number.isInteger(editor.historyIndex)) {
		editor.historyIndex = -1;
	}
}

function createHistoryStore(historyPath: string): HistoryStore {
	let loaded = false;
	let entries: string[] = [];

	function load(): string[] {
		if (loaded) return entries;
		loaded = true;

		try {
			entries = parseInputHistoryFile(JSON.parse(readFileSync(historyPath, "utf8")));
		} catch (error) {
			if (hasErrorCode(error, "ENOENT")) {
				entries = [];
				return entries;
			}
			console.warn(
				"[persistent-input-history] failed to load history:",
				error instanceof Error ? error.message : error,
			);
			entries = [];
		}

		return entries;
	}

	function save(nextEntries: readonly string[]): void {
		entries = [...nextEntries];
		loaded = true;
		try {
			writeFileSync(historyPath, `${JSON.stringify(createInputHistoryFile(entries), null, "\t")}\n`, "utf8");
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

function syncEditorHistory(editor: PersistentHistoryEditor, store: HistoryStore): void {
	const nextEntries = mergeInputHistoryEntries(store.load(), getEditorHistory(editor), INPUT_HISTORY_LIMIT);
	setEditorHistory(editor, nextEntries);
}

async function installPersistentInputHistoryPatch(store: HistoryStore): Promise<void> {
	const existing = getPatchState();
	if (existing && existing.prototype.addToHistory === existing.patchedAddToHistory) return;

	const { CustomEditor } = await importInternal<{ CustomEditor: { prototype: CustomEditorPrototype } }>(
		PI_INTERNAL_MODULES.customEditor,
	);
	const prototype = CustomEditor.prototype;
	const originalAddToHistory = existing?.originalAddToHistory ?? prototype.addToHistory;
	const originalNavigateHistory = existing?.originalNavigateHistory ?? prototype.navigateHistory;
	const patchedAddToHistory = function patchedPersistentAddToHistory(
		this: PersistentHistoryEditor,
		text: string,
	): void {
		const trimmed = text.trim();
		if (!trimmed) {
			originalAddToHistory.call(this, text);
			return;
		}

		originalAddToHistory.call(this, trimmed);
		const nextEntries = store.record(text, getEditorHistory(this));
		setEditorHistory(this, nextEntries);
	};
	const patchedNavigateHistory = function patchedPersistentNavigateHistory(
		this: PersistentHistoryEditor,
		direction: number,
	): void {
		syncEditorHistory(this, store);
		originalNavigateHistory.call(this, direction);
	};

	prototype.addToHistory = patchedAddToHistory;
	prototype.navigateHistory = patchedNavigateHistory;
	setPatchState({
		prototype,
		originalAddToHistory,
		originalNavigateHistory,
		patchedAddToHistory,
		patchedNavigateHistory,
	});
}

function restorePersistentInputHistoryPatch(): void {
	const state = getPatchState();
	if (!state) return;
	if (state.prototype.addToHistory === state.patchedAddToHistory) {
		state.prototype.addToHistory = state.originalAddToHistory;
	}
	if (state.prototype.navigateHistory === state.patchedNavigateHistory) {
		state.prototype.navigateHistory = state.originalNavigateHistory;
	}
	setPatchState(undefined);
}

export function builtin(pi: ExtensionAPI): void {
	const historyPath = join(agentRootFromImportUrl(import.meta.url), "input-history.json");
	const store = createHistoryStore(historyPath);

	void installPersistentInputHistoryPatch(store).catch((error) => {
		console.warn(
			"[persistent-input-history] failed to install patch:",
			error instanceof Error ? error.message : error,
		);
	});

	pi.on("input", (event) => {
		if (event.source !== "interactive") return;
		store.record(event.text, []);
	});

	pi.on("session_start", async () => {
		try {
			await installPersistentInputHistoryPatch(store);
		} catch (error) {
			console.warn(
				"[persistent-input-history] failed to install patch:",
				error instanceof Error ? error.message : error,
			);
		}
	});

	pi.on("session_shutdown", async () => {
		restorePersistentInputHistoryPatch();
	});
}
