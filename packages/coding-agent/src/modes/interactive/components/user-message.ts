import { Box, Container, Markdown, type MarkdownTheme } from "@earendil-works/pix-tui";
import { formatUserMessageCardLines } from "../../../core/builtin-extensions/lib/user-message-style.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";

/**
 * Component that renders a user message
 */
export class UserMessageComponent extends Container {
	private contentBox: Box;

	constructor(text: string, markdownTheme: MarkdownTheme = getMarkdownTheme()) {
		super();
		this.contentBox = new Box(1, 1, (content: string) => theme.bg("userMessageBg", content));
		this.contentBox.addChild(
			new Markdown(text, 0, 0, markdownTheme, {
				color: (content: string) => theme.fg("userMessageText", content),
			}),
		);
		this.addChild(this.contentBox);
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		return formatUserMessageCardLines(lines, theme);
	}
}
