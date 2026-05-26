import { WebToolsError } from "./errors.ts";

type ReadabilityParseResult = {
	title?: string;
	content?: string;
	textContent?: string;
};

type ReadabilityInstance = {
	parse(): ReadabilityParseResult | null;
};

type ReadabilityConstructor = new (document: unknown) => ReadabilityInstance;

type TurndownInstance = {
	use(plugin: unknown): void;
	addRule(name: string, rule: unknown): void;
	turndown(html: string): string;
};

type TurndownConstructor = new (options: Record<string, unknown>) => TurndownInstance;

type JSDOMConstructor = new (html: string, options: { url: string }) => { window: { document: unknown } };

export function truncateContent(content: string, maxChars: number): { content: string; truncated: boolean } {
	if (content.length <= maxChars) return { content, truncated: false };
	return { content: content.slice(0, maxChars).trimEnd(), truncated: true };
}

function cleanMarkdown(markdown: string): string {
	return markdown
		.replace(/\[\\?\[\s*\\?\]\]\([^)]*\)/g, "")
		.replace(/ +/g, " ")
		.replace(/\s+,/g, ",")
		.replace(/\s+\./g, ".")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function cleanText(text: string): string {
	return text
		.replace(/\r\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

async function htmlToMarkdown(html: string): Promise<string> {
	try {
		const turndownModule = await import("turndown");
		const gfmModule = await import("turndown-plugin-gfm");
		const TurndownService = turndownModule.default as TurndownConstructor;
		const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
		turndown.use(gfmModule.gfm);
		turndown.addRule("removeEmptyLinks", {
			filter: (node: any) => node.nodeName === "A" && !(node.textContent ?? "").trim(),
			replacement: () => "",
		});
		return cleanMarkdown(turndown.turndown(html));
	} catch (error) {
		throw new WebToolsError(
			`/web markdown extraction dependencies are missing or failed to load: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function extractFallbackContent(
	document: unknown,
	format: "markdown" | "text",
): Promise<{ title?: string; content: string }> {
	const doc = document as any;
	for (const element of doc.querySelectorAll("script, style, noscript, nav, header, footer, aside") as any[]) {
		element.remove();
	}
	const title = doc.querySelector("title")?.textContent?.trim() || undefined;
	const root = doc.querySelector("main, article, [role='main'], .content, #content") ?? doc.body;
	const content = format === "text" ? cleanText(root?.textContent ?? "") : await htmlToMarkdown(root?.innerHTML ?? "");

	if (!content) {
		throw new WebToolsError("Could not extract readable content from this page.");
	}
	return { title, content };
}

export async function extractReadableContent(
	html: string,
	url: string,
	format: "markdown" | "text",
): Promise<{ title?: string; content: string }> {
	try {
		const [{ Readability }, { JSDOM }] = await Promise.all([
			import("@mozilla/readability") as Promise<{ Readability: ReadabilityConstructor }>,
			import("jsdom") as Promise<{ JSDOM: JSDOMConstructor }>,
		]);
		const dom = new JSDOM(html, { url });
		const article = new Readability(dom.window.document).parse();
		if (!article?.content) return extractFallbackContent(new JSDOM(html, { url }).window.document, format);

		if (format === "text") {
			return { title: article.title, content: cleanText(article.textContent ?? "") };
		}

		return { title: article.title, content: await htmlToMarkdown(article.content ?? "") };
	} catch (error) {
		if (error instanceof WebToolsError) throw error;
		throw new WebToolsError(
			`/web content extraction failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

export function plainContent(text: string, maxChars: number): { content: string; truncated: boolean } {
	return truncateContent(cleanText(text), maxChars);
}
