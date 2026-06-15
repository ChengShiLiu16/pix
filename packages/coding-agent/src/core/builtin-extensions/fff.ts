import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type AutocompleteItem, Text } from "@chengshiliu16/pix-tui";
import { FileFinder, type GrepCursor, type GrepMode, type GrepResult } from "@ff-labs/fff-node";
import { Type } from "typebox";
import { getAgentDir } from "../../config.ts";
import type { AgentToolResult, ExtensionAPI } from "../../index.ts";
import {
	buildFffQuery,
	createFffMentionProvider,
	type FffMode,
	type FffToolNames,
	formatFffFindOutput,
	formatFffGrepOutput,
	isWildcardOnlyPattern,
	mixedItemToAutocompleteItem,
	parseFffMode,
	resolveFffToolNames,
	VALID_FFF_MODES,
} from "./lib/fff.ts";
import { formatTreeCall, type ThemeLike } from "./lib/format-tree-call.ts";

const DEFAULT_GREP_LIMIT = 20;
const DEFAULT_FIND_LIMIT = 30;
const MENTION_MAX_RESULTS = 20;
const CURSOR_CACHE_MAX = 200;
const MENTION_REFRESH_MIN_INTERVAL_MS = 2000;

const grepSchema = Type.Object({
	pattern: Type.String({ description: "Search pattern (literal text or regex)" }),
	path: Type.Optional(
		Type.String({
			description: "Repo-relative path constraint: directory prefix, filename, or glob.",
		}),
	),
	exclude: Type.Optional(
		Type.Union([Type.String(), Type.Array(Type.String())], {
			description: "Exclude paths (same syntax as path; string or array).",
		}),
	),
	caseSensitive: Type.Optional(
		Type.Boolean({ description: "Force case-sensitive matching. Default uses smart-case." }),
	),
	context: Type.Optional(Type.Number({ description: "Context lines before and after each match" })),
	limit: Type.Optional(Type.Number({ description: `Max matches per page (default ${DEFAULT_GREP_LIMIT})` })),
	cursor: Type.Optional(Type.String({ description: "Pagination cursor from previous result" })),
});

const findSchema = Type.Object({
	pattern: Type.String({
		description:
			"Fuzzy filename/path search. Frecency-ranked and git-aware. Multi-word narrows results; use grep for content.",
	}),
	path: Type.Optional(
		Type.String({
			description: "Repo-relative path constraint: directory prefix, filename, or glob.",
		}),
	),
	exclude: Type.Optional(
		Type.Union([Type.String(), Type.Array(Type.String())], {
			description: "Exclude paths (same syntax as path; string or array).",
		}),
	),
	limit: Type.Optional(Type.Number({ description: `Max results per page (default ${DEFAULT_FIND_LIMIT})` })),
	cursor: Type.Optional(Type.String({ description: "Pagination cursor from previous result" })),
});

const multiGrepSchema = Type.Object({
	patterns: Type.Array(Type.String(), {
		description: "Literal patterns (OR). Include snake_case/camelCase/PascalCase variants when relevant.",
		minItems: 1,
	}),
	constraints: Type.Optional(Type.String({ description: "File filter, e.g. '*.{ts,tsx} !test/'" })),
	context: Type.Optional(Type.Number({ description: "Context lines before and after each match" })),
	limit: Type.Optional(Type.Number({ description: `Max matches per page (default ${DEFAULT_GREP_LIMIT})` })),
	cursor: Type.Optional(Type.String({ description: "Pagination cursor from previous result" })),
});

interface FffGrepDetails {
	totalMatched: number;
	totalFiles: number;
}

interface FffFindDetails {
	totalMatched: number;
	totalFiles: number;
	pageIndex: number;
	hasMore: boolean;
}

interface FffMultiGrepDetails {
	totalMatched: number;
	totalFiles: number;
	patterns: string[];
}

interface FindCursor {
	query: string;
	pattern: string;
	pageSize: number;
	nextPageIndex: number;
}

