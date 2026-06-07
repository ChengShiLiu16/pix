import { createHash } from "node:crypto";

const GIT_EVIDENCE_KIND_PATTERN = "(?:log|show|diff|diff-tree|status|blame|grep)";
const GIT_EVIDENCE_DISPLAY_RE = new RegExp(
	String.raw`(?:^|\n)(?:Git evidence captured:|==== (?:Evidence: |Evidence superseded: )?git-${GIT_EVIDENCE_KIND_PATTERN}-[0-9a-f]{12} ====|\[Evidence span git-${GIT_EVIDENCE_KIND_PATTERN}-[0-9a-f]{12}:)`,
	"u",
);

const READ_ONLY_GIT_KINDS = new Set(["log", "show", "diff", "diff-tree", "status", "blame", "grep"]);
const GIT_GLOBAL_OPTION_PATTERN = String.raw`(?:-C\s+\S+\s+|-c\s+\S+\s+|--git-dir(?:=\S+|\s+\S+)\s+|--work-tree(?:=\S+|\s+\S+)\s+|-[^\s]+\s+)`;
const GIT_CONTEXT_ENV_KEYS = [
	"HOME",
	"XDG_CONFIG_HOME",
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_NAMESPACE",
	"GIT_COMMON_DIR",
	"GIT_CONFIG_GLOBAL",
	"GIT_CONFIG_SYSTEM",
	"GIT_CONFIG_NOSYSTEM",
	"GIT_CEILING_DIRECTORIES",
	"GIT_EXTERNAL_DIFF",
	"GIT_DIFF_OPTS",
];

export const GIT_EVIDENCE_PREFIX = "Git evidence captured:";

export type GitInspectionKind = "log" | "show" | "diff" | "diff-tree" | "status" | "blame" | "grep";
export type GitEvidenceScopeType = "current_head" | "all_refs" | "working_tree" | "explicit_refs" | "unknown";
export type GitEvidenceVolatility = "immutable" | "dynamic" | "broad" | "unknown";

export interface GitInspectionInfo {
	kind: GitInspectionKind;
}

export interface GitEvidenceScope {
	type: GitEvidenceScopeType;
	warnings: string[];
}

export function isGitEvidenceText(text: string): boolean {
	return text.startsWith(GIT_EVIDENCE_PREFIX);
}

export function isGitEvidenceDisplayText(text: string): boolean {
	return GIT_EVIDENCE_DISPLAY_RE.test(text.trimStart());
}

function gitCommandMatches(command: string): RegExpMatchArray[] {
	const re = new RegExp(String.raw`\bgit\s+(?<global>(?:${GIT_GLOBAL_OPTION_PATTERN})*)(?<kind>[a-z][\w-]*)\b`, "gu");
	return Array.from(command.matchAll(re));
}

export function detectGitInspection(command: string): GitInspectionInfo | undefined {
	const matches = gitCommandMatches(command);
	if (matches.length === 0) return undefined;

	let firstKind: GitInspectionKind | undefined;
	for (const match of matches) {
		const kind = match.groups?.kind;
		if (!kind || !READ_ONLY_GIT_KINDS.has(kind)) return undefined;
		firstKind ??= kind as GitInspectionKind;
	}
	return firstKind ? { kind: firstKind } : undefined;
}

function hasFullHexObjectRef(command: string): boolean {
	return /\b[0-9a-f]{40}(?::[^\s]+|\b|[~^])/u.test(command);
}

function isHexObjectArg(token: string): boolean {
	return /^[0-9a-f]{40}(?::\S+|[~^]\d*)?$/u.test(token);
}

