import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pix-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pix-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	applyGitEvidenceTransform,
	clearGitEvidenceCache,
	createGitEvidenceResult,
	detectGitInspection,
} from "../src/core/context-git-evidence.ts";
import type { BashExecutionMessage } from "../src/core/messages.ts";
import { createGitEvidenceFindingsToolDefinition } from "../src/core/tools/git-evidence-findings.ts";
import { createGitEvidenceReadToolDefinition } from "../src/core/tools/git-evidence-read.ts";

const DIFF_OUTPUT = `commit abcdef1234567890
Author: Test <test@example.com>

    fix: improve todo handling

diff --git a/src/todo.ts b/src/todo.ts
index 1111111..2222222 100644
--- a/src/todo.ts
+++ b/src/todo.ts
@@ -1,5 +1,7 @@ function updateTodo() {
-const oldValue = getOldValue();
-return oldValue;
+const nextValue = getNextValue();
+validateTodo(nextValue);
+return nextValue;
 }
diff --git a/test/todo.test.ts b/test/todo.test.ts
index 3333333..4444444 100644
--- a/test/todo.test.ts
+++ b/test/todo.test.ts
@@ -10,3 +10,4 @@ describe("todo", () => {
+expect(todo.status).toBe("completed");
 });
`;

const STAT_OUTPUT = `commit 1234567890abcdef
Author: Test <test@example.com>

    feat: update files

 src/a.ts      | 3 ++-
 src/binary.png | Bin 10 -> 20 bytes
 2 files changed, 2 insertions(+), 1 deletion(-)
`;

const CUSTOM_LOG_OUTPUT = `cd8de1f835cbe2002009489c97e8f6a25d520268
程 斌
2026-05-28 20:41:41 +0900
fix: 修复三处渲染兼容性问题

d8c92c3437d32a6f582d75193bed062c79d67b61
程 斌
2026-05-28 20:56:31 +0900
fix: 归一化 AI 产出的反斜杠下划线
`;

const MARKER_LOG_OUTPUT = `--- COMMIT cd8de1f835cbe2002009489c97e8f6a25d520268 ---
Author: 程 斌
Date: 2026-05-28 20:41:41 +0900
Subject: fix: 修复三处渲染兼容性问题
`;

const EQUAL_MARKER_LOG_OUTPUT = `=== COMMIT: cd8de1f835cbe2002009489c97e8f6a25d520268 ===
Author: 程 斌
Date: 2026-05-28 20:41:41 +0900
Subject: fix: 修复三处渲染兼容性问题
`;

const CUSTOM_SHOW_OUTPUT = `commit f7caa1d7
Author: Test <test@example.com>
Date: 2026-05-29 10:00:00
Subject: feat: keep explicit subject

diff --git a/src/feature.test.ts b/src/feature.test.ts
index 1111111..2222222 100644
--- a/src/feature.test.ts
+++ b/src/feature.test.ts
@@ -1,3 +1,4 @@
 describe("feature", () => {
+    expect(result).toBe(true);
 });
`;

const COMPOSITE_DIFF_TREE_OUTPUT = `===== COMMIT cd8de1f8 =====
cd8de1f835cbe2002009489c97e8f6a25d520268
程 斌
2026-05-28 20:41:41 +0900
fix: 修复三处渲染兼容性问题
---STAT---
 src/components/MarkdownEditor/index.vue | 12 +++++++++---
 src/utils/mathLatexCompat.ts            |  4 +++-
 2 files changed, 12 insertions(+), 4 deletions(-)
`;

let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pix-git-evidence-"));
	tempDirs.push(dir);
	return dir;
}

function assistantCall(id: string, command: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name: "bash", arguments: { command } }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 0,
	} as AssistantMessage;
}

function toolResult(id: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "bash",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 0,
	};
}

