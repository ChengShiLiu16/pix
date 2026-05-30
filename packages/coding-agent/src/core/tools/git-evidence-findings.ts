import { createHash } from "node:crypto";
import { readFile as fsReadFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pix-agent-core";
import { Text } from "@earendil-works/pix-tui";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { getTextOutput, invalidArgText, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const severitySchema = Type.Union([
	Type.Literal("info"),
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("critical"),
]);

const claimKindSchema = Type.Union([
	Type.Literal("inventory"),
	Type.Literal("content"),
	Type.Literal("behavior"),
	Type.Literal("correctness"),
	Type.Literal("hypothesis"),
]);

const basisSchema = Type.Union([
	Type.Literal("metadata"),
	Type.Literal("stat"),
	Type.Literal("raw_diff"),
	Type.Literal("source"),
	Type.Literal("raw_diff_and_source"),
	Type.Literal("diff"),
]);

const evidenceSpanSchema = Type.Object({
	evidenceId: Type.String({ description: "Git evidence id that was read" }),
	startLine: Type.Number({ description: "Raw evidence start line, 1-indexed" }),
	endLine: Type.Number({ description: "Raw evidence end line, 1-indexed" }),
	excerptHash: Type.Optional(
		Type.String({ description: "Optional hash for validation; auto-computed if not provided or incorrect" }),
	),
});

const sourceSpanSchema = Type.Object({
	path: Type.String({ description: "Source file path that was inspected" }),
	startLine: Type.Number({ description: "Source start line, 1-indexed" }),
	endLine: Type.Number({ description: "Source end line, 1-indexed" }),
});

const gitEvidenceFindingsSchema = Type.Object({
	action: Type.Union([Type.Literal("add"), Type.Literal("list"), Type.Literal("clear")], {
		description: "add=record one analyzed finding, list=show accumulated findings, clear=reset findings",
	}),
	evidenceId: Type.Optional(Type.String({ description: "Git evidence id that supports this finding" })),
	claimKind: Type.Optional(claimKindSchema),
	basis: Type.Optional(basisSchema),
	evidenceSpans: Type.Optional(Type.Array(evidenceSpanSchema)),
	sourceSpans: Type.Optional(Type.Array(sourceSpanSchema)),
	confidence: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")])),
	title: Type.Optional(Type.String({ description: "Short finding title (required for add)" })),
	severity: Type.Optional(severitySchema),
	file: Type.Optional(Type.String({ description: "Relevant file path" })),
	line: Type.Optional(Type.Number({ description: "Relevant line number when known" })),
	summary: Type.Optional(Type.String({ description: "Concise finding summary (required for add)" })),
	details: Type.Optional(Type.String({ description: "Evidence details, reasoning, or recommendation" })),
	coverage: Type.Optional(Type.String({ description: "What part of the relevant evidence was inspected" })),
	limitations: Type.Optional(
		Type.String({ description: "Required when evidence is incomplete or claim is a hypothesis" }),
	),
});

const MAX_LISTED_FINDINGS = 5;
const EVIDENCE_ID_RE = /^git-(?:log|show|diff|diff-tree|status|blame)-[0-9a-f]{12}$/u;

export type GitEvidenceFindingsToolInput = Static<typeof gitEvidenceFindingsSchema>;
export type GitEvidenceSeverity = Static<typeof severitySchema>;
type GitEvidenceClaimKind = Static<typeof claimKindSchema>;
type GitEvidenceBasis = Static<typeof basisSchema>;
type GitEvidenceConfidence = "low" | "medium" | "high";
type GitEvidenceSpan = Static<typeof evidenceSpanSchema>;
type SourceSpan = Static<typeof sourceSpanSchema>;
type StoredSourceSpan = SourceSpan & { excerptHash: string };

interface GitEvidenceFinding {
	id: string;
	evidenceId?: string;
	claimKind: GitEvidenceClaimKind;
	basis: GitEvidenceBasis;
	evidenceSpans: GitEvidenceSpan[];
	sourceSpans: StoredSourceSpan[];
	confidence: GitEvidenceConfidence;
	title: string;
	severity: GitEvidenceSeverity;
	file?: string;
	line?: number;
	summary: string;
	details?: string;
	coverage?: string;
	limitations?: string;
	createdAt: number;
}

export interface GitEvidenceFindingsToolDetails {
	count: number;
	action: "add" | "list" | "clear";
}

export interface GitEvidenceFindingsOperations {
	readFile: (absolutePath: string) => Promise<string> | string;
}

const defaultGitEvidenceFindingsOperations: GitEvidenceFindingsOperations = {
	readFile: (path) => fsReadFile(path, "utf-8"),
};

export interface GitEvidenceFindingsToolOptions {
	operations?: GitEvidenceFindingsOperations;
}

function nextFindingId(): string {
	return `finding-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function severityRank(severity: GitEvidenceSeverity): number {
	switch (severity) {
		case "critical":
			return 5;
		case "high":
			return 4;
		case "medium":
			return 3;
		case "low":
			return 2;
		case "info":
			return 1;
	}
}

function formatFinding(finding: GitEvidenceFinding): string {
	const location = finding.file ? ` ${finding.file}${finding.line !== undefined ? `:${finding.line}` : ""}` : "";
	const evidence = finding.evidenceId ? ` [${finding.evidenceId}]` : "";
	const source =
		finding.sourceSpans.length > 0
			? ` source=${finding.sourceSpans.map((span) => `${span.path}:${span.startLine}-${span.endLine}`).join(",")}`
			: "";
	const spans =
		finding.evidenceSpans.length > 0
			? ` spans=${finding.evidenceSpans.map((span) => `${span.evidenceId}:${span.startLine}-${span.endLine}`).join(",")}`
			: "";
	const metadata = ` (${finding.claimKind}, ${finding.basis}, confidence=${finding.confidence}${spans}${source})`;
	const limitations = finding.limitations ? `\n  Limitations: ${finding.limitations}` : "";
	return `- ${finding.severity.toUpperCase()}: ${finding.title}${location}${evidence}${metadata}\n  ${finding.summary}${limitations}`;
}

function formatFindings(findings: GitEvidenceFinding[]): string {
	if (findings.length === 0) return "(no git evidence findings recorded)";
	const sorted = [...findings].sort(
		(a, b) => severityRank(b.severity) - severityRank(a.severity) || a.createdAt - b.createdAt,
	);
	const hypotheses = findings.filter((finding) => finding.claimKind === "hypothesis").length;
	const metadataOnly = findings.filter((finding) => finding.basis === "metadata" || finding.basis === "stat").length;
	const verified = findings.length - hypotheses - metadataOnly;
	const header = `Findings: ${findings.length} (verified=${verified}, hypotheses=${hypotheses}, metadata-only=${metadataOnly})`;
	const listed = sorted.slice(0, MAX_LISTED_FINDINGS);
	const omitted =
		sorted.length > MAX_LISTED_FINDINGS
			? `- ... ${sorted.length - MAX_LISTED_FINDINGS} lower-priority findings omitted from compact list`
			: undefined;
	return [header, ...listed.map(formatFinding), omitted].filter((line) => line !== undefined).join("\n");
}

function hashText(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

/**
 * Resolve evidence span hashes by reading raw evidence files.
 * Auto-computes the correct hash; does NOT reject on mismatch.
 * If the model provides a wrong/excerptHash, the correct hash is silently substituted.
 * Only rejects when the evidence file or span does not exist.
 */
async function resolveEvidenceSpanHashes(
	cwd: string,
	ops: GitEvidenceFindingsOperations,
	spans: GitEvidenceSpan[],
): Promise<GitEvidenceSpan[]> {
	return Promise.all(
		spans.map(async (span) => {
			if (!EVIDENCE_ID_RE.test(span.evidenceId)) throw new Error(`Invalid git evidence id: ${span.evidenceId}`);
			if (span.startLine < 1 || span.endLine < span.startLine) {
				throw new Error(`Invalid git evidence span: ${span.evidenceId}:${span.startLine}-${span.endLine}`);
			}
			const content = await ops.readFile(join(cwd, ".pix", "session-evidence", "git", `${span.evidenceId}.txt`));
			const lines = content.split("\n");
			if (span.endLine > lines.length) {
				throw new Error(
					`Git evidence span is beyond end of evidence: ${span.evidenceId}:${span.startLine}-${span.endLine} (${lines.length} lines total)`,
				);
			}
			const actualHash = hashText(lines.slice(span.startLine - 1, span.endLine).join("\n"));
			if (span.excerptHash && span.excerptHash !== actualHash) {
				// Hash was provided but wrong — silently correct it.
			}
			return { ...span, excerptHash: actualHash };
		}),
	);
}

/**
 * Resolve source excerpt hashes by reading source files.
 * All sourceSpans automatically get their excerptHash computed.
 */
async function resolveSourceSpanHashes(
	cwd: string,
	ops: GitEvidenceFindingsOperations,
	spans: SourceSpan[],
): Promise<StoredSourceSpan[]> {
	return Promise.all(
		spans.map(async (span) => {
			if (span.startLine < 1 || span.endLine < span.startLine) {
				throw new Error(`Invalid source span: ${span.path}:${span.startLine}-${span.endLine}`);
			}
			let content: string;
			try {
				content = await ops.readFile(join(cwd, span.path));
			} catch {
				throw new Error(`Cannot read source file for span: ${span.path}`);
			}
			const lines = content.split("\n");
			if (span.endLine > lines.length) {
				throw new Error(
					`Source span is beyond end of file: ${span.path}:${span.startLine}-${span.endLine} (${lines.length} lines total)`,
				);
			}
			const excerptHash = hashText(lines.slice(span.startLine - 1, span.endLine).join("\n"));
			return { ...span, excerptHash };
		}),
	);
}

interface ValidatedFinding extends Omit<GitEvidenceFinding, "id" | "createdAt" | "evidenceSpans" | "sourceSpans"> {
	evidenceSpans: Array<{ evidenceId: string; startLine: number; endLine: number; excerptHash?: string }>;
	sourceSpans: Array<{ path: string; startLine: number; endLine: number }>;
}

function validateAdd(input: GitEvidenceFindingsToolInput): ValidatedFinding {
	const title = input.title?.trim();
	const summary = input.summary?.trim();
	const claimKind = input.claimKind;
	let basis = input.basis;
	const confidence = input.confidence ?? "medium";
	const evidenceSpans = (input.evidenceSpans ?? []).map((span) => ({
		evidenceId: span.evidenceId.trim(),
		startLine: Math.floor(span.startLine),
		endLine: Math.floor(span.endLine),
		excerptHash: span.excerptHash?.trim() || undefined,
	}));
	const sourceSpans = (input.sourceSpans ?? []).map((span) => ({
		path: span.path.trim(),
		startLine: Math.floor(span.startLine),
		endLine: Math.floor(span.endLine),
	}));
	const limitations = input.limitations?.trim();
	if (basis === "diff") {
		basis = "raw_diff";
	}
	if (!title) throw new Error("git_evidence_findings add requires title");
	if (!summary) throw new Error("git_evidence_findings add requires summary");
	if (!claimKind) throw new Error("git_evidence_findings add requires claimKind");
	if (!basis) throw new Error("git_evidence_findings add requires basis");
	if (claimKind === "hypothesis" && !limitations) {
		throw new Error("git_evidence_findings add requires limitations for hypothesis claims");
	}
	if (claimKind !== "inventory" && claimKind !== "hypothesis") {
		if (basis === "metadata" || basis === "stat") {
			throw new Error("non-inventory git evidence findings require raw diff or source evidence");
		}
		if ((basis === "raw_diff" || basis === "raw_diff_and_source") && evidenceSpans.length === 0) {
			throw new Error("raw diff based git evidence findings require evidenceSpans from git_evidence_read");
		}
	}
	if ((claimKind === "behavior" || claimKind === "correctness") && sourceSpans.length === 0 && !limitations) {
		throw new Error("behavior and correctness findings require sourceSpans or limitations");
	}
	if (claimKind === "correctness" && confidence === "high" && sourceSpans.length === 0) {
		throw new Error("high-confidence correctness findings require sourceSpans");
	}
	return {
		evidenceId: input.evidenceId?.trim() || evidenceSpans[0]?.evidenceId,
		claimKind,
		basis,
		evidenceSpans,
		sourceSpans,
		confidence,
		title,
		severity: input.severity ?? "info",
		file: input.file?.trim() || undefined,
		line: input.line,
		summary,
		details: input.details?.trim() || undefined,
		coverage: input.coverage?.trim() || undefined,
		limitations,
	};
}

function formatGitEvidenceFindingsCall(
	args: { action?: string; title?: string } | undefined,
	theme: typeof import("../../modes/interactive/theme/theme.ts").theme,
): string {
	const action = str(args?.action);
	const invalidArg = invalidArgText(theme);
	let text = `${theme.fg("toolTitle", theme.bold("git_evidence_findings"))} ${action === null ? invalidArg : theme.fg("accent", action || "...")}`;
	if (args?.title) text += theme.fg("toolOutput", ` ${args.title}`);
	return text;
}

export function createGitEvidenceFindingsToolDefinition(
	cwd: string,
	options?: GitEvidenceFindingsToolOptions,
): ToolDefinition<typeof gitEvidenceFindingsSchema, GitEvidenceFindingsToolDetails | undefined> {
	const ops = options?.operations ?? defaultGitEvidenceFindingsOperations;
	let findings: GitEvidenceFinding[] = [];
	return {
		name: "git_evidence_findings",
		label: "git evidence findings",
		description:
			"Accumulate compact, theme-level git evidence findings with explicit claim kind, basis, confidence, and raw/source spans.",
		promptSnippet: "Record verified git evidence conclusions before final answers",
		promptGuidelines: [
			"For any final answer that includes non-inventory conclusions derived from git evidence, MUST record compact theme-level findings by calling git_evidence_findings action=list to review them before finalizing.",
			"Findings are scoped to the current session only and the list output is compact. Use at most 3-5 high-signal findings.",
			"Use one finding per theme or issue, not one per commit; keep findings compact and cite only the strongest raw/source spans.",
			"Commit subjects, file names, and stats only support inventory claims. Content, behavior, and correctness claims require raw diff and/or source spans.",
			"Record unsupported or insufficiently checked conclusions as hypothesis with limitations; do not present them as verified findings.",
			"Use findings internally to support your analysis; do not repeat raw findings format in user-facing text.",
		],
		parameters: gitEvidenceFindingsSchema,
		async execute(_toolCallId, input) {
			if (input.action === "clear") {
				findings = [];
				return {
					content: [{ type: "text", text: "Cleared git evidence findings." }],
					details: { action: "clear", count: 0 },
				};
			}

			if (input.action === "add") {
				const validated = validateAdd(input);
				const evidenceSpansWithHash = await resolveEvidenceSpanHashes(cwd, ops, validated.evidenceSpans);
				const sourceSpansWithHash = await resolveSourceSpanHashes(cwd, ops, validated.sourceSpans);
				const finding: GitEvidenceFinding = {
					id: nextFindingId(),
					createdAt: Date.now(),
					...validated,
					evidenceSpans: evidenceSpansWithHash,
					sourceSpans: sourceSpansWithHash,
				};
				findings.push(finding);
				return {
					content: [
						{
							type: "text",
							text: `Recorded finding ${finding.id} (hashes auto-resolved).\n${formatFinding(finding)}`,
						},
					],
					details: { action: "add", count: 1 },
				};
			}

			return {
				content: [{ type: "text", text: formatFindings(findings) }],
				details: { action: "list", count: findings.length },
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatGitEvidenceFindingsCall(args, theme));
			return text;
		},
		renderResult(result, _options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const output = getTextOutput(result, context.showImages).trim();
			text.setText(
				output
					? `\n${output
							.split("\n")
							.slice(0, 20)
							.map((line) => theme.fg("toolOutput", line))
							.join("\n")}`
					: "",
			);
			return text;
		},
	};
}

export function createGitEvidenceFindingsTool(
	cwd: string,
	options?: GitEvidenceFindingsToolOptions,
): AgentTool<typeof gitEvidenceFindingsSchema> {
	return wrapToolDefinition(createGitEvidenceFindingsToolDefinition(cwd, options));
}
