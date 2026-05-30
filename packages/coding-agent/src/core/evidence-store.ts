import { createHash } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

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
 * Check if output exceeds thresholds and save as evidence if so.
 * Returns a summary to replace the original output, or undefined if
 * the output is small enough to keep inline.
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
		await writeFile(rawPath, outputText, "utf-8");
		await pruneEvidenceStore(dir);
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

	return { id, summary, rawPath, rawLines: lineCount, rawBytes: bytes, exitCode };
}

async function pruneEvidenceStore(dir: string): Promise<void> {
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		const now = Date.now();
		const protectedFiles: Array<{ path: string; size: number; mtimeMs: number }> = [];
		const evictableFiles: Array<{ path: string; size: number; mtimeMs: number }> = [];

		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".txt")) continue;
			const path = join(dir, entry.name);
			const fileStat = await stat(path);
			const file = { path, size: fileStat.size, mtimeMs: fileStat.mtimeMs };

			if (now - fileStat.mtimeMs <= PROTECT_WINDOW_MS) {
				protectedFiles.push(file);
			} else {
				evictableFiles.push(file);
			}
		}

		if (evictableFiles.length <= MAX_FILES) {
			const totalBytes = evictableFiles.reduce((s, f) => s + f.size, 0);
			if (totalBytes <= MAX_BYTES) return;
		}

		evictableFiles.sort((a, b) => a.mtimeMs - b.mtimeMs);
		const keepCount = Math.ceil(MAX_FILES * 0.8);
		const toRemove = evictableFiles.length - keepCount;
		for (let index = 0; index < toRemove; index++) {
			await rm(evictableFiles[index].path, { force: true });
		}

		if (toRemove > 0) {
			const remaining = evictableFiles.slice(toRemove);
			const remainingBytes = remaining.reduce((s, f) => s + f.size, 0);
			if (remainingBytes > MAX_BYTES) {
				const overBytes = remainingBytes - MAX_BYTES;
				let freedBytes = 0;
				for (const file of remaining) {
					if (freedBytes >= overBytes) break;
					await rm(file.path, { force: true });
					freedBytes += file.size;
				}
			}
		}
	} catch {
		// best-effort
	}
}
