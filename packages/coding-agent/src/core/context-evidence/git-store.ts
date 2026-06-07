import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pruneEvidenceFiles } from "./evidence-prune.ts";
import {
	canReuseGitEvidenceWithoutExecuting,
	detectGitEvidenceVolatility,
	detectGitInspection,
	type GitEvidenceScope,
	type GitEvidenceSeriesType,
	type GitEvidenceVolatility,
	type GitInspectionKind,
	getGitContextKey,
	getGitEvidenceSeriesKey,
	isGitEvidenceText,
} from "./git-detect.ts";
import { COMPACT_LEDGER_CHARS, DETAILED_LEDGER_CHARS, formatDigest } from "./git-format.ts";
import { parseGitOutput } from "./git-parse.ts";

const MAX_RAW_BYTES = 20 * 1024 * 1024;
const MAX_SESSION_BYTES = 200 * 1024 * 1024;
const MAX_RECORDS = 200;
const EVIDENCE_PROTECT_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface GitEvidenceDetails {
	id: string;
	command: string;
	kind: GitInspectionKind;
	scope?: GitEvidenceScope;
	volatility: GitEvidenceVolatility;
	gitContextKey?: string;
	/** Series key for dynamic evidence supersede. See GitEvidenceSeriesType for valid values. */
	seriesKey?: GitEvidenceSeriesType;
	supersededBy?: string;
	rawIncomplete: boolean;
	rawStorageFailed: boolean;
	rawPath?: string;
	rawBytes: number;
	rawLines: number;
	outputHash: string;
	compactText: string;
	/** Full detailed digest with key changed lines. */
	detailedText: string;
}

export interface GitEvidenceResult {
	text: string;
	details: GitEvidenceDetails;
}

function hashText(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf-8");
}

function truncateRawText(text: string): { text: string; rawTruncated: boolean } {
	if (byteLength(text) <= MAX_RAW_BYTES) return { text, rawTruncated: false };
	const buffer = Buffer.from(text, "utf-8");
	let cutByte = MAX_RAW_BYTES;
	while (cutByte > 0 && (buffer[cutByte] & 0xc0) === 0x80) cutByte--;
	return {
		text: `${buffer.subarray(0, cutByte).toString("utf-8")}\n[Git evidence raw output truncated at ${MAX_RAW_BYTES} bytes.]`,
		rawTruncated: true,
	};
}

async function readRawText(
	output: string,
	fullOutputPath: string | undefined,
	visibleOutputIncomplete: boolean,
): Promise<{ text: string; rawTruncated: boolean; rawIncomplete: boolean }> {
	if (!fullOutputPath) return { ...truncateRawText(output), rawIncomplete: visibleOutputIncomplete };
	try {
		const source = await stat(fullOutputPath);
		if (source.size > MAX_RAW_BYTES) {
			const visible = truncateRawText(output);
			return { text: visible.text, rawTruncated: true, rawIncomplete: true };
		}
		return { ...truncateRawText(await readFile(fullOutputPath, "utf-8")), rawIncomplete: false };
	} catch {
		return { ...truncateRawText(output), rawIncomplete: true };
	}
}

async function persistRaw(cwd: string, id: string, rawText: string): Promise<string | undefined> {
	try {
		const dir = join(cwd, ".pix", "session-evidence", "git");
		await mkdir(dir, { recursive: true });
		const rawPath = join(dir, `${id}.txt`);
		try {
			await stat(rawPath);
			return rawPath;
		} catch {
			await writeFile(rawPath, rawText, "utf-8");
		}
		await pruneEvidenceFiles(dir, {
			maxFiles: MAX_RECORDS,
			maxBytes: MAX_SESSION_BYTES,
			protectWindowMs: EVIDENCE_PROTECT_WINDOW_MS,
			extension: ".txt",
		});
		return rawPath;
	} catch {
		return undefined;
	}
}

export const gitEvidenceCache = new Map<string, { text: string; details: GitEvidenceDetails }>();

function normalizeCachedCommand(command: string): string {
	return command
		.replace(/\s+/g, " ")
		.replace(/\b2>&1\b/g, "")
		.trim();
}

/**
 * 生成 git evidence 缓存键。
 *
 * 注意：缓存键依赖 resolved spawn context（spawnHook 处理后的 cwd 和 env）。
 * 如果 spawnHook 返回不稳定的 context（如包含时间戳的环境变量），会破坏缓存命中率。
 *
 * @param command - git 命令
 * @param cwd - 工作目录（应使用 spawnHook 解析后的 cwd）
 * @param env - 环境变量（应使用 spawnHook 解析后的 env）
 */
export function getGitEvidenceCacheKey(command: string, cwd: string, env?: NodeJS.ProcessEnv): string {
	return `${normalizeCachedCommand(command)}\x00${getGitContextKey(command, cwd, env)}`;
}

export function clearGitEvidenceCache(): void {
	gitEvidenceCache.clear();
}

export async function createGitEvidenceResult(
	command: string,
	cwd: string,
	output: string,
	fullOutputPath?: string,
	env?: NodeJS.ProcessEnv,
	visibleOutputIncomplete = false,
): Promise<GitEvidenceResult | undefined> {
	const info = detectGitInspection(command);
	if (!info || isGitEvidenceText(output)) return undefined;

	const gitContextKey = getGitContextKey(command, cwd, env);
	const cacheKey = canReuseGitEvidenceWithoutExecuting(command)
		? `${normalizeCachedCommand(command)}\x00${gitContextKey}`
		: undefined;
	const cached = cacheKey ? gitEvidenceCache.get(cacheKey) : undefined;
	if (cached) return cached;

	const raw = await readRawText(output, fullOutputPath, visibleOutputIncomplete);
	const rawText = raw.text;
	const outputHash = hashText(rawText);
	const id = `git-${info.kind}-${outputHash.slice(0, 12)}`;
	const rawPath = await persistRaw(cwd, id, rawText);
	const rawStorageFailed = rawPath === undefined;
	const digest = parseGitOutput(command, info.kind, rawText, raw.rawTruncated, raw.rawIncomplete, rawStorageFailed);
	const volatility = detectGitEvidenceVolatility(command, info.kind);
	const seriesKey = getGitEvidenceSeriesKey(command, info.kind, volatility);
	const text = formatDigest(id, digest, rawPath, { compact: true, maxChars: COMPACT_LEDGER_CHARS });
	const detailedText = formatDigest(id, digest, rawPath, { maxChars: DETAILED_LEDGER_CHARS });

	const result: GitEvidenceResult = {
		text,
		details: {
			id,
			command,
			kind: info.kind,
			scope: digest.scope,
			volatility,
			gitContextKey,
			seriesKey,
			rawIncomplete: raw.rawIncomplete,
			rawStorageFailed,
			rawPath,
			rawBytes: digest.rawBytes,
			rawLines: digest.rawLines,
			outputHash,
			compactText: text,
			detailedText,
		},
	};

	if (cacheKey) gitEvidenceCache.set(cacheKey, result);
	return result;
}
