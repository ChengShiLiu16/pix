import { createHash } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pruneEvidenceFiles } from "./context-evidence/evidence-prune.ts";

/**
 * Generic evidence store for large bash outputs (test output, grep results, etc.).
 *
 * When a bash command produces output exceeding the threshold, the raw output is
 * saved to `.pix/evidence/<hash>.txt` and replaced in-context with a compact
 * summary. The model can use `read` with offset/limit to inspect specific parts.
 *
 * This is different from the git-evidence system (`.pix/session-evidence/git/`)
 * which handles git inspection commands with structured digest parsing.
 * This store is simpler: save everything, no parsing, just truncation.
 */

export const EVIDENCE_DIR = ".pix/evidence";

/** Outputs larger than this (in bytes) are saved as evidence. */
export const BIG_OUTPUT_THRESHOLD_BYTES = 3 * 1024;

/** Outputs with more lines than this are saved as evidence. */
export const BIG_OUTPUT_THRESHOLD_LINES = 100;

const MAX_FILES = 50;
const MAX_BYTES = 50 * 1024 * 1024;
const PROTECT_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface BigOutputResult {
	id: string;
	summary: string;
	rawPath: string;
	rawLines: number;
	rawBytes: number;
	exitCode: number | null;
}

/**
 * 检查输出是否超过阈值并保存为 evidence。
 *
 * 使用 SHA256 的前 12 位作为文件名。虽然理论上存在碰撞可能，但：
 * 1. 在写入前会先检查文件是否已存在（stat）
 * 2. 如果文件已存在，说明内容相同（去重），直接复用
 * 3. SHA256 前 12 位（48 bits）的碰撞概率极低，在典型 session 规模下可忽略
 *
 * 返回摘要以替换原始输出，或 undefined 表示输出足够小可以内联保留。
 */
export async function tryStoreBigOutput(
	cwd: string,
	outputText: string,
	exitCode: number | null,
): Promise<BigOutputResult | undefined> {
	const bytes = Buffer.byteLength(outputText, "utf-8");
	const lines = outputText.split("\n");
	const lineCount = outputText.endsWith("\n") ? lines.length - 1 : lines.length;

	if (bytes <= BIG_OUTPUT_THRESHOLD_BYTES && lineCount <= BIG_OUTPUT_THRESHOLD_LINES) {
		return undefined;
	}

	const hash = createHash("sha256").update(outputText).digest("hex").slice(0, 12);
	const id = `big-output-${hash}`;
	const dir = join(cwd, EVIDENCE_DIR);
	const rawPath = join(dir, `${id}.txt`);

	try {
		await mkdir(dir, { recursive: true });
		try {
			await stat(rawPath);
			// 文件已存在，内容相同（基于 hash），直接复用
		} catch {
			await writeFile(rawPath, outputText, "utf-8");
			await pruneEvidenceFiles(dir, {
				maxFiles: MAX_FILES,
				maxBytes: MAX_BYTES,
				protectWindowMs: PROTECT_WINDOW_MS,
				extension: ".txt",
			});
		}
	} catch {
		// best-effort
		return undefined;
	}

	const lastLines = lines.slice(-5).join("\n");
	const summary = [
		`[Big output saved as ${id}.txt: ${lineCount} lines, ${bytes} bytes, exit=${exitCode ?? "?"}]`,
		`Use read with offset/limit to inspect: read ${rawPath} offset=1 limit=100`,
		`--- last 5 lines ---`,
		lastLines,
	].join("\n");

	return {
		id,
		summary: `==== Big Output: ${id} ====\n${summary}\n====`,
		rawPath,
		rawLines: lineCount,
		rawBytes: bytes,
		exitCode,
	};
}