function hasShellControl(command: string): boolean {
	return /(?:&&|\|\||[;|`]|\$\(|\n)/u.test(command);
}

function hasDynamicRef(command: string): boolean {
	return (
		/\b(?:HEAD|FETCH_HEAD|ORIG_HEAD|MERGE_HEAD)(?:\b|[~^])/u.test(command) || /\S(?:\.\.|\.\.\.)\S/u.test(command)
	);
}

function hasBroadRefOption(command: string): boolean {
	return /\B--(?:all|branches|remotes)\b/u.test(command) || /\brefs\/stash\b/u.test(command);
}

function gitSubcommandTail(command: string): { kind: string; tail: string } | undefined {
	const matches = gitCommandMatches(command);
	if (matches.length !== 1) return undefined;
	const match = matches[0];
	const kind = match.groups?.kind;
	if (!kind) return undefined;
	return { kind, tail: command.slice((match.index ?? 0) + match[0].length).trim() };
}

function gitGlobalContext(command: string): string {
	const matches = gitCommandMatches(command);
	if (matches.length !== 1) return "";
	return (matches[0].groups?.global ?? "").replace(/\s+/gu, " ").trim();
}

export function getGitContextKey(command: string, cwd: string, env?: NodeJS.ProcessEnv): string {
	const envKeys = new Set(GIT_CONTEXT_ENV_KEYS);
	for (const key of Object.keys(env ?? {})) {
		if (key.startsWith("GIT_")) envKeys.add(key);
	}
	const envContext = [...envKeys]
		.sort()
		.map((key) => `${key}=${env?.[key] ?? ""}`)
		.join("\x1e");
	return createHash("sha256")
		.update(`${cwd}\x1f${gitGlobalContext(command)}\x1f${envContext}`)
		.digest("hex");
}

function refArgsFromSubcommandTail(tail: string): string[] {
	const tokens = tail.split(/\s+/u).filter((token) => token.length > 0);
	const refs: string[] = [];
	let skipNext = false;
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (skipNext) {
			skipNext = false;
			continue;
		}
		if (token === "--") break;
		if (token === "--format" || token === "--pretty" || token === "--max-count" || token === "-n") {
			skipNext = true;
			continue;
		}
		if (token.startsWith("--format=") || token.startsWith("--pretty=") || token.startsWith("--max-count=")) {
			continue;
		}
		if (token.startsWith("-")) continue;
		refs.push(token);
	}
	return refs;
}

function hasSingleCommitLogLimit(tail: string): boolean {
	return /(?:^|\s)(?:-1|--max-count=1)(?:\s|$)/u.test(tail) || /(?:^|\s)(?:-n|--max-count)\s+1(?:\s|$)/u.test(tail);
}

function hasPathspecSeparator(tail: string): boolean {
	return /(?:^|\s)--(?:\s|$)/u.test(tail);
}

function hasCurrentStateFilter(tail: string): boolean {
	if (hasPathspecSeparator(tail)) return true;
	return /\s--(?:porcelain|ignored|untracked-files|pathspec-from-file|diff-filter|name-only|name-status)(?:[=\s]|$)/u.test(
		` ${tail} `,
	);
}

export function canReuseGitEvidenceWithoutExecuting(command: string): boolean {
	if (hasShellControl(command) || hasBroadRefOption(command) || hasDynamicRef(command)) return false;
	const parsed = gitSubcommandTail(command);
	if (!parsed) return false;
	const { kind, tail } = parsed;
	if (hasPathspecSeparator(tail)) return false;
	if (kind !== "show" && kind !== "diff-tree" && kind !== "log") return false;
	if (kind === "log" && !hasSingleCommitLogLimit(tail)) return false;
	const refs = refArgsFromSubcommandTail(tail);
	return refs.length > 0 && refs.every(isHexObjectArg) && hasFullHexObjectRef(command);
}

export function detectGitEvidenceVolatility(command: string, kind: GitInspectionKind): GitEvidenceVolatility {
	if (hasBroadRefOption(command)) return "broad";
	if (canReuseGitEvidenceWithoutExecuting(command)) return "immutable";
	if (kind === "status" || kind === "diff") return "dynamic";
	if (hasDynamicRef(command)) return "dynamic";
	if (kind === "log" && !hasFullHexObjectRef(command)) return "dynamic";
	return "unknown";
}

/**
 * 动态 git evidence 系列类型定义。
 * 用于将相同类型的动态 git 命令归为一组，以便后续的 evidence supersede。
 */
export type GitEvidenceSeriesType =
	| "working_tree:status"
	| "working_tree:diff:unstaged"
	| "working_tree:diff:cached"
	| "working_tree:diff:head"
	| "head:show"
	| "head:log";

/**
 * 为动态 git evidence 确定 series key。
 *
 * Series key 用于识别"相同类型的动态 git 命令"，后执行的会 supersede 先执行的。
 * 只有不带路径过滤的全局状态查询才会归入 series，因为只有它们代表相同的当前状态快照。
 *
 * @returns series key 字符串，或 undefined 表示该命令不属于任何 series
 */
export function getGitEvidenceSeriesKey(
	command: string,
	kind: GitInspectionKind,
	volatility: GitEvidenceVolatility,
): GitEvidenceSeriesType | undefined {
	if (volatility !== "dynamic" || hasShellControl(command)) return undefined;
	const parsed = gitSubcommandTail(command);
	if (!parsed || parsed.kind !== kind) return undefined;
	const tail = parsed.tail;
	const refs = refArgsFromSubcommandTail(tail);

	if (kind === "status") {
		return hasCurrentStateFilter(tail) || refs.length > 0 ? undefined : "working_tree:status";
	}
	if (kind === "diff") {
		if (hasPathspecSeparator(tail)) return undefined;
		if (/\s--(?:cached|staged)(?:\s|$)/u.test(` ${tail} `)) {
			return refs.length === 0 || (refs.length === 1 && refs[0] === "HEAD") ? "working_tree:diff:cached" : undefined;
		}
		if (refs.length === 0) return "working_tree:diff:unstaged";
		if (refs.length === 1 && refs[0] === "HEAD") return "working_tree:diff:head";
		return undefined;
	}
	if (kind === "show") {
		return !hasPathspecSeparator(tail) && refs.length === 1 && refs[0] === "HEAD" ? "head:show" : undefined;
	}
	if (kind === "log" && refs.length === 0) return hasCurrentStateFilter(tail) ? undefined : "head:log";
	return undefined;
}

function hasExplicitGitRef(command: string): boolean {
	if (hasDynamicRef(command)) return true;
	if (/\b[0-9a-f]{7,40}(?:\b|[~^])/u.test(command)) return true;
	return /\b(?:origin|upstream)\/[^\s]+/u.test(command);
}

export function detectGitEvidenceScope(command: string, kind: GitInspectionKind): GitEvidenceScope {
	if (hasBroadRefOption(command)) {
		return {
			type: "all_refs",
			warnings: [
				"Scope warning: this evidence may include commits outside the current HEAD lineage (for example remotes, branches, or stash refs). Keep conclusions within this captured scope unless separate evidence proves reachability.",
			],
		};
	}
	if (kind === "status") return { type: "working_tree", warnings: [] };
	if (kind === "log") {
		if (hasExplicitGitRef(command)) return { type: "explicit_refs", warnings: [] };
		return { type: "current_head", warnings: [] };
	}
	if (kind === "show" || kind === "diff" || kind === "diff-tree" || kind === "blame") {
		return { type: hasExplicitGitRef(command) ? "explicit_refs" : "working_tree", warnings: [] };
	}
	return { type: "unknown", warnings: [] };
}
