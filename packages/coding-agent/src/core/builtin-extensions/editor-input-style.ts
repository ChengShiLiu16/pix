import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionAPI } from "../../index.ts";
import { type EditorInputThemeLike, formatEditorInputRenderLines } from "./lib/editor-input-style.ts";

const PI_INTERNAL_MODULES = {
	customEditor: "dist/modes/interactive/components/custom-editor.js",
	theme: "dist/modes/interactive/theme/theme.js",
} as const;

const PATCH_STATE_KEY = Symbol.for("pi.extensions.editor-input-style-patch.v1");

type CustomEditorPrototype = {
	render(width: number): string[];
};

type PatchState = {
	prototype: CustomEditorPrototype;
	originalRender: (width: number) => string[];
	patchedRender: (width: number) => string[];
};

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

async function installEditorInputStylePatch(): Promise<void> {
	const existing = getPatchState();
	if (existing && existing.prototype.render === existing.patchedRender) return;

	const [{ CustomEditor }, { theme }] = await Promise.all([
		importInternal<{ CustomEditor: { prototype: CustomEditorPrototype } }>(PI_INTERNAL_MODULES.customEditor),
		importInternal<{ theme: EditorInputThemeLike }>(PI_INTERNAL_MODULES.theme),
	]);

	const prototype = CustomEditor.prototype;
	const originalRender = existing?.originalRender ?? prototype.render;
	const patchedRender = function patchedEditorInputRender(this: CustomEditorPrototype, width: number): string[] {
		return formatEditorInputRenderLines(originalRender.call(this, width), theme);
	};

	prototype.render = patchedRender;
	setPatchState({ prototype, originalRender, patchedRender });
}

function restoreEditorInputStylePatch(): void {
	const state = getPatchState();
	if (!state) return;
	if (state.prototype.render === state.patchedRender) {
		state.prototype.render = state.originalRender;
	}
	setPatchState(undefined);
}

export function builtin(pi: ExtensionAPI): void {
	void installEditorInputStylePatch().catch((error) => {
		console.warn("[editor-input-style] failed to install patch:", error instanceof Error ? error.message : error);
	});

	pi.on("session_start", async () => {
		try {
			await installEditorInputStylePatch();
		} catch (error) {
			console.warn("[editor-input-style] failed to install patch:", error instanceof Error ? error.message : error);
		}
	});

	pi.on("session_shutdown", async () => {
		restoreEditorInputStylePatch();
	});
}
