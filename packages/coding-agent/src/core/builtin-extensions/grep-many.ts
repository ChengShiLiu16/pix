import { Text } from "@earendil-works/pix-tui";
import { type Static, Type } from "typebox";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "../../index.ts";
import { createGrepToolDefinition, type GrepToolDetails } from "../../index.ts";
import { displayPath, formatToolPath, formatTreeCall, type ThemeLike } from "./lib/format-tree-call.ts";
import {
	buildResultText,
	contentHasMarkedErrors,
	countMultiToolFailed,
	formatMultiToolBody,
	formatMultiToolSection,
} from "./lib/multi-tool-result.ts";
import { prepareGrepManyArguments } from "./lib/prepare-batch-args.ts";

const searchItemSchema = Type.Object({
	pattern: Type.String({ description: "Search pattern (regex or literal)" }),
	path: Type.Optional(Type.String({ description: "File or directory to search in" })),
	glob: Type.Optional(Type.String({ description: "Glob pattern to filter files" })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search" })),
	literal: Type.Optional(Type.Boolean({ description: "Treat pattern as literal string" })),
});

const schema = Type.Object({
	searches: Type.Optional(
		Type.Array(searchItemSchema, {
			description:
				'Batch of search objects (preferred). Each element must be an object like { pattern: "foo", path: "src", glob: "*.ts" } — never bare strings or field names.',
			minItems: 1,
			maxItems: 10,
		}),
	),
	// Single-search shorthand (same shape as grep); wrapped into searches internally.
	pattern: Type.Optional(Type.String({ description: "Single search only: pattern (use searches[] for multiple)" })),
	path: Type.Optional(Type.String({ description: "Single search only: file or directory to search in" })),
	glob: Type.Optional(Type.String({ description: "Single search only: glob pattern to filter files" })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Single search only: case-insensitive search" })),
	literal: Type.Optional(Type.Boolean({ description: "Single search only: treat pattern as literal string" })),
});

type SearchItem = Static<typeof searchItemSchema>;
type GrepManyInput = Static<typeof schema>;

function normalizeSearches(params: GrepManyInput): SearchItem[] {
	if (params.searches?.length) return params.searches;
	if (params.pattern) {
		return [
			{
				pattern: params.pattern,
				path: params.path,
				glob: params.glob,
				ignoreCase: params.ignoreCase,
				literal: params.literal,
			},
		];
	}
	throw new Error('grep_many requires either "searches" (array) or top-level "pattern" (single search)');
}
type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type SingleResult = AgentToolResult<GrepToolDetails | undefined> & { isError?: boolean };
type GrepManyDetails = { searches: { pattern: string; path?: string; isError: boolean; details?: GrepToolDetails }[] };

function extractText(content: Content[]): string {
	return content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

function renderErrorText(text: string, theme: { fg(name: string, text: string): string }): Text {
	const colored = text
		.split("\n")
		.map((line) => theme.fg("error", line || " "))
		.join("\n");
	return new Text(colored, 0, 0);
}

function renderTextWithMarkedErrors(text: string, theme: { fg(name: string, text: string): string }): Text {
	const colored = text
		.split("\n")
		.map((line) => (line.startsWith("ERROR: ") ? theme.fg("error", line) : line))
		.join("\n");
	return new Text(colored, 0, 0);
}

function displaySearchPath(p: string, maxLen = 120): string {
	if (!p || p === ".") return ".";
	return displayPath(p, maxLen);
}

function shortPattern(p: string): string {
	return p.length <= 50 ? p : `${p.slice(0, 47)}...`;
}

function formatSearchLabel(search: SearchItem): string {
	const pattern = shortPattern(search.pattern);
	const path = displaySearchPath(search.path || ".");
	return search.path ? `/${pattern}/ in ${formatToolPath(path)}` : `/${pattern}/`;
}

function formatGrepManyCall(searches: SearchItem[], theme: ThemeLike, failed = 0, argsComplete = false): Text {
	if (!argsComplete) return new Text("", 0, 0);
	const count = searches.length;
	let header = `Grep (${count})`;
	if (failed > 0) header += ` ${theme.fg("error", `· ${failed} failed`)}`;
	return formatTreeCall(theme, header, searches.map(formatSearchLabel));
}

function extractErrorLines(text: string): string {
	return text
		.split("\n")
		.filter((line) => line.startsWith("ERROR: "))
		.join("\n");
}

function buildGrepManyResultText(results: { search: SearchItem; result: SingleResult }[]): string {
	const sections = results.map((item) => {
		const text = extractText(item.result.content as Content[]);
		const body = formatMultiToolBody(item.result.isError, text);
		const label = item.search.path
			? `"${item.search.pattern}" in ${displayPath(item.search.path)}`
			: `"${item.search.pattern}"`;
		return formatMultiToolSection(label, body);
	});
	return buildResultText(sections, "grep_many").text;
}

export function builtin(pi: ExtensionAPI) {
	let lastRegisteredCwd = "";

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.cwd === lastRegisteredCwd) return;
		lastRegisteredCwd = ctx.cwd;
		const grepDef = createGrepToolDefinition(ctx.cwd);

		pi.registerTool<typeof schema, GrepManyDetails>({
			name: "grep_many",
			label: "search many",
			description:
				"Run multiple grep searches in one tool call. Pass a `searches` array of {pattern, path?, ...} objects (preferred), or a single top-level `pattern` (+ optional path/glob) for one search.",
			promptSnippet: "Run multiple searches in one call (searches: [...])",
			promptGuidelines: [
				"Always batch ALL searches into a single grep_many call (up to 10 searches). NEVER make multiple grep_many or grep calls when you can combine them into one.",
				'Use the `searches` array: { searches: [{ pattern: "foo", path: "src" }, { pattern: "bar", glob: "*.ts" }] }. Every array element must be a full object — not a bare string like "glob". Top-level pattern/path alone works for a single search but searches[] is preferred for multiple.',
			],
			parameters: schema,
			prepareArguments: prepareGrepManyArguments,
			async execute(
				_toolCallId: string,
				params: GrepManyInput,
				signal: AbortSignal | undefined,
				_onUpdate: unknown,
				ctx: ExtensionContext,
			): Promise<AgentToolResult<GrepManyDetails>> {
				const searches = normalizeSearches(params);
				const results: { search: SearchItem; result: SingleResult }[] = [];
				for (const search of searches) {
					try {
						const result = await grepDef.execute(
							`${_toolCallId}:${search.pattern}`,
							{
								pattern: search.pattern,
								path: search.path,
								glob: search.glob,
								ignoreCase: search.ignoreCase,
								literal: search.literal,
							},
							signal,
							undefined,
							ctx,
						);
						results.push({ search, result });
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						results.push({
							search,
							result: {
								content: [{ type: "text", text: message }],
								details: undefined,
								isError: true,
							} as SingleResult,
						});
					}
				}
				return {
					content: [{ type: "text", text: buildGrepManyResultText(results) }],
					details: {
						searches: results.map((item) => ({
							pattern: item.search.pattern,
							path: item.search.path,
							isError: item.result.isError ?? false,
							details: item.result.details,
						})),
					},
				};
			},
			renderCall(args, theme, context) {
				let searches: SearchItem[];
				try {
					searches = normalizeSearches(args);
				} catch {
					searches = [];
				}
				const result = (context as { result?: { details?: GrepManyDetails } }).result;
				const failed = countMultiToolFailed(result?.details?.searches);
				return formatGrepManyCall(searches, theme, failed, context.argsComplete);
			},
			renderResult(result, { expanded }, theme, context) {
				const args = context.args as GrepManyInput;
				let _searches: SearchItem[];
				try {
					_searches = normalizeSearches(args);
				} catch {
					_searches = [];
				}
				const body = extractText(result.content as Content[]);
				if (!expanded) {
					if (context.isError) {
						return renderErrorText(body, theme);
					}
					if (contentHasMarkedErrors(body)) {
						const errors = extractErrorLines(body);
						return errors ? renderErrorText(errors, theme) : new Text("", 0, 0);
					}
					return new Text("", 0, 0);
				}
				if (context.isError) {
					return renderErrorText(body, theme);
				}
				if (contentHasMarkedErrors(body)) {
					return renderTextWithMarkedErrors(body, theme);
				}
				return new Text(body, 0, 0);
			},
		});
	});
}
