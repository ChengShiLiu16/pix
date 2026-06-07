import { detectGitEvidenceScope, type GitEvidenceScope, type GitInspectionKind } from "./git-detect.ts";

const MAX_KEY_LINES = 4;
const MAX_LINE_CHARS = 180;

export interface GitHunkDigest {
	header: string;
	rawStartLine: number;
	rawEndLine?: number;
	keyAddedLines: string[];
	keyRemovedLines: string[];
	omittedLineCount: number;
}

export interface GitFileDigest {
	path: string;
	oldPath?: string;
	status?: string;
	additions: number;
	deletions: number;
	hunks: GitHunkDigest[];
}

export interface GitCommitDigest {
	sha: string;
	subject?: string;
	author?: string;
	date?: string;
}

export interface GitEvidenceDigest {
	kind: GitInspectionKind;
	command: string;
	scope: GitEvidenceScope;
	commits: GitCommitDigest[];
	files: GitFileDigest[];
	rawLines: number;
	rawBytes: number;
	rawTruncated: boolean;
	rawIncomplete: boolean;
	rawStorageFailed: boolean;
	parseIncomplete: boolean;
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf-8");
}

function shortenLine(line: string): string {
	const trimmed = line.trimEnd();
	return trimmed.length <= MAX_LINE_CHARS ? trimmed : `${trimmed.slice(0, MAX_LINE_CHARS)}...`;
}

function countLines(text: string): number {
	if (text.length === 0) return 0;
	const lines = text.split("\n");
	return text.endsWith("\n") ? lines.length - 1 : lines.length;
}

