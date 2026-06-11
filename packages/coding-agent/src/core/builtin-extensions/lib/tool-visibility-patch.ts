/**
 * Keep compact tool blocks visible in chat (never hide successful tool headers).
 * Batch-aggregated tools (bash, read) merge consecutive same-type calls.
 * todo_manage is hidden entirely (shown in aboveEditor widget).
 * Non-anchor calls are hidden; anchors render aggregated content via updateDisplay.
 *
 * ## Pi upgrade checklist (verify after bumping @chengshiliu16/pix-coding-agent)
 * 1. ToolExecutionComponent is exported from the package entry and prototype.updateDisplay exists.
 * 2. Batch anchor fields unchanged: hideComponent, argsComplete, getRenderShell,
 *    selfRenderContainer, contentBox.
 * 3. Run: npx tsx --tsconfig extensions/lib/tsconfig.test.json extensions/lib/batch-display.test.ts
 * 4. Manual: consecutive bash/read merge, /reload re-applies patch, session restart clean.
 */
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	BASH_HEADER,
	bashBatchHasContent,
	bashCallShouldHideUntilReady,
	formatAggregatedBashCall,
	formatBashCommandForDisplay,
	isBashAnchor,
	isInBashBatch,
} from "./bash-batch-display.ts";
import { logBatchDebug } from "./batch-debug.ts";
import { displayFullPath, formatToolPath, formatTreeCall, shortenPath, type ThemeLike } from "./format-tree-call.ts";
import {
	formatAggregatedReadCall,
	isInReadBatch,
	isReadAnchor,
	readBatchHasContent,
	readCallShouldHideUntilReady,
} from "./read-batch-display.ts";

const DEFAULT_RENDER_WIDTH = 120;

/** Internal pix-coding-agent module paths — update when upgrading Pix. */
export const PIX_INTERNAL_MODULES = {
	theme: "dist/modes/interactive/theme/theme.js",
} as const;

const PATCH_STATE_KEY = Symbol.for("pix.extensions.tool-visibility-patch.v1");
const SPACED_INSTANCES = new WeakSet<object>();

type PatchState = {
	ToolExecutionClass: { prototype: ToolExecutionPrototype };
	originalUpdateDisplay: (this: ToolExecutionPrototype) => void;
	patchedUpdateDisplay: (this: ToolExecutionPrototype) => void;
	restore: () => void;
};

type ToolArgs = {
	command?: string;
	path?: string;
	file_path?: string;
	pattern?: string;
	content?: string;
	edits?: unknown[];
	paths?: string[];
	files?: { path?: string; offset?: number; limit?: number }[];
	searches?: { pattern?: string; path?: string }[];
	patterns?: string[];
	constraints?: string;
	action?: string;
	text?: string;
	id?: number;
};

type ToolExecutionPrototype = {
	toolName: string;
	toolCallId: string;
	args: ToolArgs;
	hideComponent: boolean;
	argsComplete: boolean;
	updateDisplay(): void;
	getRenderShell(): "default" | "self";
	selfRenderContainer: { clear(): void; addChild(c: unknown): void; render(w: number): string[] };
	contentBox: { clear(): void; addChild(c: unknown): void; render(w: number): string[] };
};

type RenderShell = {
	clear?(): void;
	render?(width: number): string[];
};

type ToolExecutionInstance = ToolExecutionPrototype & {
	children: unknown[];
	contentBox: { paddingY?: number };
	render?(width: number): string[];
};

/** Tools that must never be hidden by empty-content heuristics (except batch dedup). */
export const NEVER_HIDE = new Set([
	"bash",
	"read",
	"read_many",
	"grep",
	"grep_many",
	"ffgrep",
	"fff-multi-grep",
	"multi_grep",
	"find",
	"ffind",
	"fffind",
	"ls",
	"ls_many",
	"write",
	"edit",
]);

/** Tools fully suppressed in chat — state shown in aboveEditor widget. */
export const HIDE_ENTIRELY = new Set(["todo_manage"]);

