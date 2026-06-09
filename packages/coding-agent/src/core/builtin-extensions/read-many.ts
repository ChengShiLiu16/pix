import { Text } from "@chengshiliu16/pix-tui";
import { type Static, Type } from "typebox";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "../../index.ts";
import { createReadToolDefinition, type ReadToolDetails } from "../../index.ts";
import { setDisplayCwd } from "./lib/format-tree-call.ts";
import {
	buildResultText,
	contentHasMarkedErrors,
	countMultiToolFailed,
	formatMultiToolBody,
	formatMultiToolSection,
} from "./lib/multi-tool-result.ts";
import { prepareReadManyArguments } from "./lib/prepare-batch-args.ts";
import { formatReadManyCallWithBatch, setReadBatchCwd } from "./lib/read-batch-display.ts";
import { isSensitiveReadPath, sensitiveReadError } from "./lib/sensitive-files.ts";

const fileItemSchema = Type.Object({
	path: Type.String({ description: "File path to read, relative or absolute" }),
	offset: Type.Optional(Type.Number({ description: "1-indexed line number to start reading from for this file" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read from this file" })),
});

const schema = Type.Object({
	files: Type.Optional(
		Type.Array(fileItemSchema, {
			description:
				"Batch of file read objects (preferred for mixed ranges). Each element: { path, offset?, limit? } — never bare path strings.",
			minItems: 1,
			maxItems: 10,
		}),
	),
	paths: Type.Optional(
		Type.Array(Type.String({ description: "File path to read, relative or absolute" }), {
			description: "Homogeneous batch shorthand: same offset/limit applied to every path (legacy)",
			minItems: 1,
			maxItems: 10,
		}),
	),
	offset: Type.Optional(Type.Number({ description: "With paths[] only: 1-indexed start line applied to every path" })),
	limit: Type.Optional(Type.Number({ description: "With paths[] only: max lines applied to every path" })),
});

// type FileItem = Static<typeof fileItemSchema>;
type ReadManyInput = Static<typeof schema>;
export type ReadTarget = { path: string; offset?: number; limit?: number };
export const READ_MANY_BATCH_TOTAL_LIMIT = 360;
export const READ_MANY_BATCH_MAX_PER_FILE = 160;

export function normalizeReadTargets(params: ReadManyInput): ReadTarget[] {
	if (params.files?.length) {
		return params.files.map((file) => ({
			path: file.path,
			offset: typeof file.offset === "number" ? file.offset : undefined,
			limit: typeof file.limit === "number" ? file.limit : undefined,
		}));
	}
	if (params.paths?.length) {
		const offset = typeof params.offset === "number" ? params.offset : undefined;
		const limit = typeof params.limit === "number" ? params.limit : undefined;
		return params.paths.map((path) => ({ path, offset, limit }));
	}
	throw new Error('read_many requires either "files" (array of { path, offset?, limit? }) or "paths" (string array)');
}

export function applyReadManyBudget(targets: ReadTarget[]): ReadTarget[] {
	const isBatch = targets.length > 1;
	const perFileBudget = Math.max(
		1,
		Math.min(READ_MANY_BATCH_MAX_PER_FILE, Math.floor(READ_MANY_BATCH_TOTAL_LIMIT / targets.length)),
	);
	return targets.map((target) => {
		if (!isBatch && target.limit === undefined) return target;
		const limit = target.limit === undefined ? perFileBudget : target.limit;
		const cappedLimit = Math.min(Math.max(Math.floor(limit), 1), perFileBudget);
		if (target.limit === cappedLimit) return target;
		return { ...target, limit: cappedLimit };
	});
}

type ReadContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type ReadResult = AgentToolResult<ReadToolDetails | undefined> & { isError?: boolean };
type TruncationInfo = { outputLines?: number; totalLines?: number };

/** Extract truncation info from details (which may be a library-defined ReadToolDetails). */
function getTruncationInfo(details: ReadToolDetails | undefined): TruncationInfo | undefined {
	if (!details) return undefined;
	const obj = details as Record<string, unknown>;
	const trunc = obj.truncation;
	if (typeof trunc === "object" && trunc !== null) return trunc as TruncationInfo;
	return undefined;
}

/** Check whether details indicate a genuine truncation (output < total). */
function isTruncated(details: ReadToolDetails | undefined): boolean {
	const trunc = getTruncationInfo(details);
	return Boolean(trunc?.outputLines && trunc?.totalLines && trunc.outputLines < trunc.totalLines);
}

type ReadManyDetails = {
	files: {
		path: string;
		isError: boolean;
		offset?: number;
		limit?: number;
		details?: ReadToolDetails;
	}[];
	/** True when aggregate output was truncated (cross-file), requiring · continued hint. */
	aggregateTruncated?: boolean;
	/** Index of the first file that is fully or partially cut off by aggregate truncation. */
	firstTruncatedFileIndex?: number;
};

function textContent(content: ReadContent[]): string {
	return content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

function extractErrorLines(text: string): string {
	return text
		.split("\n")
		.filter((line) => line.startsWith("ERROR: "))
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

function buildReadManyResultText(results: { path: string; result: ReadResult }[]): {
	text: string;
	firstTruncatedFileIndex?: number;
} {
	const sections = results.map((item) => {
		const text = textContent(item.result.content as ReadContent[]);
		const body = formatMultiToolBody(item.result.isError, text);
		return formatMultiToolSection(item.path, body);
	});
	const { text, sectionLineCounts, truncated, outputLines } = buildResultText(sections, "read_many");
	if (!truncated) return { text };

	// Walk section boundaries to find the first file cut off by truncation
	let cumulativeLines = 0;
	let firstTruncatedFileIndex: number | undefined;
	for (let i = 0; i < sections.length; i++) {
		cumulativeLines += sectionLineCounts[i]! + (i > 0 ? 2 : 0); // +2 for \n\n separator
		if (cumulativeLines > outputLines) {
			firstTruncatedFileIndex = i;
			break;
		}
	}

	return { text, firstTruncatedFileIndex };
}

export function builtin(pi: ExtensionAPI) {
	let lastRegisteredCwd = "";

	pi.on("session_start", async (_event, ctx) => {
		setDisplayCwd(ctx.cwd);
		setReadBatchCwd(ctx.cwd);
		if (ctx.cwd === lastRegisteredCwd) return;
		lastRegisteredCwd = ctx.cwd;
		const readDef = createReadToolDefinition(ctx.cwd);

		pi.registerTool<typeof schema, ReadManyDetails>({
			name: "read_many",
			label: "read many",
			description:
				"Read multiple files in one tool call. Use files[] with per-file offset/limit when batching files of different sizes or paginating one large file alongside others.",
			renderShell: "self",
			promptSnippet: "Read multiple files in one call",
			promptGuidelines: [
				"Always batch ALL files you need to read into a single read_many call (up to 10 files). NEVER make multiple read_many or read calls when you can combine them into one.",
				"If you need to read more than 10 files, split into the fewest possible calls (e.g. two calls of 10 and 5, not seven calls of 2).",
				'Prefer files[] with per-file ranges: [{ path: "big.ts", offset: 580, limit: 260 }, { path: "config.ts" }]. Each file gets its own offset/limit — no shared global range.',
				"Use paths[] + top-level offset/limit only when every file needs the same range (homogeneous batch).",
				"When paginating a large file alongside smaller files, put offset/limit on that file only in files[]; omit offset on files that should be read fully.",
				"When batching, use per-file offset/limit for large files instead of reading them in full — this avoids pulling in thousands of irrelevant lines.",
				`Batch reads share a total budget of ${READ_MANY_BATCH_TOTAL_LIMIT} lines, capped at ${READ_MANY_BATCH_MAX_PER_FILE} lines per file. Use follow-up offset/limit only for relevant sections.`,
				"Do not batch-read temporary files containing git diff/show/log output; use git_evidence_read ranges so raw git evidence stays compact and citable.",
			],
			parameters: schema,
			prepareArguments: prepareReadManyArguments,
			async execute(
				_toolCallId: string,
				params: ReadManyInput,
				signal: AbortSignal | undefined,
				_onUpdate: unknown,
				ctx: ExtensionContext,
			): Promise<AgentToolResult<ReadManyDetails>> {
				const targets = applyReadManyBudget(normalizeReadTargets(params));
				const results: { path: string; offset?: number; limit?: number; result: ReadResult }[] = [];
				for (const target of targets) {
					if (isSensitiveReadPath(target.path)) {
						results.push({
							path: target.path,
							offset: target.offset,
							limit: target.limit,
							result: {
								content: [{ type: "text", text: sensitiveReadError(target.path) }],
								details: undefined,
								isError: true,
							} as ReadResult,
						});
						continue;
					}
					try {
						const result = await readDef.execute(
							`${_toolCallId}:${target.path}`,
							{ path: target.path, offset: target.offset, limit: target.limit },
							signal,
							undefined,
							ctx,
						);
						results.push({ path: target.path, offset: target.offset, limit: target.limit, result });
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						results.push({
							path: target.path,
							offset: target.offset,
							limit: target.limit,
							result: {
								content: [{ type: "text", text: message }],
								details: undefined,
								isError: true,
							} as ReadResult,
						});
					}
				}

				const { text, firstTruncatedFileIndex } = buildReadManyResultText(results);

				return {
					content: [{ type: "text", text }],
					details: {
						files: results.map((item, index) => {
							const baseDetails = item.result.details;
							// When aggregate truncation cuts off this file and it wasn't
							// individually truncated, inject a synthetic truncation marker
							// so applyReadTruncationHint() can set the · continued flag.
							if (
								firstTruncatedFileIndex !== undefined &&
								index >= firstTruncatedFileIndex &&
								!isTruncated(baseDetails)
							) {
								return {
									path: item.path,
									offset: item.offset,
									limit: item.limit,
									isError: item.result.isError ?? false,
									details: {
										...baseDetails,
										truncation: { outputLines: 1, totalLines: 2 },
									} as ReadToolDetails,
								};
							}
							return {
								path: item.path,
								offset: item.offset,
								limit: item.limit,
								isError: item.result.isError ?? false,
								details: baseDetails,
							};
						}),
						aggregateTruncated: firstTruncatedFileIndex !== undefined,
						firstTruncatedFileIndex,
					},
				};
			},
			renderCall(args, theme, context) {
				const result = (context as { result?: { details?: ReadManyDetails } }).result;
				const failed = countMultiToolFailed(result?.details?.files);
				return formatReadManyCallWithBatch(
					args,
					theme,
					failed,
					context.toolCallId,
					context.invalidate,
					result?.details?.files,
					context.argsComplete,
					result?.details?.aggregateTruncated,
				);
			},
			renderResult(result, { expanded }, theme, context) {
				const body = textContent(result.content as ReadContent[]);

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
