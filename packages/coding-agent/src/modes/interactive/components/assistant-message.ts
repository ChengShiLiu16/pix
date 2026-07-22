import type { AssistantMessage, ThinkingContent } from "@chengshiliu16/pix-ai";
import { Container, Markdown, type MarkdownTheme, Spacer, Text } from "@chengshiliu16/pix-tui";
import {
	isAssistantMessagePartial,
	renderNarrativeMarkdown,
	syncAssistantMarkdownStreamingState,
} from "../../../core/builtin-extensions/lib/markdown-render.ts";
import { wrapOscPromptZone } from "../../../core/builtin-extensions/lib/osc-prompt-zone.ts";
import { ThinkingStepsComponent } from "../../../core/builtin-extensions/thinking-steps/render.ts";
import { getCurrentThinkingScopeKey } from "../../../core/builtin-extensions/thinking-steps/state.ts";
import type { ThinkingSourceBlock, ThinkingThemeLike } from "../../../core/builtin-extensions/thinking-steps/types.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";

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
	private outputPad: number;
	private lastMessage?: AssistantMessage;
	private hasToolCalls = false;

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		hiddenThinkingLabel = "Thinking...",
		outputPad = 1,
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
		this.hiddenThinkingLabel = hiddenThinkingLabel;
		this.outputPad = outputPad;
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
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHiddenThinkingLabel(label: string): void {
		this.hiddenThinkingLabel = label;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (this.hasToolCalls || lines.length === 0) {
			return lines;
		}
		return wrapOscPromptZone(lines);
	}

	updateContent(message: AssistantMessage): void {
		this.lastMessage = message;
		this.contentContainer.clear();

		const thinkingBlocks = collectThinkingBlocks(message);
		const hasVisibleContent =
			message.content.some((content) => content.type === "text" && content.text.trim()) || thinkingBlocks.length > 0;
		if (hasVisibleContent) {
			this.contentContainer.addChild(new Spacer(1));
		}

		const firstThinkingIndex = thinkingBlocks[0]?.contentIndex;
		const hasVisibleTextAfterThinking =
			firstThinkingIndex !== undefined &&
			message.content
				.slice(firstThinkingIndex + 1)
				.some((content) => content.type === "text" && /\S/u.test(content.text));

		syncAssistantMarkdownStreamingState(message);
		const isPartial = isAssistantMessagePartial(message);
		let renderedThinking = false;

		for (let index = 0; index < message.content.length; index++) {
			const content = message.content[index];
			if (content.type === "text" && content.text.trim()) {
				this.contentContainer.addChild(
					renderNarrativeMarkdown(content.text, {
						message,
						isPartial,
						markdownTheme: this.markdownTheme,
						terminalTheme: theme,
						paddingX: this.outputPad,
						paddingY: 0,
					}),
				);
				continue;
			}

			if (content.type === "thinking" && thinkingBlocks.length > 0 && !renderedThinking) {
				if (this.hideThinkingBlock) {
					this.contentContainer.addChild(
						new Text(theme.italic(theme.fg("thinkingText", this.hiddenThinkingLabel)), this.outputPad, 0),
					);
				} else {
					this.contentContainer.addChild(
						new ThinkingStepsComponent(
							theme as unknown as ThinkingThemeLike,
							message.timestamp,
							thinkingBlocks,
							resolveThinkingMessageScope(),
						),
					);
				}
				renderedThinking = true;
				if (hasVisibleTextAfterThinking) {
					this.contentContainer.addChild(new Spacer(1));
				}
				continue;
			}

			if (content.type === "thinking" && content.thinking.trim() && !renderedThinking) {
				const hasVisibleContentAfter = message.content
					.slice(index + 1)
					.some(
						(next) =>
							(next.type === "text" && next.text.trim()) || (next.type === "thinking" && next.thinking.trim()),
					);
				if (this.hideThinkingBlock) {
					this.contentContainer.addChild(
						new Text(theme.italic(theme.fg("thinkingText", this.hiddenThinkingLabel)), this.outputPad, 0),
					);
				} else {
					this.contentContainer.addChild(
						new Markdown(content.thinking.trim(), this.outputPad, 0, this.markdownTheme, {
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

		const hasToolCalls = message.content.some((content) => content.type === "toolCall");
		this.hasToolCalls = hasToolCalls;
		if (message.stopReason === "length") {
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(
				new Text(
					theme.fg(
						"error",
						"Error: Model stopped because it reached the maximum output token limit. The response may be incomplete.",
					),
					this.outputPad,
					0,
				),
			);
		} else if (!hasToolCalls && message.stopReason === "aborted") {
			const abortMessage =
				message.errorMessage && message.errorMessage !== "Request was aborted"
					? message.errorMessage
					: "Operation aborted";
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(new Text(theme.fg("error", abortMessage), this.outputPad, 0));
		} else if (!hasToolCalls && message.stopReason === "error") {
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(
				new Text(theme.fg("error", `Error: ${message.errorMessage || "Unknown error"}`), this.outputPad, 0),
			);
		}
	}
}

function resolveThinkingMessageScope(): string | undefined {
	return getCurrentThinkingScopeKey() || undefined;
}