const TOOL_HEADERS: Record<string, string> = {
	bash: BASH_HEADER,
	read: "Read",
	read_many: "Read",
	grep: "Grep",
	grep_many: "Grep",
	ffgrep: "Grep",
	"fff-multi-grep": "Grep",
	multi_grep: "Grep",
	find: "Find",
	ffind: "Find",
	fffind: "Find",
	ls: "List",
	ls_many: "List",
	write: "Write",
	edit: "Edit",
};

export const COMPACT_RENDER_EMPTY_TOOLS = new Set(["bash", "read", "read_many"]);

export type UpdateDisplayDecision =
	| "hide-entirely"
	| "hide-duplicate"
	| "hide-until-ready"
	| "hide-pre-batch"
	| "batch-anchor-fallback"
	| "never-hide-fallback"
	| "original";

export type SimulateUpdateDisplayInput = {
	toolName: string;
	toolCallId: string;
	args: ToolArgs;
	argsComplete: boolean;
	hideComponentAfterOriginal?: boolean;
};

export type SimulateUpdateDisplayResult = {
	decision: UpdateDisplayDecision;
	hideComponent: boolean;
	wouldRenderFallback: boolean;
};

function getPackageRoot(): string {
	const entryUrl = import.meta.resolve("@chengshiliu16/pix-coding-agent");
	const entryPath = fileURLToPath(entryUrl);
	return dirname(dirname(entryPath));
}

function getPatchStateRoot(): Record<symbol, PatchState | undefined> {
	return globalThis as Record<symbol, PatchState | undefined>;
}

function getPatchState(): PatchState | undefined {
	return getPatchStateRoot()[PATCH_STATE_KEY];
}

function setPatchState(state: PatchState | undefined): void {
	getPatchStateRoot()[PATCH_STATE_KEY] = state;
}

function _truncateOneLine(text: string, maxLen = 120): string {
	const oneLine = text.split(/\r?\n/)[0] || text;
	if (oneLine.length <= maxLen) return oneLine;
	return `${oneLine.slice(0, maxLen - 1)}…`;
}

/** Args carry enough detail to render (includes historical reload before setArgsComplete). */
export function hasVisibleToolArgs(toolName: string, args: ToolArgs): boolean {
	switch (toolName) {
		case "bash":
			return typeof args.command === "string" && args.command.length > 0;
		case "read":
			return typeof args.path === "string" && args.path.length > 0;
		case "read_many":
			return (
				(Array.isArray(args.paths) && args.paths.some((p) => typeof p === "string" && p.length > 0)) ||
				(Array.isArray(args.files) && args.files.some((f) => typeof f?.path === "string" && f.path.length > 0))
			);
		case "grep":
		case "grep_many":
		case "ffgrep":
		case "fff-multi-grep":
		case "multi_grep":
			return (
				(typeof args.pattern === "string" && args.pattern.length > 0) ||
				(Array.isArray(args.patterns) && args.patterns.some((p) => typeof p === "string" && p.length > 0)) ||
				(Array.isArray(args.searches) &&
					args.searches.some((s) => typeof s?.pattern === "string" && s.pattern.length > 0))
			);
		case "find":
		case "ffind":
		case "fffind":
			return typeof args.pattern === "string" && args.pattern.length > 0;
		case "ls":
		case "ls_many":
			return (
				(typeof args.path === "string" && args.path.length > 0) ||
				(Array.isArray(args.paths) && args.paths.some((p) => typeof p === "string" && p.length > 0))
			);
		case "write":
		case "edit":
			return (
				(typeof args.path === "string" && args.path.length > 0) ||
				(typeof args.file_path === "string" && args.file_path.length > 0)
			);
		case "todo_manage":
			return typeof args.action === "string" && args.action.length > 0;
		default:
			return false;
	}
}

export function isToolArgsReady(toolName: string, args: ToolArgs, argsComplete: boolean): boolean {
	return argsComplete || hasVisibleToolArgs(toolName, args);
}

