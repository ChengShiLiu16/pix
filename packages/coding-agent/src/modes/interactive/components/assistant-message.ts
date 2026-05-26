import type { AssistantMessage, ThinkingContent } from "@earendil-works/pi-ai";
import { Container, Markdown, type MarkdownTheme, Spacer, Text } from "@earendil-works/pi-tui";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import {
	isAssistantMessagePartial,
	renderNarrativeMarkdown,
	syncAssistantMarkdownStreamingState,
} from "../../../core/builtin-extensions/lib/markdown-render.ts";
import { ThinkingStepsComponent } from "../../../core/builtin-extensions/thinking-steps/render.ts";
import { getActiveThinkingState, getCurrentThinkingScopeKey, getThinkingStepsMode } from "../../../core/builtin-extensions/thinking-steps/state.ts";
import type { ThinkingSourceBlock, ThinkingThemeLike } from "../../../core/builtin-extensions/thinking-steps/types.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

function hasVisibleThinking(content: ThinkingContent): boolean {
	return content.redacted === true || /\S/u.test(content.thinking);
}

function collectThinkingBlocks(message: AssistantMessage): ThinkingSourceBlock[] {
	const blocks: ThinkingSourceBlock[] = [];
	message.content.forEach((content, index) => {
		if (content.type !== "thinking") return;
		if (!hasVisibleThinking(content)) return;
		blocks.push({ contentIndex: index, text: content.thinking, redacted: content.redacted });
	});
	return blocks;
}

/**
 * Component that renders a complete assistant message.
 *
 * Integrates thinking-steps rendering (collapsed/summary/expanded modes)
 * and markdown-assistant streaming behavior directly in source code
 * instead of via runtime monkey-patching.
 */
export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	private hideThinkingBlock: boolean;
	private markdownTheme: MarkdownTheme;
	private hiddenThinkingLabel: string;
	private lastMessage?: AssistantMessage;
	private hasToolCalls = false;

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		hiddenThinkingLabel = "Thinking...",
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
		this.hiddenThinkingLabel = hiddenThinkingLabel;

		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		super.invalidate();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
		if (this.lastMessage && this.contentContainer) {
			this.updateContent(this.lastMessage);
		}
	}

	setHiddenThinkingLabel(label: string): void {
		this.hiddenThinkingLabel = label;
		if (this.lastMessage && this.contentContainer) {
			this.updateContent(this.lastMessage);
		}
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (this.hasToolCalls || lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}

	updateContent(message: AssistantMessage): void {
		this.lastMessage = message;
		if (!this.contentContainer) return;

		this.contentContainer.clear();

		// Collect thinking blocks for thinking-steps rendering
		const thinkingBlocks = collectThinkingBlocks(message);
		const hasVisibleContent =
			message.content.some((c) => c.type === "text" && c.text.trim()) || thinkingBlocks.length > 0;

		if (hasVisibleContent) {
			this.contentContainer.addChild(new Spacer(1));
		}

		// Determine if there is visible text after the first thinking block
		const firstThinkingIndex = thinkingBlocks[0]?.contentIndex;
		const hasVisibleTextAfterThinking =
			firstThinkingIndex !== undefined &&
			message.content
				.slice(firstThinkingIndex + 1)
				.some((c) => c.type === "text" && /\S/u.test(c.text));

		// Markdown-assistant: track streaming vs finalized state
		syncAssistantMarkdownStreamingState(message);
		const isPartial = isAssistantMessagePartial(message);

		let renderedThinking = false;

		// Render content in order
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];

			if (content.type === "text" && content.text.trim()) {
				// Use narrative markdown rendering (streaming=plain text, finalized=formatted markdown)
				this.contentContainer.addChild(
					renderNarrativeMarkdown(content.text, {
						message,
						isPartial,
						markdownTheme: this.markdownTheme,
						terminalTheme: theme as any,
						paddingX: 1,
						paddingY: 0,
					}),
				);
				continue;
			}

			if (content.type === "thinking" && thinkingBlocks.length > 0 && !renderedThinking) {
				// Thinking-steps: use ThinkingStepsComponent for structured rendering
				const scopeKey = resolveThinkingMessageScope(message);
				this.contentContainer.addChild(
					new ThinkingStepsComponent(
						theme as unknown as ThinkingThemeLike,
						message.timestamp,
						thinkingBlocks,
						scopeKey,
					),
				);
				renderedThinking = true;
				if (hasVisibleTextAfterThinking) {
					this.contentContainer.addChild(new Spacer(1));
				}
				continue;
			}

			// Fallback: non-visible thinking blocks when thinking-steps already rendered
			if (content.type === "thinking" && content.thinking.trim() && !renderedThinking) {
				const hasVisibleContentAfter = message.content
					.slice(i + 1)
					.some((c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()));

				if (this.hideThinkingBlock) {
					this.contentContainer.addChild(
						new Text(theme.italic(theme.fg("thinkingText", this.hiddenThinkingLabel)), 1, 0),
					);
				} else {
					this.contentContainer.addChild(
						new Markdown(content.thinking.trim(), 1, 0, this.markdownTheme, {
							color: (text: string) => theme.fg("thinkingText", text),
							italic: true,
						}),
					);
				}
				if (hasVisibleContentAfter) {
					this.contentContainer.addChild(new Spacer(1));
				}
			}
		}

		// Check if aborted - show after partial content
		const hasToolCalls = message.content.some((c) => c.type === "toolCall");
		this.hasToolCalls = hasToolCalls;
		if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", abortMessage), 1, 0));
			} else if (message.stopReason === "error") {
				const errorMsg = message.errorMessage || "Unknown error";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMsg}`), 1, 0));
			}
		}
	}
}

/**
 * Resolve the thinking message scope key for the given message.
 * Uses the same logic as the thinking-steps state module.
 */
function resolveThinkingMessageScope(message: AssistantMessage): string | undefined {
	return getCurrentThinkingScopeKey() || undefined;
}