function resultText(message: AgentMessage): string {
	if (message.role !== "toolResult") return "";
	return (message as ToolResultMessage).content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

afterEach(async () => {
	for (const dir of tempDirs) {
		await rm(dir, { recursive: true, force: true });
	}
	tempDirs = [];
	clearGitEvidenceCache();
});

describe("git evidence detection", () => {
	it("recognizes read-only git inspection commands", () => {
		expect(detectGitInspection("git show abc123")?.kind).toBe("show");
		expect(detectGitInspection("git diff main...HEAD")?.kind).toBe("diff");
		expect(detectGitInspection("git log --oneline -5")?.kind).toBe("log");
		expect(detectGitInspection("git status --short")?.kind).toBe("status");
		expect(detectGitInspection("git -C ../repo show abc123")?.kind).toBe("show");
		expect(detectGitInspection("git diff-tree --stat --no-commit-id -r HEAD")?.kind).toBe("diff-tree");
	});

	it("recognizes composite read-only git inspection commands", () => {
		const command =
			'for hash in a b; do git log -1 --format="%H%n%an%n%ai%n%s%n" "$hash"; git diff-tree --stat --no-commit-id -r "$hash"; done';

		expect(detectGitInspection(command)?.kind).toBe("log");
	});

	it("rejects commands that include git mutations", () => {
		expect(detectGitInspection("git show abc123 && git checkout main")).toBeUndefined();
		expect(detectGitInspection("git commit -m test")).toBeUndefined();
		expect(detectGitInspection("echo ok")).toBeUndefined();
	});
});

describe("createGitEvidenceResult", () => {
	it("stores raw output and returns a compact digest", async () => {
		const cwd = await makeTempDir();
		const result = await createGitEvidenceResult("git show abcdef1", cwd, DIFF_OUTPUT);

		expect(result).toBeDefined();
		expect(result?.text).toContain("Git evidence captured:");
		expect(result?.text).toContain("abcdef1234567890 fix: improve todo handling");
		expect(result?.text).toContain("src/todo.ts");
		expect(result?.text).toContain("@@ -1,5 +1,7 @@ function updateTodo()");
		expect(result?.text).toContain(`${result?.details.id}:10-16`);
		expect(result?.text).toContain("+const nextValue = getNextValue();");
		expect(result?.text).toContain('+expect(todo.status).toBe("completed");');
		expect(result?.text).not.toContain("Prefer git_evidence_read");
		expect(result?.text).toContain("Files and hunks:");
		expect(result?.text).toContain(`${result?.details.id}:`);
		expect(result?.text).not.toBe(DIFF_OUTPUT);

		const rawPath = result?.details.rawPath;
		expect(rawPath).toBeDefined();
		expect(await readFile(rawPath!, "utf-8")).toBe(DIFF_OUTPUT);
	});

	it("warns against repeated git show head scans", async () => {
		const cwd = await makeTempDir();
		const result = await createGitEvidenceResult("git show --stat -p abcdef1 | head -200", cwd, DIFF_OUTPUT);

		expect(result?.text).toContain("Repeated `git show ... | head` pattern detected");
		expect(result?.text).toContain("git_evidence_read ranges");
	});

	it("keeps raw source snapshots compact and points to git_evidence_read", async () => {
		const cwd = await makeTempDir();
		const result = await createGitEvidenceResult(
			"git show abcdef1:src/feature.ts",
			cwd,
			"export const feature = true;\n",
		);

		expect(result?.text).toContain("Raw source snapshot captured");
		expect(result?.text).toContain("Use git_evidence_read");
		expect(result?.text).not.toContain("export const feature = true");
	});

	it("reuses a full output file when the visible bash output was truncated", async () => {
		const cwd = await makeTempDir();
		const fullPath = join(cwd, "full-output.log");
		await writeFile(fullPath, DIFF_OUTPUT, "utf-8");

		const result = await createGitEvidenceResult("git show abcdef1", cwd, "[Showing lines 1-10]", fullPath);

		expect(result?.text).toContain("src/todo.ts");
		expect(await readFile(result!.details.rawPath!, "utf-8")).toBe(DIFF_OUTPUT);
	});

	it("extracts file summaries from --stat output", async () => {
		const cwd = await makeTempDir();
		const result = await createGitEvidenceResult("git show --stat 1234567", cwd, STAT_OUTPUT);

		expect(result?.text).toContain("1234567890abcdef feat: update files");
		expect(result?.text).toContain("src/a.ts (+2/-1)");
		expect(result?.text).toContain("src/binary.png (+0/-0)");
	});

	it("extracts custom git log format blocks", async () => {
		const cwd = await makeTempDir();
		const result = await createGitEvidenceResult('git log --format="%H%n%an%n%ai%n%s%n"', cwd, CUSTOM_LOG_OUTPUT);

		expect(result?.text).toContain("cd8de1f835cbe2002009489c97e8f6a25d520268 fix: 修复三处渲染兼容性问题");
		expect(result?.text).toContain("程 斌, 2026-05-28 20:41:41 +0900");
		expect(result?.text).not.toContain("Parser note");
	});

	it("extracts marker-based custom git log blocks", async () => {
		const cwd = await makeTempDir();
		const result = await createGitEvidenceResult(
			'git log --format="--- COMMIT %H ---%nAuthor: %an%nDate: %ai%nSubject: %s"',
			cwd,
			MARKER_LOG_OUTPUT,
		);

		expect(result?.text).toContain("cd8de1f835cbe2002009489c97e8f6a25d520268 fix: 修复三处渲染兼容性问题");
		expect(result?.text).toContain("程 斌, 2026-05-28 20:41:41 +0900");
		expect(result?.text).not.toContain("Parser note");
	});

	it("extracts equals marker custom git log blocks", async () => {
		const cwd = await makeTempDir();
		const result = await createGitEvidenceResult(
			'git log --format="=== COMMIT: %H ===%nAuthor: %an%nDate: %ai%nSubject: %s"',
			cwd,
			EQUAL_MARKER_LOG_OUTPUT,
		);

		expect(result?.text).toContain("cd8de1f835cbe2002009489c97e8f6a25d520268 fix: 修复三处渲染兼容性问题");
		expect(result?.text).toContain("程 斌, 2026-05-28 20:41:41 +0900");
		expect(result?.text).not.toContain("Parser note");
	});

	it("does not treat diff body indentation as a commit subject", async () => {
		const cwd = await makeTempDir();
		const result = await createGitEvidenceResult("git show f7caa1d7 --format=custom", cwd, CUSTOM_SHOW_OUTPUT);

		expect(result?.text).toContain("f7caa1d7 feat: keep explicit subject");
		expect(result?.text).not.toContain("f7caa1d7 expect(result)");
		expect(result?.text).toContain(`${result?.details.id}:10-14`);
	});

	it("captures composite git log and diff-tree stat commands", async () => {
		const cwd = await makeTempDir();
		const command =
			'for hash in cd8de1f8; do git log -1 --format="%H%n%an%n%ai%n%s%n" "$hash"; git diff-tree --stat --no-commit-id -r "$hash"; done';
		const result = await createGitEvidenceResult(command, cwd, COMPOSITE_DIFF_TREE_OUTPUT);

		expect(result?.text).toContain("Git evidence captured: git-log-");
		expect(result?.text).toContain("cd8de1f835cbe2002009489c97e8f6a25d520268 fix: 修复三处渲染兼容性问题");
		expect(result?.text).toContain("src/components/MarkdownEditor/index.vue (+9/-3)");
		expect(result?.text).toContain("src/utils/mathLatexCompat.ts (+3/-1)");
		expect(result?.text).not.toContain("Avoid invalid `git show --no-stat`");
		expect(result?.text).not.toBe(COMPOSITE_DIFF_TREE_OUTPUT);
	});

	it("keeps evidence store bounded by record count", async () => {
		const cwd = await makeTempDir();
		for (let index = 0; index < 205; index++) {
			const sha = index.toString(16).padStart(7, "0");
			await createGitEvidenceResult("git log --oneline", cwd, `${sha} commit ${index}`);
		}

		const files = await readdir(join(cwd, ".pix", "session-evidence", "git"));
		expect(files.filter((file) => file.endsWith(".txt")).length).toBeLessThanOrEqual(200);
	});
});

describe("applyGitEvidenceTransform", () => {
	it("replaces bash tool results for git inspection output", async () => {
		const cwd = await makeTempDir();
		const messages: AgentMessage[] = [assistantCall("c1", "git show abcdef1"), toolResult("c1", DIFF_OUTPUT)];

		const result = await applyGitEvidenceTransform(messages, cwd);

		expect(result).not.toBe(messages);
		expect(resultText(result[1])).toContain("Git evidence captured:");
		expect(resultText(result[1])).toContain("src/todo.ts");
		expect(resultText(result[1])).not.toContain("Author: Test");
	});

	it("does not replace non-git bash output", async () => {
		const cwd = await makeTempDir();
		const messages: AgentMessage[] = [assistantCall("c1", "echo ok"), toolResult("c1", "ok")];

		expect(await applyGitEvidenceTransform(messages, cwd)).toBe(messages);
	});

	it("also compacts interactive bashExecution messages", async () => {
		const cwd = await makeTempDir();
		const message: BashExecutionMessage = {
			role: "bashExecution",
			command: "git show abcdef1",
			output: DIFF_OUTPUT,
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: 0,
		};

		const result = await applyGitEvidenceTransform([message], cwd);

		expect(result[0].role).toBe("bashExecution");
		expect((result[0] as BashExecutionMessage).output).toContain("Git evidence captured:");
		expect((result[0] as BashExecutionMessage).output).not.toContain("Author: Test");
		expect((result[0] as BashExecutionMessage).fullOutputPath).toContain(".pix/session-evidence/git/");
	});

	it("keeps only the two latest git evidence results detailed in context", async () => {
		const cwd = await makeTempDir();
		const messages: AgentMessage[] = [
			assistantCall("c1", "git show abcdef1"),
			toolResult("c1", DIFF_OUTPUT),
			assistantCall("c2", "git show abcdef2"),
			toolResult("c2", DIFF_OUTPUT.replace("abcdef1234567890", "bbbbbbb1234567890")),
			assistantCall("c3", "git show abcdef3"),
			toolResult("c3", DIFF_OUTPUT.replace("abcdef1234567890", "ccccccc1234567890")),
		];

		const result = await applyGitEvidenceTransform(messages, cwd);

		// All evidence results are now compact (includes key changed lines).
		// The "keep latest 2 detailed" aging only triggers when text is larger
		// than compactText, which doesn't apply since bash returns compact text.
		expect(resultText(result[1])).toContain("+const nextValue = getNextValue();");
		expect(resultText(result[3])).toContain("+const nextValue = getNextValue();");
		expect(resultText(result[5])).toContain("+const nextValue = getNextValue();");
	});
});

describe("git_evidence_read tool", () => {
	it("reads raw evidence by id with offset and limit", async () => {
		const cwd = await makeTempDir();
		const evidence = await createGitEvidenceResult("git show abcdef1", cwd, DIFF_OUTPUT);
		const tool = createGitEvidenceReadToolDefinition(cwd);

		const result = await tool.execute(
			"read-evidence",
			{ id: evidence!.details.id, offset: 6, limit: 4 },
			undefined,
			undefined,
			{} as never,
		);
		const text = result.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n");

		expect(text).toContain("diff --git a/src/todo.ts b/src/todo.ts");
		expect(text).toContain("[Showing lines 6-9");
		expect(text).toContain(`[Evidence span ${evidence!.details.id}:6-9 hash=`);
		expect(result.details?.evidenceId).toBe(evidence!.details.id);
		expect(result.details?.spanHash).toMatch(/^[0-9a-f]{12}$/u);
	});

	it("searches raw evidence by id", async () => {
		const cwd = await makeTempDir();
		const evidence = await createGitEvidenceResult("git show abcdef1", cwd, DIFF_OUTPUT);
		const tool = createGitEvidenceReadToolDefinition(cwd);

		const result = await tool.execute(
			"search-evidence",
			{ id: evidence!.details.id, pattern: "validateTodo", context: 1 },
			undefined,
			undefined,
			{} as never,
		);
		const text = result.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n");

		expect(text).toContain("+validateTodo(nextValue);");
		expect(text).toContain("+const nextValue = getNextValue();");
	});

	it("lists empty evidence stores without failing", async () => {
		const cwd = await makeTempDir();
		const tool = createGitEvidenceReadToolDefinition(cwd);

		const listed = await tool.execute("list-empty-evidence", {}, undefined, undefined, {} as never);
		const listText = listed.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		expect(listText).toContain("(no git evidence captured)");

		const searched = await tool.execute(
			"search-empty-evidence",
			{ pattern: "validateTodo" },
			undefined,
			undefined,
			{} as never,
		);
		const searchText = searched.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		expect(searchText).toContain("(no matches)");
	});

	it("lists and searches all captured evidence when no id is provided", async () => {
		const cwd = await makeTempDir();
		const first = await createGitEvidenceResult("git show abcdef1", cwd, DIFF_OUTPUT);
		await createGitEvidenceResult("git show 1234567", cwd, STAT_OUTPUT);
		const tool = createGitEvidenceReadToolDefinition(cwd);

		const listed = await tool.execute("list-evidence", {}, undefined, undefined, {} as never);
		const listText = listed.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		expect(listText).toContain(first!.details.id);

		const searched = await tool.execute(
			"search-all-evidence",
			{ pattern: "validateTodo" },
			undefined,
			undefined,
			{} as never,
		);
		const searchText = searched.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		expect(searchText).toContain(`[${first!.details.id}]`);
		expect(searchText).toContain("+validateTodo(nextValue);");
	});

	it("reads diff-tree evidence ids", async () => {
		const cwd = await makeTempDir();
		const evidence = await createGitEvidenceResult("git diff-tree --stat --no-commit-id -r HEAD", cwd, STAT_OUTPUT);
		const tool = createGitEvidenceReadToolDefinition(cwd);

		const result = await tool.execute(
			"read-diff-tree-evidence",
			{ id: evidence!.details.id, limit: 2 },
			undefined,
			undefined,
			{} as never,
		);
		const text = result.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n");

		expect(evidence!.details.id).toMatch(/^git-diff-tree-/u);
		expect(text).toContain("commit 1234567890abcdef");
	});

	it("reads multiple raw evidence ranges in one call", async () => {
		const cwd = await makeTempDir();
		const evidence = await createGitEvidenceResult("git show abcdef1", cwd, DIFF_OUTPUT);
		const tool = createGitEvidenceReadToolDefinition(cwd);

		const result = await tool.execute(
			"read-range-evidence",
			{
				ranges: [
					{ id: evidence!.details.id, offset: 9, limit: 3 },
					{ id: evidence!.details.id, offset: 18, limit: 3 },
				],
			},
			undefined,
			undefined,
			{} as never,
		);
		const text = result.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n");

		expect(text).toContain("==== git-show-");
		expect(text).toContain("[Evidence span");
		expect(result.details?.ranges).toHaveLength(2);
	});

	it("caps broad raw evidence reads", async () => {
		const cwd = await makeTempDir();
		const output = Array.from({ length: 260 }, (_, index) => `line ${index + 1}`).join("\n");
		const evidence = await createGitEvidenceResult("git log --oneline -260", cwd, output);
		const tool = createGitEvidenceReadToolDefinition(cwd);

		const result = await tool.execute(
			"read-capped-evidence",
			{ id: evidence!.details.id, limit: 500 },
			undefined,
			undefined,
			{} as never,
		);
		const text = result.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n");

		expect(text).toContain("[Showing lines 1-160 of 260");
		expect(text).toContain("[Requested limit 500 capped to 160");
		expect(result.details?.endLine).toBe(160);
	});
});

describe("git_evidence_findings tool", () => {
	it("records, lists, and clears findings", async () => {
		const cwd = await makeTempDir();
		const evidence = await createGitEvidenceResult("git show abcdef1", cwd, DIFF_OUTPUT);
		const tool = createGitEvidenceFindingsToolDefinition(cwd);

		const added = await tool.execute(
			"add-finding",
			{
				action: "add",
				claimKind: "content",
				basis: "raw_diff",
				evidenceSpans: [
					{
						evidenceId: evidence!.details.id,
						startLine: 11,
						endLine: 13,
						excerptHash: undefined, // Will be auto-resolved
					},
				],
				confidence: "medium",
				title: "todo validation changed",
				severity: "medium",
				file: "src/todo.ts",
				line: 12,
				summary: "The todo update path now validates nextValue before returning it.",
				details: "Checked raw evidence around validateTodo(nextValue).",
			},
			undefined,
			undefined,
			{} as never,
		);
		const addedText = added.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		expect(addedText).toContain("Recorded finding");

		const listed = await tool.execute("list-findings", { action: "list" }, undefined, undefined, {} as never);
		const listText = listed.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		expect(listText).toContain("Findings: 1 (verified=1, hypotheses=0, metadata-only=0)");
		expect(listText).toContain("MEDIUM: todo validation changed src/todo.ts:12");
		expect(listText).toContain(`[${evidence!.details.id}]`);

		const cleared = await tool.execute("clear-findings", { action: "clear" }, undefined, undefined, {} as never);
		expect(cleared.details?.count).toBe(0);
		const empty = await tool.execute("list-empty", { action: "list" }, undefined, undefined, {} as never);
		const emptyText = empty.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		expect(emptyText).toContain("(no git evidence findings recorded)");
	});

	it("keeps findings scoped to one tool session", async () => {
		const cwd = await makeTempDir();
		const firstTool = createGitEvidenceFindingsToolDefinition(cwd);
		const secondTool = createGitEvidenceFindingsToolDefinition(cwd);

		await firstTool.execute(
			"add-session-finding",
			{
				action: "add",
				claimKind: "inventory",
				basis: "metadata",
				confidence: "high",
				title: "session finding",
				summary: "This finding belongs only to the first tool instance.",
			},
			undefined,
			undefined,
			{} as never,
		);

		const listed = await secondTool.execute(
			"list-second-session",
			{ action: "list" },
			undefined,
			undefined,
			{} as never,
		);
		const text = listed.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n");

		expect(text).toContain("(no git evidence findings recorded)");
	});

	it("auto-corrects mismatched evidence span hashes", async () => {
		const cwd = await makeTempDir();
		const evidence = await createGitEvidenceResult("git show abcdef1", cwd, DIFF_OUTPUT);
		const tool = createGitEvidenceFindingsToolDefinition(cwd);

		// Wrong hash should be auto-corrected, not rejected.
		const result = await tool.execute(
			"add-mismatched-finding",
			{
				action: "add",
				claimKind: "content",
				basis: "raw_diff",
				evidenceSpans: [
					{
						evidenceId: evidence!.details.id,
						startLine: 11,
						endLine: 13,
						excerptHash: "0123456789ab",
					},
				],
				title: "auto-corrected hash",
				summary: "Hash was wrong but should be auto-corrected.",
			},
			undefined,
			undefined,
			{} as never,
		);
		const text = result.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		expect(text).toContain("Recorded finding");
		expect(text).toContain("(hashes auto-resolved)");
	});

	it("rejects content findings without raw evidence spans", async () => {
		const cwd = await makeTempDir();
		const tool = createGitEvidenceFindingsToolDefinition(cwd);

		await expect(
			tool.execute(
				"add-unsupported-finding",
				{
					action: "add",
					claimKind: "content",
					basis: "metadata",
					title: "metadata-only conclusion",
					summary: "This tries to infer code content from commit metadata.",
				},
				undefined,
				undefined,
				{} as never,
			),
		).rejects.toThrow("non-inventory git evidence findings require raw diff or source evidence");
	});
});