function buildFallbackDetail(toolName: string, args: ToolArgs, theme: ThemeLike): string {
	switch (toolName) {
		case "bash": {
			const command = typeof args.command === "string" ? args.command : toolName;
			return formatBashCommandForDisplay(command, theme);
		}
		case "read":
		case "read_many": {
			if (args.files?.length) {
				return formatToolPath(displayFullPath(args.files[0]?.path ?? "..."));
			}
			if (args.paths?.length) {
				return formatToolPath(displayFullPath(args.paths[0] ?? "..."));
			}
			return formatToolPath(displayFullPath(args.path ?? "..."));
		}
		case "grep":
		case "grep_many": {
			const search = args.searches?.[0];
			const pattern = search?.pattern ?? args.pattern ?? "";
			const path = shortenPath(search?.path ?? args.path ?? ".");
			return `/${pattern}/ in ${formatToolPath(path)}`;
		}
		case "ffgrep": {
			const pattern = args.pattern ?? "";
			const path = shortenPath(args.path ?? ".");
			return `/${pattern}/ in ${formatToolPath(path)}`;
		}
		case "fff-multi-grep":
		case "multi_grep": {
			const pattern = args.patterns?.[0] ?? "";
			const path = shortenPath(args.constraints ?? ".");
			return `/${pattern}/ in ${formatToolPath(path)}`;
		}
		case "find": {
			const pattern = args.pattern ?? "";
			const path = shortenPath(args.path ?? ".");
			return `${pattern} in ${formatToolPath(path)}`;
		}
		case "ffind":
		case "fffind": {
			const pattern = args.pattern ?? "";
			const path = shortenPath(args.path ?? ".");
			return `${pattern} in ${formatToolPath(path)}`;
		}
		case "ls":
		case "ls_many": {
			const path = args.paths?.[0] ?? args.path ?? ".";
			return formatToolPath(shortenPath(path));
		}
		case "write": {
			const path = shortenPath(args.path ?? args.file_path ?? "...");
			const lines = args.content ? args.content.split("\n").length : 0;
			return `${formatToolPath(path)} (${lines} lines)`;
		}
		case "edit": {
			const path = shortenPath(args.path ?? args.file_path ?? "...");
			const editCount = Array.isArray(args.edits) ? args.edits.length : 0;
			return editCount > 0 ? `${formatToolPath(path)} (${editCount} edits)` : formatToolPath(path);
		}
		default:
			return toolName;
	}
}

export function shouldHideToolEntirely(toolName: string): boolean {
	return HIDE_ENTIRELY.has(toolName);
}

export function shouldHideBatchDuplicate(toolName: string, toolCallId: string): boolean {
	if (shouldHideToolEntirely(toolName)) return true;
	if (toolName === "read" || toolName === "read_many") {
		return isInReadBatch(toolCallId) && !isReadAnchor(toolCallId);
	}
	if (toolName === "bash") {
		return isInBashBatch(toolCallId) && !isBashAnchor(toolCallId);
	}
	return false;
}

function shouldHideCompactToolUntilArgsComplete(toolName: string, argsComplete: boolean): boolean {
	if (argsComplete) return false;
	return (
		toolName === "ls" ||
		toolName === "ls_many" ||
		toolName === "grep" ||
		toolName === "grep_many" ||
		toolName === "ffgrep" ||
		toolName === "fff-multi-grep" ||
		toolName === "multi_grep"
	);
}

export function shouldHideUntilBatchReady(
	toolName: string,
	toolCallId: string | undefined,
	args: ToolArgs,
	argsComplete: boolean,
): boolean {
	if (shouldHideToolEntirely(toolName)) return true;
	if (shouldHideCompactToolUntilArgsComplete(toolName, argsComplete)) return true;
	if (!toolCallId) return false;
	if (toolName === "bash") {
		return bashCallShouldHideUntilReady(toolCallId, {
			command: args.command,
			argsComplete,
		});
	}
	if (toolName === "read" || toolName === "read_many") {
		return readCallShouldHideUntilReady(toolCallId, {
			path: args.path,
			paths: args.paths,
			files: args.files as any,
			argsComplete,
		});
	}
	return false;
}

export function shouldHidePreBatchShell(
	toolName: string,
	toolCallId: string | undefined,
	argsComplete: boolean,
): boolean {
	if (!toolCallId || argsComplete) return false;
	if (toolName === "bash") return !isInBashBatch(toolCallId);
	if (toolName === "read" || toolName === "read_many") return !isInReadBatch(toolCallId);
	return false;
}

