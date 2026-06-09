import path from "node:path";
import type { AutocompleteItem, AutocompleteProvider } from "@chengshiliu16/pix-tui";
import type { GrepResult, MixedItem, SearchResult } from "@ff-labs/fff-node";

export type FffMode = "tools-and-ui" | "tools-only" | "override";

export const VALID_FFF_MODES: FffMode[] = ["tools-and-ui", "tools-only", "override"];

export interface FffToolNames {
	grep: string;
	find: string;
	findAliases: string[];
	multiGrep: string;
}

const FFF_TOOL_NAMES: FffToolNames = {
	grep: "ffgrep",
	find: "fffind",
	findAliases: ["ffind"],
	multiGrep: "fff-multi-grep",
};

const OVERRIDE_TOOL_NAMES: FffToolNames = {
	grep: "grep",
	find: "find",
	findAliases: [],
	multiGrep: "multi_grep",
};

const HOT_FRECENCY = 25;
const WARM_FRECENCY = 20;
const GREP_MAX_LINE_LENGTH = 500;
const FIND_WEAK_SAMPLE_SIZE = 5;

export function resolveFffToolNames(mode: FffMode): FffToolNames {
	return mode === "override" ? OVERRIDE_TOOL_NAMES : FFF_TOOL_NAMES;
}

export function parseFffMode(value: string | undefined): FffMode | undefined {
	return VALID_FFF_MODES.includes(value as FffMode) ? (value as FffMode) : undefined;
}

