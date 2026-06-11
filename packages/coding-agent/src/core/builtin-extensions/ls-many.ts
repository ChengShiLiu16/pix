import { type Container, Text } from "@chengshiliu16/pix-tui";
import { type Static, Type } from "typebox";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "../../index.ts";
import { createLsToolDefinition, type LsToolDetails } from "../../index.ts";
import { isLsManyArgsRenderable, LS_MANY_MAX_PATHS } from "./lib/batch-limits.ts";
import { displayFullPath, formatToolPath, formatTreeCall, type ThemeLike } from "./lib/format-tree-call.ts";
import {
	buildResultText,
	contentHasMarkedErrors,
	countMultiToolFailed,
	formatMultiToolBody,
	formatMultiToolSection,
} from "./lib/multi-tool-result.ts";
import { preparePathsArguments } from "./lib/prepare-batch-args.ts";

export { isLsManyArgsRenderable, LS_MANY_MAX_PATHS } from "./lib/batch-limits.ts";

const schema = Type.Object({
	paths: Type.Array(Type.String({ description: "Directory path to list, relative or absolute" }), {
		description: "Directory paths to list in one tool call",
		minItems: 1,
		maxItems: LS_MANY_MAX_PATHS,
	}),
	limit: Type.Optional(Type.Number({ description: "Maximum number of entries per directory" })),
});

type LsManyInput = Static<typeof schema>;
type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type SingleResult = AgentToolResult<LsToolDetails | undefined> & { isError?: boolean };
type LsManyDetails = { dirs: { path: string; isError: boolean; details?: LsToolDetails }[] };

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

function displayListPath(p: string): string {
	if (!p || p === ".") return ".";
	return displayFullPath(p);
}

function formatLsManyCall(args: LsManyInput, theme: ThemeLike, failed = 0, argsComplete = false): Container | Text {
	if (!argsComplete || !isLsManyArgsRenderable(args)) return new Text("", 0, 0);
	const paths = args.paths ?? [];
	const count = paths.length;
	let header = `List (${count})`;
	if (args.limit !== undefined) header += theme.fg("toolOutput", ` limit ${args.limit}`);
	if (failed > 0) header += ` ${theme.fg("error", `· ${failed} failed`)}`;
	return formatTreeCall(
		theme,
		header,
		paths.map((p) => formatToolPath(displayListPath(p))),
	);
}

function extractErrorLines(text: string): string {
	return text
		.split("\n")
		.filter((line) => line.startsWith("ERROR: "))
		.join("\n");
}

function buildLsManyResultText(results: { path: string; result: SingleResult }[]): string {
	const sections = results.map((item) => {
		const text = extractText(item.result.content as Content[]);
		const body = formatMultiToolBody(item.result.isError, text);
		return formatMultiToolSection(item.path, body);
	});
	return buildResultText(sections, "ls_many").text;
}

export function builtin(pix: ExtensionAPI) {
	let lastRegisteredCwd = "";

	pix.on("session_start", async (_event, ctx) => {
		if (ctx.cwd === lastRegisteredCwd) return;
		lastRegisteredCwd = ctx.cwd;
		const lsDef = createLsToolDefinition(ctx.cwd);

		pix.registerTool<typeof schema, LsManyDetails>({
			name: "ls_many",
			label: "list many",
			description:
				"List multiple directories in one tool call. Use this instead of several ls calls when you need to inspect two or more directories together.",
			renderShell: "self",
			promptSnippet: "List multiple directories in one call",
			promptGuidelines: [
				`Always batch ALL directories you need to list into a single ls_many call (up to ${LS_MANY_MAX_PATHS} paths). NEVER make multiple ls_many or ls calls when you can combine them into one.`,
				`If you need to list more than ${LS_MANY_MAX_PATHS} directories, split into the fewest possible calls (e.g. two calls of 20 and 5, not many small calls).`,
			],
			parameters: schema,
			prepareArguments: preparePathsArguments as any,
			async execute(
				_toolCallId: string,
				params: LsManyInput,
				signal: AbortSignal | undefined,
				_onUpdate: unknown,
				ctx: ExtensionContext,
			): Promise<AgentToolResult<LsManyDetails>> {
				const results: { path: string; result: SingleResult }[] = [];
				for (const path of params.paths) {
					try {
						const result = await lsDef.execute(
							`${_toolCallId}:${path}`,
							{ path, limit: params.limit },
							signal,
							undefined,
							ctx,
						);
						results.push({ path, result });
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						results.push({
							path,
							result: {
								content: [{ type: "text", text: message }],
								details: undefined,
								isError: true,
							} as SingleResult,
						});
					}
				}
				return {
					content: [{ type: "text", text: buildLsManyResultText(results) }],
					details: {
						dirs: results.map((item) => ({
							path: item.path,
							isError: item.result.isError ?? false,
							details: item.result.details,
						})),
					},
				};
			},
			renderCall(args, theme, context) {
				const result = (context as { result?: { details?: LsManyDetails } }).result;
				const failed = countMultiToolFailed(result?.details?.dirs);
				return formatLsManyCall(args, theme, failed, context.argsComplete);
			},
			renderResult(result, { expanded }, theme, context) {
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