/** True when this component is a batch anchor with aggregated content to show. */
export function isBatchAnchorWithContent(toolName: string, toolCallId: string | undefined): boolean {
	if (!toolCallId) return false;
	if (
		toolName === "bash" &&
		isInBashBatch(toolCallId) &&
		isBashAnchor(toolCallId) &&
		bashBatchHasContent(toolCallId)
	) {
		return true;
	}
	if (
		(toolName === "read" || toolName === "read_many") &&
		isInReadBatch(toolCallId) &&
		isReadAnchor(toolCallId) &&
		readBatchHasContent(toolCallId)
	) {
		return true;
	}
	return false;
}

function compactToolBlockSpacing(instance: ToolExecutionInstance): void {
	if (instance.contentBox && "paddingY" in instance.contentBox) {
		instance.contentBox.paddingY = 0;
	}
	const lead = instance.children?.[0] as { setLines?: (n: number) => void } | undefined;
	lead?.setLines?.(1);
}

export function ensureCompactSpacing(instance: ToolExecutionInstance): void {
	if (SPACED_INSTANCES.has(instance)) return;
	SPACED_INSTANCES.add(instance);
	compactToolBlockSpacing(instance);
}

function getRenderShellContainer(instance: ToolExecutionPrototype): RenderShell {
	return instance.getRenderShell() === "self" ? instance.selfRenderContainer : instance.contentBox;
}

/** Ensure Container.children stays iterable — utility only, never hooked globally. */
export function ensureContainerChildren(container: { children?: unknown }): unknown[] {
	if (Array.isArray(container.children)) return container.children;
	container.children = [];
	return container.children as unknown[];
}

/** True when the tool shell has no visible rows. */
export function shellRendersEmpty(instance: ToolExecutionPrototype, width = DEFAULT_RENDER_WIDTH): boolean {
	const shell = getRenderShellContainer(instance);
	if (!shell || typeof shell.render !== "function") return true;
	return shell.render(width).length === 0;
}

/** Render line count — 0 when hideComponent. */
export function countToolExecutionRenderLines(instance: ToolExecutionPrototype, width = DEFAULT_RENDER_WIDTH): number {
	if (instance.hideComponent) return 0;
	const render = (instance as ToolExecutionInstance).render;
	if (typeof render !== "function") return 0;
	return render.call(instance, width).length;
}

/** Collapse hidden rows via hideComponent + spacer only — never clear() internal shells. */
export function applyZeroFootprint(instance: ToolExecutionInstance): void {
	instance.hideComponent = true;
	const lead = instance.children?.[0] as { setLines?: (n: number) => void } | undefined;
	lead?.setLines?.(0);
}

/** Compact visible tool blocks: drop Box padding and leading spacer row. */
export function applyCompactFootprint(instance: ToolExecutionInstance): void {
	instance.hideComponent = false;
	if (instance.contentBox && "paddingY" in instance.contentBox) {
		instance.contentBox.paddingY = 0;
	}
	const lead = instance.children?.[0] as { setLines?: (n: number) => void } | undefined;
	lead?.setLines?.(0);
}

export function buildFallbackCall(toolName: string, args: ToolArgs, theme: ThemeLike, toolCallId?: string) {
	if (shouldHideToolEntirely(toolName)) return null;
	if (toolCallId && shouldHideBatchDuplicate(toolName, toolCallId)) {
		return null;
	}
	if (toolName === "bash" && toolCallId && isInBashBatch(toolCallId)) {
		if (!isBashAnchor(toolCallId)) return null;
		if (bashBatchHasContent(toolCallId)) return formatAggregatedBashCall(theme, toolCallId);
		if (!hasVisibleToolArgs(toolName, args)) return null;
	}
	if ((toolName === "read" || toolName === "read_many") && toolCallId && isInReadBatch(toolCallId)) {
		if (!isReadAnchor(toolCallId)) return null;
		if (readBatchHasContent(toolCallId)) return formatAggregatedReadCall(theme, toolCallId);
		if (!hasVisibleToolArgs(toolName, args)) return null;
	}
	const header = TOOL_HEADERS[toolName] ?? toolName;
	const detail = buildFallbackDetail(toolName, args, theme);
	return formatTreeCall(theme, header, [detail]);
}

