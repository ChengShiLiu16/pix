import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionAPI } from "../../index.ts";
import { formatUserMessageCardLines, type UserMessageThemeLike } from "./lib/user-message-style.ts";

const PI_INTERNAL_MODULES = {
	userMessageComponent: "dist/modes/interactive/components/user-message.js",
	theme: "dist/modes/interactive/theme/theme.js",
} as const;

const PATCH_STATE_KEY = Symbol.for("pi.extensions.user-message-style-patch.v1");

type UserMessagePrototype = {
	render(width: number): string[];
};

type PatchState = {
	prototype: UserMessagePrototype;
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

async function installUserMessageStylePatch(): Promise<void> {
	const existing = getPatchState();
	if (existing && existing.prototype.render === existing.patchedRender) return;

	const [{ UserMessageComponent }, { theme }] = await Promise.all([
		importInternal<{ UserMessageComponent: { prototype: UserMessagePrototype } }>(
			PI_INTERNAL_MODULES.userMessageComponent,
		),
		importInternal<{ theme: UserMessageThemeLike }>(PI_INTERNAL_MODULES.theme),
	]);

	const prototype = UserMessageComponent.prototype;
	const originalRender = existing?.originalRender ?? prototype.render;
	const patchedRender = function patchedUserMessageRender(this: UserMessagePrototype, width: number): string[] {
		return formatUserMessageCardLines(originalRender.call(this, width), theme);
	};

	prototype.render = patchedRender;
	setPatchState({ prototype, originalRender, patchedRender });
}

function restoreUserMessageStylePatch(): void {
	const state = getPatchState();
	if (!state) return;
	if (state.prototype.render === state.patchedRender) {
		state.prototype.render = state.originalRender;
	}
	setPatchState(undefined);
}

export function builtin(pi: ExtensionAPI): void {
	void installUserMessageStylePatch().catch((error) => {
		console.warn("[user-message-style] failed to install patch:", error instanceof Error ? error.message : error);
	});

	pi.on("session_start", async () => {
		try {
			await installUserMessageStylePatch();
		} catch (error) {
			console.warn("[user-message-style] failed to install patch:", error instanceof Error ? error.message : error);
		}
	});

	pi.on("session_shutdown", async () => {
		restoreUserMessageStylePatch();
	});
}