export function normalizePathConstraint(pathConstraint: string, cwd = process.cwd()): string | null {
	let trimmed = pathConstraint.trim();
	if (!trimmed) return trimmed;

	if (path.isAbsolute(trimmed)) {
		const relative = path.relative(cwd, trimmed).replaceAll(path.sep, "/");
		if (relative === "") return null;
		if (relative.startsWith("../") || relative === ".." || path.isAbsolute(relative)) {
			throw new Error(`Path constraint must be relative to the workspace: ${pathConstraint}`);
		}
		trimmed = relative;
	}

	if (trimmed === "." || trimmed === "./") return null;
	if (trimmed.startsWith("./")) trimmed = trimmed.slice(2);

	const recursiveDir = trimmed.match(/^(.*)\/\*\*(?:\/\*)?$/);
	if (recursiveDir) {
		const dir = recursiveDir[1];
		if (dir && !/[*?[{]/.test(dir)) return `${dir}/`;
	}

	if (trimmed.startsWith("/") || trimmed.endsWith("/")) return trimmed;
	if (/[*?[{]/.test(trimmed)) return trimmed;

	const lastSegment = trimmed.split("/").pop() ?? "";
	if (/\.[a-zA-Z][a-zA-Z0-9]{0,9}$/.test(lastSegment)) return trimmed;
	return `${trimmed}/`;
}

export function normalizeExcludes(exclude: string | string[] | undefined, cwd = process.cwd()): string[] {
	if (!exclude) return [];
	const list = Array.isArray(exclude) ? exclude : [exclude];
	const out: string[] = [];
	for (const raw of list) {
		const parts = raw
			.split(/[,\s]+/)
			.map((s) => s.trim())
			.filter(Boolean);
		for (const part of parts) {
			const stripped = part.startsWith("!") ? part.slice(1) : part;
			const normalized = normalizePathConstraint(stripped, cwd);
			if (normalized) out.push(`!${normalized}`);
		}
	}
	return out;
}

export function buildFffQuery(
	pathConstraint: string | undefined,
	pattern: string,
	exclude?: string | string[],
	cwd = process.cwd(),
): string {
	const parts: string[] = [];
	if (pathConstraint) {
		const normalized = normalizePathConstraint(pathConstraint, cwd);
		if (normalized) parts.push(normalized);
	}
	parts.push(...normalizeExcludes(exclude, cwd));
	parts.push(pattern);
	return parts.join(" ");
}

export function fffFileAnnotation(item: {
	gitStatus?: string;
	totalFrecencyScore?: number;
	accessFrecencyScore?: number;
}): string {
	const git = item.gitStatus;
	if (git && git !== "clean" && git !== "unknown" && git !== "") {
		return `  [${git} in git]`;
	}

	const frecency = item.totalFrecencyScore ?? item.accessFrecencyScore ?? 0;
	if (frecency >= HOT_FRECENCY) return "  [VERY often touched file]";
	if (frecency >= WARM_FRECENCY) return "  [often touched file]";
	return "";
}

function truncateLine(line: string, max = GREP_MAX_LINE_LENGTH): string {
	const trimmed = line.trim();
	return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}...`;
}

export function formatFffGrepOutput(result: GrepResult): string {
	if (result.items.length === 0) return "No matches found";

	const lines: string[] = [];
	let currentFile = "";

	for (const match of result.items) {
		if (match.relativePath !== currentFile) {
			if (lines.length > 0) lines.push("");
			currentFile = match.relativePath;
			lines.push(`${currentFile}${fffFileAnnotation(match)}`);
		}

		match.contextBefore?.forEach((line: string, index: number) => {
			const lineNum = match.lineNumber - match.contextBefore!.length + index;
			lines.push(` ${lineNum}- ${truncateLine(line)}`);
		});

		lines.push(` ${match.lineNumber}: ${truncateLine(match.lineContent)}`);

		match.contextAfter?.forEach((line: string, index: number) => {
			const lineNum = match.lineNumber + 1 + index;
			lines.push(` ${lineNum}- ${truncateLine(line)}`);
		});
	}

	return lines.join("\n");
}

function weakScoreThreshold(pattern: string): number {
	const perfect = pattern.length * 12;
	return Math.floor((perfect * 50) / 100);
}

export interface FormattedFffFind {
	output: string;
	weak: boolean;
	shownCount: number;
}

export function formatFffFindOutput(result: SearchResult, limit: number, pattern: string): FormattedFffFind {
	if (result.items.length === 0) {
		return {
			output: "No files found matching pattern",
			weak: false,
			shownCount: 0,
		};
	}

	const topScore = result.scores[0]?.total ?? 0;
	const weak = topScore < weakScoreThreshold(pattern);
	const effectiveLimit = weak ? Math.min(FIND_WEAK_SAMPLE_SIZE, limit) : limit;
	const shown = result.items.slice(0, effectiveLimit);

	return {
		output: shown.map((item) => `${item.relativePath}${fffFileAnnotation(item)}`).join("\n"),
		weak,
		shownCount: shown.length,
	};
}

export function isWildcardOnlyPattern(pattern: string, hasRegexSyntax: boolean): boolean {
	const trimmed = pattern.trim();
	return (
		hasRegexSyntax && /^(?:[.^$]*(?:[.][*+?]|\*|\+)[.^$]*|[.^$\s]*|\.\*\??|\.\*[+?]?|\.\+\??|\.|\*|\?)$/.test(trimmed)
	);
}

export function extractAtPrefix(textBeforeCursor: string): string | null {
	const match = textBeforeCursor.match(/(?:^|[ \t])(@(?:"[^"]*|[^\s]*))$/);
	return match?.[1] ?? null;
}

export function buildAtCompletionValue(pathValue: string): string {
	return pathValue.includes(" ") ? `@"${pathValue}"` : `@${pathValue}`;
}

export function mixedItemToAutocompleteItem(mixed: MixedItem): AutocompleteItem {
	if (mixed.type === "directory") {
		return {
			value: buildAtCompletionValue(mixed.item.relativePath),
			label: mixed.item.dirName,
			description: mixed.item.relativePath,
		};
	}
	return {
		value: buildAtCompletionValue(mixed.item.relativePath),
		label: mixed.item.fileName,
		description: mixed.item.relativePath,
	};
}

export function createFffMentionProvider(
	getItems: (query: string, signal: AbortSignal) => Promise<AutocompleteItem[]>,
	fallback: AutocompleteProvider,
): AutocompleteProvider {
	return {
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const currentLine = lines[cursorLine] || "";
			const prefix = extractAtPrefix(currentLine.slice(0, cursorCol));
			if (!prefix || options.signal.aborted) {
				return fallback.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const query = prefix.startsWith('@"') ? prefix.slice(2) : prefix.slice(1);
			const items = await getItems(query, options.signal);
			if (options.signal.aborted || items.length === 0) return null;
			return { items, prefix };
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			if (!prefix.startsWith("@")) {
				return fallback.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			}

			const currentLine = lines[cursorLine] || "";
			const before = currentLine.slice(0, cursorCol - prefix.length);
			const after = currentLine.slice(cursorCol);
			const suffix = item.label.endsWith("/") ? "" : " ";
			const newLine = before + item.value + suffix + after;
			const newLines = [...lines];
			newLines[cursorLine] = newLine;
			return {
				lines: newLines,
				cursorLine,
				cursorCol: before.length + item.value.length + suffix.length,
			};
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return fallback.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? false;
		},
	};
}
