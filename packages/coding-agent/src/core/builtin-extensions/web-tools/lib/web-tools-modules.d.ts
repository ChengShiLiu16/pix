declare module "turndown" {
	interface TurndownOptions {
		headingStyle?: "setext" | "atx";
		codeBlockStyle?: "indented" | "fenced";
		[fallback: string]: unknown;
	}
	type TurndownPlugin = (turndownService: TurndownService) => void;
	interface Rule {
		filter: string | string[] | ((node: unknown, options: unknown) => boolean);
		replacement: (content: string, node: unknown, options: unknown) => string;
	}
	class TurndownService {
		constructor(options?: TurndownOptions);
		use(plugin: TurndownPlugin | TurndownPlugin[]): TurndownService;
		addRule(name: string, rule: Rule): TurndownService;
		turndown(html: string | HTMLElement): string;
	}
	export default TurndownService;
}

declare module "turndown-plugin-gfm" {
	export function gfm(turndownService: unknown): void;
}

declare module "jsdom" {
	interface JSDOMOptions {
		url?: string;
		contentType?: string;
		[key: string]: unknown;
	}
	class JSDOM {
		constructor(html: string, options?: JSDOMOptions);
		window: { document: unknown };
	}
	export { JSDOM };
}

declare module "@mozilla/readability" {
	interface ReadabilityOptions {
		[key: string]: unknown;
	}
	interface ReadabilityResult {
		title?: string;
		content?: string;
		textContent?: string;
		length?: number;
		excerpt?: string;
		siteName?: string;
	}
	class Readability {
		constructor(document: unknown, options?: ReadabilityOptions);
		parse(): ReadabilityResult | null;
	}
	export { Readability };
}
