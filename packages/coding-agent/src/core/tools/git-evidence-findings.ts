import { createHash } from "node:crypto";
import { readFile as fsReadFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentTool } from "@chengshiliu16/pix-agent-core";
import { Text } from "@chengshiliu16/pix-tui";
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

const CLAIM_KIND_VALUES = [
	"inventory",
	"content",
	"behavior",
	"correctness",
	"absence",
	"causality",
	"hypothesis",
] as const;

const BASIS_VALUES = ["metadata", "stat", "raw_diff", "source", "raw_diff_and_source"] as const;

const CLAIM_KIND_HELP = [
	"inventory: scope/theme/classification from metadata or file inventory",
	"content: concrete file or diff content",
	"behavior: behavior impact",
	"correctness: correctness issue",
	"absence: missing tests/implementation/coverage; requires searched evidence",
	"causality: cause/effect claim; requires raw evidence, source spans, and limitations",
	"hypothesis: insufficiently verified claim with limitations",
].join("\n- ");

const BASIS_HELP = [
	"metadata: commit subject, author, date, or ref metadata",
	"stat: changed-file inventory or insertions/deletions",
	"raw_diff: git diff/show hunk evidence",
	"source: inspected current source span",
	"raw_diff_and_source: both diff evidence and current source span",
].join("\n- ");

const evidenceSpanSchema = Type.Object({
	evidenceId: Type.String({ description: "Git evidence id that was read" }),
	startLine: Type.Number({ description: "Raw evidence start line, 1-indexed" }),
	endLine: Type.Number({ description: "Raw evidence end line, 1-indexed" }),
	excerptHash: Type.Optional(
		Type.String({
			description: "Optional hash for validation; auto-computed when omitted, rejected when mismatched",
		}),
	),
});

const sourceSpanSchema = Type.Object({
	path: Type.String({ description: "Source file path that was inspected" }),
	startLine: Type.Number({ description: "Source start line, 1-indexed" }),
	endLine: Type.Number({ description: "Source end line, 1-indexed" }),
});

