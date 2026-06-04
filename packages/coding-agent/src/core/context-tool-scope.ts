/**
 * Shared tool-argument and path-scope parsing for context-window management.
 *
 * The aging, stale-read pruning, and reachability passes all need to pull file
 * paths out of tool-call arguments and normalize them for comparison. These
 * helpers were previously copied verbatim across context-prune.ts and
 * context-reachability.ts (and the bash-read regex across context-aging.ts too);
 * centralizing them keeps the three passes from drifting apart.
 *
 * Note: this module intentionally does NOT include aging's anchor extraction
 * (getReadManyAnchor etc.) — those have different semantics (a single
 * human-readable label, not a comparable scope) and stay in context-aging.ts.
 */

/** Tools that mutate file content; a mutation can make earlier reads stale. */
export const MUTATION_TOOLS = new Set(["edit", "write"]);

/**
 * Regex for bash commands that read file content.
 * Captured group 1 is the file path. Only simple, single-file reads are
 * detected — pipes, redirects, and heredocs are intentionally excluded.
 */
export const BASH_READ_COMMAND_RE = /\b(?:cat|head|tail|less|more)\s+(?:--?\w+(?:=\S+)?\s+)*["']?([^\s"';|&<>]+)["']?/;

/** Per-file details for read_many batch tools. */
export interface ReadFileEntry {
	path: string;
	offset?: number;
	limit?: number;
}

/**
 * Normalize a path to absolute form if cwd is provided and the path is
 * relative. This allows matching between tools that use relative paths
 * (read_many, grep_many) and mutations that use absolute paths (edit, write).
 * When cwd is not provided, returns the path unchanged.
 */
export function normalizePath(path: string, cwd: string | undefined): string {
	if (!cwd) return path;
	// Already absolute
	if (path.startsWith("/")) return path;
	// Resolve relative path against cwd
	return `${cwd.replace(/\/+$/, "")}/${path}`;
}

/**
 * Extract the primary file path argument from a tool call. Models call
 * edit/write/read with `path`, `file_path`, or `filePath`; the persisted tool
 * call keeps whichever the model emitted, so accept all three.
 */
export function getPathArg(args: Record<string, unknown> | undefined): string | undefined {
	if (!args) return undefined;
	const path = args.path ?? args.file_path ?? args.filePath;
	return typeof path === "string" && path.length > 0 ? path : undefined;
}

/** Extract a numeric argument by key, or undefined if not a number. */
export function getNumberArg(args: Record<string, unknown> | undefined, key: string): number | undefined {
	const value = args?.[key];
	return typeof value === "number" ? value : undefined;
}

/**
 * Extract a file path from a bash command if it reads file content.
 * Returns undefined for non-file-reading commands or ambiguous cases.
 */
export function getBashReadPath(args: Record<string, unknown> | undefined): string | undefined {
	if (!args) return undefined;
	const command = args.command;
	if (typeof command !== "string") return undefined;
	// Skip heredocs and redirect-heavy commands — too ambiguous.
	if (/<<|>>|>/.test(command) && !/\bcat\s/.test(command)) return undefined;
	const match = BASH_READ_COMMAND_RE.exec(command);
	return match?.[1] || undefined;
}

/**
 * Extract all file paths from a read_many call.
 * read_many accepts either `files: [{path, offset?, limit?}]` or
 * `paths: [string]` with shared offset/limit.
 */
export function getReadManyPaths(args: Record<string, unknown> | undefined): ReadFileEntry[] {
	if (!args) return [];
	const result: ReadFileEntry[] = [];
	const files = args.files;
	if (Array.isArray(files)) {
		for (const file of files) {
			if (typeof file === "object" && file !== null && typeof file.path === "string" && file.path.length > 0) {
				result.push({
					path: file.path,
					offset: typeof file.offset === "number" ? file.offset : undefined,
					limit: typeof file.limit === "number" ? file.limit : undefined,
				});
			}
		}
	}
	const paths = args.paths;
	if (result.length === 0 && Array.isArray(paths)) {
		const offset = typeof args.offset === "number" ? args.offset : undefined;
		const limit = typeof args.limit === "number" ? args.limit : undefined;
		for (const p of paths) {
			if (typeof p === "string" && p.length > 0) {
				result.push({ path: p, offset, limit });
			}
		}
	}
	return result;
}

/**
 * Extract all search scopes from a grep_many call.
 * grep_many accepts `searches: [{pattern, path?, ...}]` or single-search
 * shorthand with top-level `pattern`/`path`.
 * Returns paths only (patterns are not needed for scope tracking).
 * When a search has no path, cwd is used as the default scope.
 */
export function getGrepManyPaths(args: Record<string, unknown> | undefined, cwd?: string): string[] {
	if (!args) return [];
	const result: string[] = [];
	const searches = args.searches;
	if (Array.isArray(searches)) {
		for (const s of searches) {
			if (typeof s === "object" && s !== null) {
				const p = s.path;
				if (typeof p === "string" && p.length > 0) {
					result.push(p);
				} else if (cwd) {
					result.push(cwd);
				}
			}
		}
	}
	// Single-search shorthand
	if (result.length === 0) {
		const p = args.path;
		if (typeof p === "string" && p.length > 0) {
			result.push(p);
		} else if (cwd && typeof args.pattern === "string") {
			result.push(cwd);
		}
	}
	return result;
}

/**
 * Extract all directory paths from an ls_many call.
 * ls_many accepts `paths: [string]`.
 */
export function getLsManyPaths(args: Record<string, unknown> | undefined, cwd?: string): string[] {
	if (!args) return [];
	const result: string[] = [];
	const paths = args.paths;
	if (Array.isArray(paths)) {
		for (const p of paths) {
			if (typeof p === "string" && p.length > 0) result.push(p);
		}
	}
	if (result.length === 0 && cwd) {
		result.push(cwd);
	}
	return result;
}
