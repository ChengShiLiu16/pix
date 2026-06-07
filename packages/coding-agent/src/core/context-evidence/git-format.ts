import { GIT_EVIDENCE_PREFIX } from "./git-detect.ts";
import type { GitEvidenceDigest } from "./git-parse.ts";

const MAX_LEDGER_CHARS = 12_000;
const MAX_FILES = 40;
const MAX_HUNKS_PER_FILE = 8;
const MAX_KEY_LINES = 4;

export const COMPACT_LEDGER_CHARS = 1_200;
export const DETAILED_LEDGER_CHARS = MAX_LEDGER_CHARS;

function appendWithBudget(lines: string[], line: string, maxChars: number): boolean {
	const nextLength = lines.reduce((sum, item) => sum + item.length + 1, 0) + line.length + 1;
	if (nextLength > maxChars) return false;
	lines.push(line);
	return true;
}

function appendCommits(lines: string[], digest: GitEvidenceDigest, compact: boolean): void {
	if (digest.commits.length === 0) return;
	lines.push("Commits:");
	const maxCommits = compact ? 10 : 30;
	for (const commit of digest.commits.slice(0, maxCommits)) {
		const metadata = [commit.author, commit.date].filter((value) => value).join(", ");
		lines.push(`- ${commit.sha}${commit.subject ? ` ${commit.subject}` : ""}${metadata ? ` (${metadata})` : ""}`);
	}
	if (digest.commits.length > maxCommits) {
		lines.push(`- ... ${digest.commits.length - maxCommits} more commits omitted`);
	}
	lines.push("");
}

function appendFiles(lines: string[], id: string, digest: GitEvidenceDigest, compact: boolean, maxChars: number): void {
	if (digest.files.length === 0) return;
	lines.push("Files and hunks:");
	const maxFiles = compact ? 20 : MAX_FILES;
	const maxHunks = compact ? 2 : MAX_HUNKS_PER_FILE;
	for (const file of digest.files.slice(0, maxFiles)) {
		if (!appendWithBudget(lines, `- ${file.path} (+${file.additions}/-${file.deletions})`, maxChars)) break;
		for (const hunk of file.hunks.slice(0, maxHunks)) {
			const rawEnd = hunk.rawEndLine ?? hunk.rawStartLine;
			if (!appendWithBudget(lines, `  - ${hunk.header} [${id}:${hunk.rawStartLine}-${rawEnd}]`, maxChars)) break;
			const maxKeyLines = compact ? 1 : MAX_KEY_LINES;
			let omittedByCompact = 0;
			for (const removed of hunk.keyRemovedLines.slice(0, maxKeyLines)) {
				if (!appendWithBudget(lines, `    ${removed}`, maxChars)) break;
			}
			omittedByCompact += Math.max(0, hunk.keyRemovedLines.length - maxKeyLines);
			for (const added of hunk.keyAddedLines.slice(0, maxKeyLines)) {
				if (!appendWithBudget(lines, `    ${added}`, maxChars)) break;
			}
			omittedByCompact += Math.max(0, hunk.keyAddedLines.length - maxKeyLines);
			const omitted = hunk.omittedLineCount + omittedByCompact;
			if (omitted > 0) {
				appendWithBudget(lines, `    ... ${omitted} changed lines omitted in this hunk`, maxChars);
			}
		}
		if (file.hunks.length > maxHunks) {
			appendWithBudget(lines, `  - ... ${file.hunks.length - maxHunks} more hunks omitted`, maxChars);
		}
	}
	if (digest.files.length > maxFiles) lines.push(`- ... ${digest.files.length - maxFiles} more files omitted`);
	lines.push("");
}

export function formatDigest(
	id: string,
	digest: GitEvidenceDigest,
	rawPath: string | undefined,
	options: { maxChars?: number; compact?: boolean } = {},
): string {
	const maxChars = options.maxChars ?? MAX_LEDGER_CHARS;
	const compact = options.compact ?? false;
	const rawReadable = Boolean(rawPath) && !digest.rawIncomplete && !digest.rawStorageFailed;
	const lines: string[] = [
		`${GIT_EVIDENCE_PREFIX} ${id}`,
		"",
		`Command: ${digest.command}`,
		`Kind: git ${digest.kind}`,
		`Scope: ${digest.scope.type}`,
		...digest.scope.warnings,
		`Raw: ${digest.rawLines} lines, ${digest.rawBytes} bytes${rawPath ? `, ${rawPath}` : ""}`,
		...(digest.rawTruncated
			? ["Raw note: source exceeded the evidence size cap; exact omitted output requires narrower evidence."]
			: []),
		...(digest.rawIncomplete
			? [
					"Raw warning: full bash output was unavailable; this evidence may contain only the visible truncated output.",
				]
			: []),
		...(digest.rawStorageFailed
			? ["Raw warning: evidence storage failed; git_evidence_read may be unavailable for this digest."]
			: []),
		"",
	];

	appendCommits(lines, digest, compact);
	appendFiles(lines, id, digest, compact, maxChars);

	if (digest.parseIncomplete) {
		lines.push(
			rawReadable
				? "Parser note: structured diff metadata was not detected; raw evidence is available for exact output."
				: "Parser note: structured diff metadata was not detected, and exact raw output is not available from this digest.",
		);
		if (digest.kind === "show" && rawReadable) {
			lines.push(
				"Raw source snapshot captured; use git_evidence_read with this evidence id, offset, and limit for exact content.",
			);
		} else if (!rawReadable) {
			lines.push("Collect narrower git evidence before making exact content claims from this output.");
		}
	}

	if (/\bgit\s+(?:-[^\s]+\s+|-C\s+\S+\s+|-c\s+\S+\s+)*show\b[\s\S]*\|\s*head\b/u.test(digest.command)) {
		lines.push(
			rawReadable
				? "Repeated `git show ... | head` pattern detected: stop scanning commits one-by-one; use git_evidence_read ranges or search captured evidence."
				: "Repeated `git show ... | head` pattern detected: stop scanning commits one-by-one; collect narrower git evidence instead.",
		);
	}

	if (!compact) {
		lines.push(
			rawReadable
				? "Prefer git_evidence_read/search over repeating broad git log/show/diff commands for this output."
				: "Prefer narrower git log/show/diff commands before making exact content claims from this output.",
		);
		lines.push("Use this digest for inventory and triage only; do not infer behavior from commit subjects or stats.");
		lines.push(
			"Before final answers with non-inventory git conclusions, record git_evidence_findings with confidence and limitations.",
		);
	}

	const text = lines.join("\n");
	const content = text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n... git evidence ledger truncated.`;
	return `==== Evidence: ${id} ====\n${content}\n====`;
}

export function formatSupersededEvidence(args: {
	id: string;
	command: string;
	kind: string;
	scopeType?: string;
	supersededBy: string;
}): string {
	const lines = [
		`==== Evidence superseded: ${args.id} ====`,
		`Command: ${args.command}`,
		`Kind: git ${args.kind}`,
		...(args.scopeType ? [`Scope: ${args.scopeType}`] : []),
		`Superseded by: ${args.supersededBy}`,
		"This older dynamic git evidence is no longer current. Do not use it as current repository state.",
		"Use the superseding evidence for current status or diff conclusions.",
		`Use git_evidence_read with ${args.supersededBy} for exact current spans when available; otherwise recollect narrower evidence.`,
		"====",
	];
	return lines.join("\n");
}
