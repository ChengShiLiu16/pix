/**
 * Fallback assistant-message patch: stream plain Text, render Markdown when complete.
 * Skips install when pix-thinking-steps already owns AssistantMessageComponent.updateContent.
 */
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AssistantMessage } from "@earendil-works/pix-ai";
import { Markdown, Spacer, Text } from "@earendil-works/pix-tui";
import {
	isAssistantMessagePartial,
	type MarkdownTheme,
	renderNarrativeMarkdown,
	syncAssistantMarkdownStreamingState,
} from "./markdown-render.ts";

const PI_INTERNAL_MODULES = {
	assistantMessageComponent: "dist/modes/interactive/components/assistant-message.js",
	theme: "dist/modes/interactive/theme/theme.js",
} as const;

const PATCH_STATE_KEY = Symbol.for("pix.extensions.markdown-assistant-patch.v1");
const TRUE_ORIGINAL_KEY = Symbol.for("pix.extensions.assistant-message.true-original.v1");

type PatchState = {
	prototype: AssistantMessagePrototype;
	originalUpdateContent: (message: AssistantMessage) => void;
	patchedUpdateContent: (message: AssistantMessage) => void;
};

type AssistantMessagePrototype = {
	contentContainer: { clear(): void; addChild(component: unknown): void };
	lastMessage?: AssistantMessage;
	hideThinkingBlock: boolean;
	markdownTheme: MarkdownTheme;
	hiddenThinkingLabel: string;
	updateContent(message: AssistantMessage): void;
};

type ThemeLike = {
	fg(name: string, text: string): string;
	italic(text: string): string;
};

function getPackageRoot(packageName: string): string {
	const entryUrl = import.meta.resolve(packageName);
	const entryPath = fileURLToPath(entryUrl);
	return dirname(dirname(entryPath));
}

function resolveInternalModuleUrl(relativePath: string): string {
	const packageRoot = getPackageRoot("@earendil-works/pix-coding-agent");
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

function getTrueOriginalUpdateContent(prototype: AssistantMessagePrototype): (message: AssistantMessage) => void {
	const store = globalThis as Record<symbol, ((message: AssistantMessage) => void) | undefined>;
	const existing = store[TRUE_ORIGINAL_KEY];
	if (existing) return existing;

	const bound = prototype.updateContent.bind(prototype);
	store[TRUE_ORIGINAL_KEY] = bound;
	return bound;
}

function isMarkdownAssistantPatchActive(state: PatchState): boolean {
	return state.prototype.updateContent === state.patchedUpdateContent;
}

export async function installMarkdownAssistantPatch(): Promise<void> {
	const existing = getPatchState();
	if (existing && isMarkdownAssistantPatchActive(existing)) {
		return;
	}

	const [{ AssistantMessageComponent }, { theme }] = await Promise.all([
		importInternal<{ AssistantMessageComponent: { prototype: AssistantMessagePrototype } }>(
			PI_INTERNAL_MODULES.assistantMessageComponent,
		),
		importInternal<{ theme: ThemeLike }>(PI_INTERNAL_MODULES.theme),
	]);

	const prototype = AssistantMessageComponent.prototype;
	const trueOriginalUpdateContent = getTrueOriginalUpdateContent(prototype);

	if (
		prototype.updateContent !== trueOriginalUpdateContent &&
		prototype.updateContent.name === "patchedUpdateContent"
	) {
		return;
	}

	if (existing && !isMarkdownAssistantPatchActive(existing)) {
		setPatchState(undefined);
	}

	const patchedUpdateContent = function markdownAssistantUpdateContent(
		this: AssistantMessagePrototype,
		message: AssistantMessage,
	): void {
		this.lastMessage = message;
		this.contentContainer.clear();

		const hasVisibleContent = message.content.some(
			(c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()),
		);
		if (hasVisibleContent) {
			this.contentContainer.addChild(new Spacer(1));
		}

		syncAssistantMarkdownStreamingState(message);
		const isPartial = isAssistantMessagePartial(message);

		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i]!;
			if (content.type === "text" && content.text.trim()) {
				this.contentContainer.addChild(
					renderNarrativeMarkdown(content.text, {
						message,
						isPartial,
						markdownTheme: this.markdownTheme,
						paddingX: 1,
						paddingY: 0,
					}),
				);
				continue;
			}

			if (content.type === "thinking" && content.thinking.trim()) {
				const hasVisibleContentAfter = message.content
					.slice(i + 1)
					.some((c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()));

				if (this.hideThinkingBlock) {
					this.contentContainer.addChild(
						new Text(theme.italic(theme.fg("thinkingText", this.hiddenThinkingLabel)), 1, 0),
					);
				} else {
					this.contentContainer.addChild(
						new Markdown(content.thinking.trim(), 1, 0, this.markdownTheme as any, {
							color: (text) => theme.fg("thinkingText", text),
							italic: true,
						}),
					);
				}

				if (hasVisibleContentAfter) {
					this.contentContainer.addChild(new Spacer(1));
				}
			}
		}

		const hasToolCalls = message.content.some((c) => c.type === "toolCall");
		if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", abortMessage), 1, 0));
			} else if (message.stopReason === "error") {
				const errorMessage = message.errorMessage || "Unknown error";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMessage}`), 1, 0));
			}
		}
	};

	prototype.updateContent = patchedUpdateContent;
	setPatchState({ prototype, originalUpdateContent: trueOriginalUpdateContent, patchedUpdateContent });
}

export function restoreMarkdownAssistantPatch(): void {
	const state = getPatchState();
	if (!state) return;

	if (state.prototype.updateContent === state.patchedUpdateContent) {
		state.prototype.updateContent = state.originalUpdateContent;
	}

	setPatchState(undefined);
}