function normalizeDiffPath(path: string): string {
	if (path === "/dev/null") return path;
	return path.replace(/^"|"$/gu, "").replace(/^[ab]\//u, "");
}

function currentHunk(file: GitFileDigest): GitHunkDigest | undefined {
	return file.hunks[file.hunks.length - 1];
}

function addKeyLine(lines: string[], line: string): boolean {
	if (lines.length >= MAX_KEY_LINES) return false;
	lines.push(shortenLine(line));
	return true;
}

function parseCustomLogCommits(lines: string[]): GitCommitDigest[] {
	const commits: GitCommitDigest[] = [];
	for (let i = 0; i + 3 < lines.length; i++) {
		const markerMatch = /^(?:---\s*COMMIT\s+|=+\s*COMMIT:?\s*)([0-9a-f]{7,40})\s*(?:---|=+)?$/u.exec(lines[i]);
		if (markerMatch) {
			const author = /^Author:\s*(.+)$/u.exec(lines[i + 1])?.[1]?.trim();
			const date = /^Date:\s*(.+)$/u.exec(lines[i + 2])?.[1]?.trim();
			const subject = /^Subject:\s*(.+)$/u.exec(lines[i + 3])?.[1]?.trim();
			if (author || date || subject) {
				commits.push({
					sha: markerMatch[1],
					author,
					date,
					subject: subject ? shortenLine(subject) : undefined,
				});
				i += 3;
				continue;
			}
		}
		if (!/^[0-9a-f]{40}$/u.test(lines[i])) continue;
		const author = lines[i + 1].trim();
		const date = lines[i + 2].trim();
		const subject = lines[i + 3].trim();
		if (!author || !subject || !/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/u.test(date)) continue;
		commits.push({ sha: lines[i], author, date, subject: shortenLine(subject) });
		i += 3;
	}
	return commits;
}

function closeCurrentHunk(file: GitFileDigest | undefined, rawEndLine: number): void {
	const hunk = file ? currentHunk(file) : undefined;
	if (hunk && hunk.rawEndLine === undefined) hunk.rawEndLine = rawEndLine;
}

export function parseGitOutput(
	command: string,
	kind: GitInspectionKind,
	output: string,
	rawTruncated: boolean,
	rawIncomplete = false,
	rawStorageFailed = false,
): GitEvidenceDigest {
	const files: GitFileDigest[] = [];
	const commits: GitCommitDigest[] = [];
	const rawLines = countLines(output);
	const rawBytes = byteLength(output);
	let currentFile: GitFileDigest | undefined;
	let currentCommit: GitCommitDigest | undefined;
	const lines = output.split("\n");

	commits.push(...parseCustomLogCommits(lines));

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		const rawLine = index + 1;
		const commitMatch = /^commit\s+([0-9a-f]{7,40})\b/u.exec(line);
		if (commitMatch) {
			closeCurrentHunk(currentFile, rawLine - 1);
			currentFile = undefined;
			currentCommit = { sha: commitMatch[1] };
			commits.push(currentCommit);
			continue;
		}

		const logMatch = /^([0-9a-f]{7,40})\s+(.+)$/u.exec(line);
		if (!currentFile && logMatch && kind === "log") {
			commits.push({ sha: logMatch[1], subject: shortenLine(logMatch[2]) });
			continue;
		}

		if (currentCommit) {
			const author = /^Author:\s*(.+)$/u.exec(line)?.[1]?.trim();
			if (author) {
				currentCommit.author ??= author;
				continue;
			}
			const date = /^Date:\s*(.+)$/u.exec(line)?.[1]?.trim();
			if (date) {
				currentCommit.date ??= date;
				continue;
			}
			const subject = /^Subject:\s*(.+)$/u.exec(line)?.[1]?.trim();
			if (subject) {
				currentCommit.subject ??= shortenLine(subject);
				continue;
			}
		}

		const diffMatch = /^diff --git\s+(.+?)\s+(.+)$/u.exec(line);
		if (diffMatch) {
			closeCurrentHunk(currentFile, rawLine - 1);
			currentFile = {
				oldPath: normalizeDiffPath(diffMatch[1]),
				path: normalizeDiffPath(diffMatch[2]),
				additions: 0,
				deletions: 0,
				hunks: [],
			};
			files.push(currentFile);
			continue;
		}

		if (!currentFile) {
			const statusMatch = /^\s*(?:modified:|new file:|deleted:|renamed:|\?\?|[MADRCU?!]{1,2})\s+(.+)$/u.exec(line);
			if (statusMatch && kind === "status") {
				files.push({ path: statusMatch[1].trim(), additions: 0, deletions: 0, hunks: [] });
				continue;
			}
			const statMatch = /^\s*(.+?)\s+\|\s+(?:(\d+)\s+([+-]+)|Bin\s+\d+\s+->\s+\d+\s+bytes)$/u.exec(line);
			if (statMatch) {
				const changes = statMatch[3] ?? "";
				files.push({
					path: statMatch[1].trim(),
					additions: changes.replace(/[^+]/gu, "").length,
					deletions: changes.replace(/[^-]/gu, "").length,
					hunks: [],
				});
				continue;
			}
			if (currentCommit && line.startsWith("    ") && line.trim()) {
				currentCommit.subject ??= shortenLine(line.trim());
			}
			continue;
		}

		if (line.startsWith("new file mode ")) currentFile.status = "added";
		else if (line.startsWith("deleted file mode ")) currentFile.status = "deleted";
		else if (line.startsWith("rename from ")) currentFile.oldPath = line.slice("rename from ".length).trim();
		else if (line.startsWith("rename to ")) {
			currentFile.path = line.slice("rename to ".length).trim();
			currentFile.status = "renamed";
		}

		if (line.startsWith("@@ ")) {
			closeCurrentHunk(currentFile, rawLine - 1);
			currentFile.hunks.push({
				header: shortenLine(line),
				rawStartLine: rawLine,
				keyAddedLines: [],
				keyRemovedLines: [],
				omittedLineCount: 0,
			});
			continue;
		}

		const hunk = currentHunk(currentFile);
		if (!hunk || line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+")) {
			currentFile.additions++;
			if (!addKeyLine(hunk.keyAddedLines, line)) hunk.omittedLineCount++;
		} else if (line.startsWith("-")) {
			currentFile.deletions++;
			if (!addKeyLine(hunk.keyRemovedLines, line)) hunk.omittedLineCount++;
		}
	}
	closeCurrentHunk(currentFile, lines.length);

	return {
		kind,
		command,
		scope: detectGitEvidenceScope(command, kind),
		commits,
		files,
		rawLines,
		rawBytes,
		rawTruncated,
		rawIncomplete,
		rawStorageFailed,
		parseIncomplete: files.length === 0 && commits.length === 0 && output.trim().length > 0,
	};
}