function renderBatchFallback(self: ToolExecutionPrototype, theme: ThemeLike): boolean {
	self.hideComponent = false;
	const container = self.getRenderShell() === "self" ? self.selfRenderContainer : self.contentBox;
	container.clear();
	const fallback = buildFallbackCall(self.toolName, self.args, theme, self.toolCallId);
	if (fallback) {
		container.addChild(fallback);
		return true;
	}
	return false;
}

export function shouldRenderNeverHideFallback(
	toolName: string,
	argsComplete: boolean,
	args: ToolArgs,
	hideComponent: boolean,
): boolean {
	if (!NEVER_HIDE.has(toolName)) return false;
	const argsReady = isToolArgsReady(toolName, args, argsComplete);
	if (hideComponent) return true;
	if (argsReady && COMPACT_RENDER_EMPTY_TOOLS.has(toolName)) return true;
	if (
		argsReady &&
		(toolName === "grep" ||
			toolName === "grep_many" ||
			toolName === "ffgrep" ||
			toolName === "fff-multi-grep" ||
			toolName === "multi_grep" ||
			toolName === "find" ||
			toolName === "ffind" ||
			toolName === "fffind" ||
			toolName === "ls" ||
			toolName === "ls_many")
	) {
		return false;
	}
	return false;
}

/** Pure decision helper for tests — mirrors patched updateDisplay without touching Pi. */
export function simulateUpdateDisplayDecision(input: SimulateUpdateDisplayInput): SimulateUpdateDisplayResult {
	const { toolName, toolCallId, args, argsComplete } = input;
	const hideAfterOriginal = input.hideComponentAfterOriginal ?? false;

	if (shouldHideToolEntirely(toolName)) {
		return { decision: "hide-entirely", hideComponent: true, wouldRenderFallback: false };
	}

	if (shouldHideBatchDuplicate(toolName, toolCallId)) {
		return { decision: "hide-duplicate", hideComponent: true, wouldRenderFallback: false };
	}
	if (shouldHideUntilBatchReady(toolName, toolCallId, args, argsComplete)) {
		return { decision: "hide-until-ready", hideComponent: true, wouldRenderFallback: false };
	}
	if (shouldHidePreBatchShell(toolName, toolCallId, argsComplete)) {
		return { decision: "hide-pre-batch", hideComponent: true, wouldRenderFallback: false };
	}
	if (isBatchAnchorWithContent(toolName, toolCallId)) {
		return {
			decision: "batch-anchor-fallback",
			hideComponent: false,
			wouldRenderFallback: true,
		};
	}
	if (shouldRenderNeverHideFallback(toolName, argsComplete, args, hideAfterOriginal)) {
		return {
			decision: "never-hide-fallback",
			hideComponent: false,
			wouldRenderFallback:
				buildFallbackCall(toolName, args, { fg: (_n, t) => t, bold: (t) => t }, toolCallId) !== null,
		};
	}
	return {
		decision: "original",
		hideComponent: hideAfterOriginal,
		wouldRenderFallback: false,
	};
}

/** Restore ToolExecutionComponent.prototype.updateDisplay (for session_shutdown / hot reload). */
export function restoreToolVisibilityPatch(): void {
	const state = getPatchState();
	if (!state) return;
	state.restore();
	setPatchState(undefined);
	logBatchDebug("tool-visibility-patch restored");
}