function firstText(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function renderTextResult(
	result: AgentToolResult<unknown>,
	expanded: boolean,
	maxLines: number,
	theme?: ThemeLike,
): Text {
	const output = firstText(result).trim();
	if (!output) return new Text("No output", 0, 0);
	const lines = output.split("\n");
	const displayLines = expanded ? lines : lines.slice(0, maxLines);
	let content = displayLines.join("\n");
	if (lines.length > displayLines.length) {
		content += `\n... (${lines.length - displayLines.length} more lines)`;
	}
	if (theme) {
		content = theme.fg("dim", content);
	}
	return new Text(content, 0, 0);
}

function formatModeList(): string {
	return VALID_FFF_MODES.join(" | ");
}

function envMode(): FffMode | undefined {
	return parseFffMode(process.env.PIX_FFF_MODE);
}

function hasRegexSyntax(pattern: string): boolean {
	return pattern !== pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function detectGrepMode(pattern: string): { mode: GrepMode; hasRegexSyntax: boolean } {
	const regexSyntax = hasRegexSyntax(pattern);
	if (!regexSyntax) return { mode: "plain", hasRegexSyntax: false };
	try {
		new RegExp(pattern);
		return { mode: "regex", hasRegexSyntax: true };
	} catch {
		return { mode: "plain", hasRegexSyntax: true };
	}
}

function ensureFffDbDir(): string {
	const dir = join(getAgentDir(), "fff");
	mkdirSync(dir, { recursive: true });
	return dir;
}

function defaultFffDbPath(name: string): string {
	return join(ensureFffDbDir(), name);
}

export function builtin(pix: ExtensionAPI): void {
	let finder: FileFinder | undefined;
	let finderCwd: string | undefined;
	let finderPromise: Promise<FileFinder> | undefined;
	let refreshPromise: Promise<void> | undefined;
	let lastRefreshAt = 0;
	let activeCwd = process.cwd();
	let modeAtRegistration: FffMode | undefined;
	let toolNamesAtRegistration: FffToolNames | undefined;
	let mentionProviderInstalled = false;
	let grepCursorCounter = 0;
	let findCursorCounter = 0;
	const grepCursorCache = new Map<string, GrepCursor>();
	const findCursorCache = new Map<string, FindCursor>();

	pix.registerFlag("fff-mode", {
		description: `FFF mode: ${formatModeList()}`,
		type: "string",
	});
	pix.registerFlag("fff-frecency-db", {
		description: "Path to the FFF frecency database (overrides FFF_FRECENCY_DB)",
		type: "string",
	});
	pix.registerFlag("fff-history-db", {
		description: "Path to the FFF query history database (overrides FFF_HISTORY_DB)",
		type: "string",
	});

	function storeGrepCursor(cursor: GrepCursor): string {
		const id = `fff_c${++grepCursorCounter}`;
		grepCursorCache.set(id, cursor);
		if (grepCursorCache.size > CURSOR_CACHE_MAX) {
			const first = grepCursorCache.keys().next().value;
			if (first) grepCursorCache.delete(first);
		}
		return id;
	}

	function storeFindCursor(cursor: FindCursor): string {
		const id = `fff_f${++findCursorCounter}`;
		findCursorCache.set(id, cursor);
		if (findCursorCache.size > CURSOR_CACHE_MAX) {
			const first = findCursorCache.keys().next().value;
			if (first) findCursorCache.delete(first);
		}
		return id;
	}

	function currentMode(): FffMode {
		const flagValue = pix.getFlag("fff-mode");
		const flagMode = typeof flagValue === "string" ? parseFffMode(flagValue) : undefined;
		return flagMode ?? envMode() ?? "tools-and-ui";
	}

	function currentFrecencyDbPath(): string {
		const flagValue = pix.getFlag("fff-frecency-db");
		if (typeof flagValue === "string" && flagValue.length > 0) return flagValue;
		return process.env.FFF_FRECENCY_DB ?? defaultFffDbPath("frecency.db");
	}

	function currentHistoryDbPath(): string {
		const flagValue = pix.getFlag("fff-history-db");
		if (typeof flagValue === "string" && flagValue.length > 0) return flagValue;
		return process.env.FFF_HISTORY_DB ?? defaultFffDbPath("history.db");
	}

	function destroyFinder(): void {
		if (finder && !finder.isDestroyed) {
			finder.destroy();
		}
		finder = undefined;
		finderCwd = undefined;
	}

	function ensureFinder(cwd: string): Promise<FileFinder> {
		if (finder && !finder.isDestroyed && finderCwd === cwd) return Promise.resolve(finder);
		if (finderPromise) return finderPromise;

		finderPromise = (async () => {
			destroyFinder();
			const created = FileFinder.create({
				basePath: cwd,
				frecencyDbPath: currentFrecencyDbPath(),
				historyDbPath: currentHistoryDbPath(),
				aiMode: true,
				// 规避 dmtrKovalenko/fff#603：macOS watcher 会在原生 debouncer
				// 线程 SIGSEGV，绕过 JS 清理流程。禁用 watcher，搜索前显式刷新索引。
				disableWatch: true,
			});
			if (!created.ok) {
				throw new Error(`Failed to create FFF file finder: ${created.error}`);
			}
			finder = created.value;
			finderCwd = cwd;
			await finder.waitForScan(15000);
			return finder;
		})().finally(() => {
			finderPromise = undefined;
		});

		return finderPromise;
	}

	// watcher 被禁用后索引不会自动更新。工具调用强制刷新；@ 补全高频触发，
	// 只在索引超过短间隔未刷新时刷新一次，避免每次按键都触发扫描。
	async function refreshIndex(f: FileFinder, minIntervalMs = 0): Promise<void> {
		if (minIntervalMs > 0 && Date.now() - lastRefreshAt < minIntervalMs) return;
		if (refreshPromise) return refreshPromise;
		refreshPromise = (async () => {
			const res = f.scanFiles();
			if (!res.ok) return;
			await f.waitForScan(3000);
			lastRefreshAt = Date.now();
		})().finally(() => {
			refreshPromise = undefined;
		});
		return refreshPromise;
	}

	async function getMentionItems(query: string, signal: AbortSignal): Promise<AutocompleteItem[]> {
		if (signal.aborted) return [];
		const f = await ensureFinder(activeCwd);
		if (signal.aborted) return [];
		await refreshIndex(f, MENTION_REFRESH_MIN_INTERVAL_MS);
		if (signal.aborted) return [];
		const result = f.mixedSearch(query, { pageSize: MENTION_MAX_RESULTS });
		if (!result.ok) return [];
		return result.value.items.slice(0, MENTION_MAX_RESULTS).map(mixedItemToAutocompleteItem);
	}

	function registerFffTools(toolNames: FffToolNames): void {
		pix.registerTool<typeof grepSchema, FffGrepDetails>({
			name: toolNames.grep,
			label: toolNames.grep,
			description: `Grep file contents with FFF. Smart-case, auto-detects regex vs literal, git-aware, frecency-ranked. Default limit ${DEFAULT_GREP_LIMIT}.`,
			promptSnippet: "Grep contents with FFF",
			promptGuidelines: [
				"Use ffgrep for one targeted content search when FFF ranking is useful.",
				"Prefer grep_many over multiple ffgrep calls when you need several content searches.",
				"After one or two content searches, read the top matching files instead of broadening repeatedly.",
			],
			parameters: grepSchema,
			renderShell: "self",
			async execute(_toolCallId, params, signal) {
				if (signal?.aborted) throw new Error("Operation aborted");
				const f = await ensureFinder(activeCwd);
				if (!params.cursor) await refreshIndex(f);
				const effectiveLimit = Math.max(1, params.limit ?? DEFAULT_GREP_LIMIT);
				const query = buildFffQuery(params.path, params.pattern, params.exclude, activeCwd);
				const detected = detectGrepMode(params.pattern);

				if (isWildcardOnlyPattern(params.pattern, detected.hasRegexSyntax)) {
					return {
						content: [
							{
								type: "text",
								text: `Pattern '${params.pattern}' matches everything. Use a concrete substring or identifier instead.`,
							},
						],
						details: { totalMatched: 0, totalFiles: 0 },
					};
				}

				const smartCase = params.caseSensitive !== true;
				const result = f.grep(query, {
					mode: detected.mode,
					smartCase,
					maxMatchesPerFile: Math.min(effectiveLimit, 50),
					cursor: (params.cursor ? grepCursorCache.get(params.cursor) : null) ?? null,
					beforeContext: params.context ?? 0,
					afterContext: params.context ?? 0,
					classifyDefinitions: true,
				});
				if (!result.ok) throw new Error(result.error);

				let grepResult: GrepResult = result.value;
				let fuzzyNotice: string | undefined;
				if (grepResult.items.length === 0 && !params.cursor && detected.mode !== "regex") {
					const fuzzy = f.grep(params.pattern, {
						mode: "fuzzy",
						smartCase,
						maxMatchesPerFile: Math.min(effectiveLimit, 50),
						cursor: null,
						beforeContext: 0,
						afterContext: 0,
						classifyDefinitions: true,
					});
					if (fuzzy.ok && fuzzy.value.items.length > 0) {
						fuzzyNotice = "0 exact matches. Maybe you meant this?";
						grepResult = fuzzy.value;
					}
				}

				let output = formatFffGrepOutput(grepResult);
				const notices: string[] = [];
				if (grepResult.regexFallbackError) {
					notices.push(`Invalid regex: ${grepResult.regexFallbackError}, used literal match`);
				}
				if (grepResult.nextCursor) {
					notices.push(`Continue with cursor="${storeGrepCursor(grepResult.nextCursor)}"`);
				}
				if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
				if (fuzzyNotice) output = `[${fuzzyNotice}]\n${output}`;

				return {
					content: [{ type: "text", text: output }],
					details: { totalMatched: grepResult.totalMatched, totalFiles: grepResult.totalFiles },
				};
			},
			renderCall(args, theme, context) {
				if (!context.argsComplete) return new Text("", 0, 0);
				const path = args.path ?? ".";
				return formatTreeCall(theme, toolNames.grep, [`/${args.pattern}/ in ${path}`]);
			},
			renderResult(result, options, theme) {
				return renderTextResult(result, options.expanded, 15, theme);
			},
		});

		pix.registerTool<typeof findSchema, FffFindDetails>({
			name: toolNames.find,
			label: toolNames.find,
			aliases: toolNames.findAliases,
			description: `Fuzzy path search with FFF. Exact tool name: ${toolNames.find}. Matches whole repo-relative paths, frecency-ranked, git-aware. Default limit ${DEFAULT_FIND_LIMIT}.`,
			promptSnippet: "Find files with FFF fuzzy path search",
			promptGuidelines: [
				`Use ${toolNames.find} for fuzzy filename/path exploration when the user names a concept, feature, or symbol.`,
				`The exact FFF find tool name is ${toolNames.find}; do not call ffind unless recovering from a previous failed call.`,
				`Use grep or ffgrep for content; ${toolNames.find} is for paths.`,
			],
			parameters: findSchema,
			renderShell: "self",
			async execute(_toolCallId, params, signal) {
				if (signal?.aborted) throw new Error("Operation aborted");
				const f = await ensureFinder(activeCwd);
				if (!params.cursor) await refreshIndex(f);
				const resumed = params.cursor ? findCursorCache.get(params.cursor) : undefined;
				const effectiveLimit = resumed ? resumed.pageSize : Math.max(1, params.limit ?? DEFAULT_FIND_LIMIT);
				const query = resumed
					? resumed.query
					: buildFffQuery(params.path, params.pattern, params.exclude, activeCwd);
				const pattern = resumed ? resumed.pattern : params.pattern;
				const pageIndex = resumed?.nextPageIndex ?? 0;

				const search = f.fileSearch(query, { pageIndex, pageSize: effectiveLimit });
				if (!search.ok) throw new Error(search.error);

				const formatted = formatFffFindOutput(search.value, effectiveLimit, pattern);
				let output = formatted.output;
				const shownSoFar = pageIndex * effectiveLimit + search.value.items.length;
				const hasMore = search.value.items.length >= effectiveLimit && search.value.totalMatched > shownSoFar;
				const notices: string[] = [];
				if (formatted.weak && formatted.shownCount > 0) {
					notices.push(
						`Query "${pattern}" produced weak scattered fuzzy matches. Output capped at ${formatted.shownCount}/${search.value.totalMatched}.`,
					);
				}
				if (!formatted.weak && hasMore) {
					const remaining = search.value.totalMatched - shownSoFar;
					const cursor = storeFindCursor({
						query,
						pattern,
						pageSize: effectiveLimit,
						nextPageIndex: pageIndex + 1,
					});
					notices.push(
						`${remaining} more match${remaining === 1 ? "" : "es"} available. cursor="${cursor}" to continue`,
					);
				}
				if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;

				return {
					content: [{ type: "text", text: output }],
					details: {
						totalMatched: search.value.totalMatched,
						totalFiles: search.value.totalFiles,
						pageIndex,
						hasMore,
					},
				};
			},
			renderCall(args, theme, context) {
				if (!context.argsComplete) return new Text("", 0, 0);
				const path = args.path ?? ".";
				return formatTreeCall(theme, toolNames.find, [`${args.pattern} in ${path}`]);
			},
			renderResult(result, options, theme) {
				return renderTextResult(result, options.expanded, 20, theme);
			},
		});

		if (process.env.PIX_FFF_MULTIGREP === "1") {
			pix.registerTool<typeof multiGrepSchema, FffMultiGrepDetails>({
				name: toolNames.multiGrep,
				label: toolNames.multiGrep,
				description: "Search file contents for ANY of multiple literal patterns with FFF Aho-Corasick.",
				promptSnippet: "Search multiple literal patterns with FFF",
				promptGuidelines: [
					"Use only when searching for several identifiers at once.",
					"Prefer grep_many for normal batch searches unless literal OR matching is specifically useful.",
				],
				parameters: multiGrepSchema,
				renderShell: "self",
				async execute(_toolCallId, params, signal) {
					if (signal?.aborted) throw new Error("Operation aborted");
					const f = await ensureFinder(activeCwd);
					if (!params.cursor) await refreshIndex(f);
					const effectiveLimit = Math.max(1, params.limit ?? DEFAULT_GREP_LIMIT);
					const result = f.multiGrep({
						patterns: params.patterns,
						constraints: params.constraints,
						maxMatchesPerFile: Math.min(effectiveLimit, 50),
						smartCase: true,
						cursor: (params.cursor ? grepCursorCache.get(params.cursor) : null) ?? null,
						beforeContext: params.context ?? 0,
						afterContext: params.context ?? 0,
					});
					if (!result.ok) throw new Error(result.error);
					let output = formatFffGrepOutput(result.value);
					if (result.value.nextCursor) {
						output += `\n\n[More available. cursor="${storeGrepCursor(result.value.nextCursor)}" to continue]`;
					}
					return {
						content: [{ type: "text", text: output }],
						details: {
							totalMatched: result.value.totalMatched,
							totalFiles: result.value.totalFiles,
							patterns: params.patterns,
						},
					};
				},
				renderCall(args, theme, context) {
					if (!context.argsComplete) return new Text("", 0, 0);
					return formatTreeCall(theme, toolNames.multiGrep, [`${args.patterns.join(", ")}`]);
				},
				renderResult(result, options, theme) {
					return renderTextResult(result, options.expanded, 15, theme);
				},
			});
		}
	}

	pix.on("session_start", (_event, ctx) => {
		activeCwd = ctx.cwd;
		modeAtRegistration = currentMode();
		toolNamesAtRegistration = resolveFffToolNames(modeAtRegistration);
		registerFffTools(toolNamesAtRegistration);

		if (modeAtRegistration !== "tools-only" && !mentionProviderInstalled) {
			mentionProviderInstalled = true;
			ctx.ui.addAutocompleteProvider((fallback) => createFffMentionProvider(getMentionItems, fallback));
		}

		ctx.ui.setStatus("fff", "indexing");
		void ensureFinder(activeCwd)
			.then(() => {
				ctx.ui.setStatus("fff", undefined);
			})
			.catch((error: unknown) => {
				ctx.ui.setStatus("fff", "failed");
				ctx.ui.notify(`FFF init failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			});
	});

	pix.on("session_shutdown", () => {
		destroyFinder();
	});

	pix.registerCommand("fff-mode", {
		description: `Show FFF mode. Configure with --fff-mode <${formatModeList()}> then /reload.`,
		handler: async (args, ctx) => {
			const requested = args.trim();
			if (!requested) {
				ctx.ui.notify(`Current FFF mode: ${modeAtRegistration ?? currentMode()}`, "info");
				return;
			}
			const parsed = parseFffMode(requested);
			if (!parsed) {
				ctx.ui.notify(`Usage: /fff-mode [${formatModeList()}]`, "warning");
				return;
			}
			ctx.ui.notify(
				`Run pix with --fff-mode ${parsed} or PIX_FFF_MODE=${parsed}, then use /reload for tool registration to change.`,
				"info",
			);
		},
	});

	pix.registerCommand("fff-health", {
		description: "Show FFF file finder health and status",
		handler: async (_args, ctx) => {
			const f = await ensureFinder(ctx.cwd);
			const health = f.healthCheck();
			if (!health.ok) {
				ctx.ui.notify(`FFF health check failed: ${health.error}`, "error");
				return;
			}
			const h = health.value;
			const progress = f.getScanProgress();
			const lines = [
				`FFF v${h.version}`,
				`Mode: ${modeAtRegistration ?? currentMode()}`,
				`Tools: ${toolNamesAtRegistration ? `${toolNamesAtRegistration.find}, ${toolNamesAtRegistration.grep}` : "not registered"}`,
				`Git: ${h.git.repositoryFound ? `yes (${h.git.workdir ?? "unknown"})` : "no"}`,
				`Picker: ${h.filePicker.initialized ? `${h.filePicker.indexedFiles ?? 0} files` : "not initialized"}`,
				`Frecency: ${h.frecency.initialized ? "active" : "disabled"}`,
				`Query tracker: ${h.queryTracker.initialized ? "active" : "disabled"}`,
			];
			if (progress.ok) {
				lines.push(
					`Scanning: ${progress.value.isScanning ? "yes" : "no"} (${progress.value.scannedFilesCount} files)`,
				);
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pix.registerCommand("fff-rescan", {
		description: "Trigger FFF to rescan files",
		handler: async (_args, ctx) => {
			const f = await ensureFinder(ctx.cwd);
			const result = f.scanFiles();
			if (!result.ok) {
				ctx.ui.notify(`FFF rescan failed: ${result.error}`, "error");
				return;
			}
			ctx.ui.notify("FFF rescan triggered", "info");
		},
	});
}