const gitEvidenceFindingsSchema = Type.Object({
	action: Type.Union(
		[Type.Literal("add"), Type.Literal("list"), Type.Literal("clear"), Type.Literal("schema"), Type.Literal("help")],
		{
			description:
				"add=record one analyzed finding, list=show accumulated findings, clear=reset findings, schema/help=show accepted values",
		},
	),
	evidenceId: Type.Optional(Type.String({ description: "Git evidence id that supports this finding" })),
	claimKind: Type.Optional(Type.String({ description: `Finding kind. Allowed: ${CLAIM_KIND_VALUES.join(", ")}` })),
	basis: Type.Optional(Type.String({ description: `Evidence basis. Allowed: ${BASIS_VALUES.join(", ")}` })),
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
const EVIDENCE_ID_RE = /^git-(?:log|show|diff|diff-tree|status|blame|grep)-[0-9a-f]{12}$/u;

export type GitEvidenceFindingsToolInput = Static<typeof gitEvidenceFindingsSchema>;
export type GitEvidenceSeverity = Static<typeof severitySchema>;
type GitEvidenceClaimKind = (typeof CLAIM_KIND_VALUES)[number];
type GitEvidenceBasis = (typeof BASIS_VALUES)[number];
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
	action: "add" | "list" | "clear" | "schema" | "help";
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

function normalizeToken(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[\s-]+/gu, "_");
}

function isClaimKind(value: string): value is GitEvidenceClaimKind {
	return (CLAIM_KIND_VALUES as readonly string[]).includes(value);
}

function isBasis(value: string): value is GitEvidenceBasis {
	return (BASIS_VALUES as readonly string[]).includes(value);
}

function normalizeClaimKind(value: string): GitEvidenceClaimKind | undefined {
	const normalized = normalizeToken(value);
	if (isClaimKind(normalized)) return normalized;
	if (["summary", "overview", "scope", "theme", "topic", "classification"].includes(normalized)) return "inventory";
	if (["missing", "not_found", "none", "no_tests", "uncovered", "absent"].includes(normalized)) return "absence";
	if (["cause", "causal", "causation", "root_cause", "cause_effect", "cause_and_effect"].includes(normalized))
		return "causality";
	return undefined;
}

function normalizeBasis(value: string): GitEvidenceBasis | undefined {
	const normalized = normalizeToken(value);
	if (normalized === "diff") return "raw_diff";
	if (isBasis(normalized)) return normalized;
	if (["git_log", "commit_log", "log", "subject", "subjects", "commit_subjects"].includes(normalized)) {
		return "metadata";
	}
	if (["diff_stat", "stats", "changed_files", "changed_file_inventory", "file_inventory"].includes(normalized)) {
		return "stat";
	}
	if (["raw_git", "git_diff", "git_show", "patch", "hunk", "raw"].includes(normalized)) return "raw_diff";
	if (["source_code", "current_source"].includes(normalized)) return "source";
	if (["diff_and_source", "source_and_diff", "raw_and_source", "raw_git_and_source"].includes(normalized)) {
		return "raw_diff_and_source";
	}
	if ((normalized.includes("changed_file") || normalized.includes("stat")) && normalized.includes("git"))
		return "stat";
	if (normalized.includes("git_log") || normalized.includes("subject")) return "metadata";
	return undefined;
}

function schemaHelpText(): string {
	return [
		"git_evidence_findings schema:",
		"",
		"claimKind:",
		`- ${CLAIM_KIND_HELP}`,
		"",
		"basis:",
		`- ${BASIS_HELP}`,
		"",
		"Common mappings:",
		"- overview/summary/scope -> claimKind=inventory",
		"- missing/not_found/no_tests -> claimKind=absence",
		"- cause/root_cause -> claimKind=causality",
		"- git_log/subjects -> basis=metadata",
		"- changed_files/diff_stat -> basis=stat",
		"- raw_git/git_show/git_diff -> basis=raw_diff",
	].join("\n");
}

function invalidClaimKindMessage(value: string): string {
	return [
		`Invalid claimKind "${value}".`,
		`Allowed: ${CLAIM_KIND_VALUES.join(", ")}.`,
		"Use inventory for overview/scope/theme summaries, absence for missing/not found, causality for cause/effect, or hypothesis when evidence is incomplete.",
	].join(" ");
}

function invalidBasisMessage(value: string): string {
	return [
		`Invalid basis "${value}".`,
		`Allowed: ${BASIS_VALUES.join(", ")}.`,
		"Use metadata for git log subjects, stat for changed-file inventory, raw_diff for git show/diff hunks, source for inspected source, raw_diff_and_source for both.",
	].join(" ");
}

/**
 * Resolve evidence span hashes by reading raw evidence files.
 * Auto-computes missing hashes, but rejects mismatches so stale or wrong spans stay visible.
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
				throw new Error(
					`Git evidence span hash mismatch for ${span.evidenceId}:${span.startLine}-${span.endLine}; expected ${actualHash}, got ${span.excerptHash}`,
				);
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
	const rawClaimKind = input.claimKind?.trim();
	const rawBasis = input.basis?.trim();
	const claimKind = rawClaimKind ? normalizeClaimKind(rawClaimKind) : undefined;
	const basis = rawBasis ? normalizeBasis(rawBasis) : undefined;
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
	if (!title) throw new Error("git_evidence_findings add requires title");
	if (!summary) throw new Error("git_evidence_findings add requires summary");
	if (!rawClaimKind)
		throw new Error(`git_evidence_findings add requires claimKind. Allowed: ${CLAIM_KIND_VALUES.join(", ")}`);
	if (!claimKind) throw new Error(invalidClaimKindMessage(rawClaimKind));
	if (!rawBasis) throw new Error(`git_evidence_findings add requires basis. Allowed: ${BASIS_VALUES.join(", ")}`);
	if (!basis) throw new Error(invalidBasisMessage(rawBasis));
	if (claimKind === "hypothesis" && !limitations) {
		throw new Error("git_evidence_findings add requires limitations for hypothesis claims");
	}
	if (claimKind === "absence") {
		if (evidenceSpans.length === 0) {
			throw new Error(
				"absence findings require search evidence spans; otherwise record a hypothesis with limitations",
			);
		}
		if (basis === "metadata" || basis === "stat") {
			throw new Error("absence findings require searched raw/source evidence, not metadata or stats");
		}
	}
	if (claimKind === "causality") {
		if (!limitations) {
			throw new Error("causality findings require limitations describing how the cause/effect link was verified");
		}
		if (evidenceSpans.length === 0 || sourceSpans.length === 0) {
			throw new Error("causality findings require both raw evidence spans and source spans");
		}
		if (basis !== "raw_diff_and_source") {
			throw new Error("causality findings require basis raw_diff_and_source");
		}
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
			"For any final answer that includes non-inventory conclusions derived from git evidence, MUST record compact theme-level findings and call git_evidence_findings action=list before finalizing.",
			"Use at most 3-5 high-signal findings, one per theme or issue (not one per commit); cite only the strongest raw/source spans. Field values and per-claim evidence requirements are enforced on add — call action=schema for the reference.",
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

			if (input.action === "schema" || input.action === "help") {
				return {
					content: [{ type: "text", text: schemaHelpText() }],
					details: { action: input.action, count: findings.length },
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
							text: `Recorded finding ${finding.id} (hashes verified).\n${formatFinding(finding)}`,
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