export async function installToolVisibilityPatch(): Promise<void> {
	// Regression guard: never patch pix-tui Container.render/addChild or ToolExecution.render
	// globally — that wiped the entire chat tree (see .revert-emergency-tui-20260524-190411/REVERT.md).
	const prior = getPatchState();
	if (prior) {
		prior.restore();
		setPatchState(undefined);
	}

	const piMod = (await import("@chengshiliu16/pix-coding-agent")) as unknown as {
		ToolExecutionComponent?: { prototype: ToolExecutionPrototype };
	};
	const ToolExecutionClass = piMod.ToolExecutionComponent;
	if (!ToolExecutionClass?.prototype?.updateDisplay) {
		throw new Error(
			"ToolExecutionComponent.prototype.updateDisplay missing — patch cannot install on this Pix version",
		);
	}

	const packageRoot = getPackageRoot();
	const themeUrl = pathToFileURL(join(packageRoot, PIX_INTERNAL_MODULES.theme)).href;
	const themeMod = (await import(themeUrl)) as { theme: ThemeLike };
	const uiTheme = themeMod.theme;
	const proto = ToolExecutionClass.prototype;
	const original = proto.updateDisplay;

	const patchedUpdateDisplay = function patchedUpdateDisplay(this: ToolExecutionPrototype) {
		ensureCompactSpacing(this as ToolExecutionInstance);

		if (shouldHideToolEntirely(this.toolName)) {
			this.hideComponent = true;
			logBatchDebug("hide entirely", {
				toolName: this.toolName,
				toolCallId: this.toolCallId,
			});
			return;
		}

		const argsReady = isToolArgsReady(this.toolName, this.args, this.argsComplete);

		if (shouldHideBatchDuplicate(this.toolName, this.toolCallId)) {
			this.hideComponent = true;
			logBatchDebug("hide duplicate", {
				toolName: this.toolName,
				toolCallId: this.toolCallId,
			});
			return;
		}

		if (shouldHideUntilBatchReady(this.toolName, this.toolCallId, this.args, this.argsComplete)) {
			this.hideComponent = true;
			logBatchDebug("hide until ready", {
				toolName: this.toolName,
				toolCallId: this.toolCallId,
				argsReady,
				argsComplete: this.argsComplete,
			});
			return;
		}

		if (shouldHidePreBatchShell(this.toolName, this.toolCallId, this.argsComplete)) {
			this.hideComponent = true;
			logBatchDebug("hide pre-batch shell", {
				toolName: this.toolName,
				toolCallId: this.toolCallId,
				argsComplete: this.argsComplete,
			});
			return;
		}

		if (isBatchAnchorWithContent(this.toolName, this.toolCallId)) {
			const rendered = renderBatchFallback(this, uiTheme);
			logBatchDebug("batch anchor fallback", {
				toolName: this.toolName,
				toolCallId: this.toolCallId,
				rendered,
				argsReady,
				argsComplete: this.argsComplete,
			});
			if (!rendered) {
				original.call(this);
			}
			return;
		}

		original.call(this);

		if (NEVER_HIDE.has(this.toolName)) {
			if (shouldHideBatchDuplicate(this.toolName, this.toolCallId)) {
				return;
			}
			if (shouldRenderNeverHideFallback(this.toolName, this.argsComplete, this.args, this.hideComponent)) {
				const rendered = renderBatchFallback(this, uiTheme);
				logBatchDebug("never-hide fallback", {
					toolName: this.toolName,
					toolCallId: this.toolCallId,
					rendered,
					hideComponent: this.hideComponent,
					argsReady,
					argsComplete: this.argsComplete,
				});
				if (!rendered && this.hideComponent) {
					this.hideComponent = false;
				}
			}
		}
	};

	proto.updateDisplay = patchedUpdateDisplay;
	setPatchState({
		ToolExecutionClass,
		originalUpdateDisplay: original,
		patchedUpdateDisplay,
		restore: () => {
			if (proto.updateDisplay === patchedUpdateDisplay) {
				proto.updateDisplay = original;
			}
		},
	});

	if (proto.updateDisplay !== patchedUpdateDisplay) {
		throw new Error("tool-visibility patch failed to attach to ToolExecutionComponent.prototype");
	}

	logBatchDebug("tool-visibility-patch installed", {
		packageRoot,
		patchOnPrototype: proto.updateDisplay === patchedUpdateDisplay,
	});
}

/** @internal Test helper — true when prototype patch is active. */
export function isToolVisibilityPatchInstalled(): boolean {
	return getPatchState() !== undefined;
}

/** @internal Test helper — class patched by the active install (same export Pi uses). */
export function getPatchedToolExecutionClass(): { prototype: ToolExecutionPrototype } | undefined {
	return getPatchState()?.ToolExecutionClass;
}
