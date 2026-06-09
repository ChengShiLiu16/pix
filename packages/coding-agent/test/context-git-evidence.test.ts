import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@chengshiliu16/pix-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@chengshiliu16/pix-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	canReuseGitEvidenceWithoutExecuting,
	getGitEvidenceSeriesKey,
} from "../src/core/context-evidence/git-detect.ts";
import {
	applyGitEvidenceTransform,
	clearGitEvidenceCache,
	createGitEvidenceResult,
	detectGitInspection,
	isGitEvidenceDisplayText,
} from "../src/core/context-git-evidence.ts";
import { tryStoreBigOutput } from "../src/core/evidence-store.ts";
import type { BashExecutionMessage } from "../src/core/messages.ts";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";
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

/** 完整 40 字符 SHA，用于测试不可变 git 命令缓存 */
const FULL_SHA = "abcdef1234567890abcdef1234567890abcdef12";

/** 短 SHA（7 字符），用于测试动态 git 命令（不会被缓存） */
const SHORT_SHA = "abcdef1";

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
		expect(detectGitInspection("git grep shouldDowngradeBeacon")?.kind).toBe("grep");
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

	it("captures git grep no-match results as evidence", async () => {
		const cwd = await makeTempDir();
		const tool = createBashToolDefinition(cwd, {
			operations: {
				exec: async () => ({ exitCode: 1 }),
			},
		});

		const result = await tool.execute(
			"grep-no-match",
			{ command: "git grep shouldDowngradeBeacon -- __tests__" },
			undefined,
			undefined,
			{} as never,
		);
		const text = result.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n");

		expect(text).toContain("Git evidence captured: git-grep-");
		expect(text).toContain("Raw: 0 lines, 0 bytes");
		expect(result.details?.gitEvidence?.kind).toBe("grep");
	});

	it("does not serve dynamic git command results from the evidence cache", async () => {
		const cwd = await makeTempDir();
		let calls = 0;
		const tool = createBashToolDefinition(cwd, {
			operations: {
				exec: async (_command, _cwd, { onData }) => {
					calls++;
					onData(Buffer.from(calls === 1 ? " M first.ts\n" : " M second.ts\n"));
					return { exitCode: 0 };
				},
			},
		});

		const first = await tool.execute(
			"status-1",
			{ command: "git status --short" },
			undefined,
			undefined,
			{} as never,
		);
		const second = await tool.execute(
			"status-2",
			{ command: "git status --short" },
			undefined,
			undefined,
			{} as never,
		);
		const secondText = second.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n");

		expect(calls).toBe(2);
		expect(first.details?.gitEvidence?.kind).toBe("status");
		expect(secondText).toContain("second.ts");
	});

	it("does not cache composite git commands with dynamic parts", async () => {
		const cwd = await makeTempDir();
		let calls = 0;
		const tool = createBashToolDefinition(cwd, {
			operations: {
				exec: async (_command, _cwd, { onData }) => {
					calls++;
					onData(Buffer.from(calls === 1 ? `${DIFF_OUTPUT}\n M first.ts\n` : `${DIFF_OUTPUT}\n M second.ts\n`));
					return { exitCode: 0 };
				},
			},
		});

		await tool.execute(
			"composite-1",
			{ command: `git show ${SHORT_SHA} && git status --short` },
			undefined,
			undefined,
			{} as never,
		);
		const second = await tool.execute(
			"composite-2",
			{ command: `git show ${SHORT_SHA} && git status --short` },
			undefined,
			undefined,
			{} as never,
		);
		const rawPath = second.details?.gitEvidence?.rawPath;

		expect(calls).toBe(2);
		expect(rawPath).toBeDefined();
		expect(await readFile(rawPath!, "utf-8")).toContain("second.ts");
	});

	it("serves immutable git command results from the evidence cache", async () => {
		const cwd = await makeTempDir();
		let calls = 0;
		const tool = createBashToolDefinition(cwd, {
			operations: {
				exec: async (_command, _cwd, { onData }) => {
					calls++;
					onData(Buffer.from(DIFF_OUTPUT));
					return { exitCode: 0 };
				},
			},
		});

		await tool.execute("show-1", { command: `git show ${FULL_SHA}` }, undefined, undefined, {} as never);
		await tool.execute("show-2", { command: `git show ${FULL_SHA}` }, undefined, undefined, {} as never);

		expect(calls).toBe(1);
	});

	it("does not skip execution for short SHA commands", async () => {
		const cwd = await makeTempDir();
		let calls = 0;
		const tool = createBashToolDefinition(cwd, {
			operations: {
				exec: async (_command, _cwd, { onData }) => {
					calls++;
					onData(Buffer.from(DIFF_OUTPUT));
					return { exitCode: 0 };
				},
			},
		});

		await tool.execute("short-show-1", { command: `git show ${SHORT_SHA}` }, undefined, undefined, {} as never);
		await tool.execute("short-show-2", { command: `git show ${SHORT_SHA}` }, undefined, undefined, {} as never);

		expect(calls).toBe(2);
	});

	it("uses the resolved spawn context for git evidence cache keys", async () => {
		const firstCwd = await makeTempDir();
		const secondCwd = await makeTempDir();
		let calls = 0;
		const tool = createBashToolDefinition(firstCwd, {
			spawnHook: (context) => ({ ...context, cwd: secondCwd }),
			operations: {
				exec: async (_command, _cwd, { onData }) => {
					calls++;
					onData(Buffer.from(DIFF_OUTPUT));
					return { exitCode: 0 };
				},
			},
		});

		const first = await tool.execute(
			"spawn-show-1",
			{ command: `git show ${FULL_SHA}` },
			undefined,
			undefined,
			{} as never,
		);
		const second = await tool.execute(
			"spawn-show-2",
			{ command: `git show ${FULL_SHA}` },
			undefined,
			undefined,
			{} as never,
		);

		expect(calls).toBe(1);
		expect(first.details?.gitEvidence?.rawPath).toContain(secondCwd);
		expect(second.details?.gitEvidence?.rawPath).toContain(secondCwd);
	});

	it("does not reuse immutable git evidence when git environment changes", async () => {
		const cwd = await makeTempDir();
		let calls = 0;
		let hookCalls = 0;
		const tool = createBashToolDefinition(cwd, {
			spawnHook: (context) => {
				hookCalls++;
				return {
					...context,
					env: { ...context.env, GIT_INDEX_FILE: join(cwd, `index-${hookCalls}`) },
				};
			},
			operations: {
				exec: async (_command, _cwd, { env, onData }) => {
					calls++;
					onData(Buffer.from(DIFF_OUTPUT.replace("fix: improve todo handling", `fix: ${env?.GIT_INDEX_FILE}`)));
					return { exitCode: 0 };
				},
			},
		});

		const first = await tool.execute(
			"env-show-1",
			{ command: `git show ${FULL_SHA}` },
			undefined,
			undefined,
			{} as never,
		);
		const second = await tool.execute(
			"env-show-2",
			{ command: `git show ${FULL_SHA}` },
			undefined,
			undefined,
			{} as never,
		);

		expect(calls).toBe(2);
		expect(first.details?.gitEvidence?.gitContextKey).not.toBe(second.details?.gitEvidence?.gitContextKey);
		expect(await readFile(second.details!.gitEvidence!.rawPath!, "utf-8")).toContain("index-2");
	});

	it("detects evidence display blocks for dim rendering", () => {
		expect(isGitEvidenceDisplayText("==== Evidence: git-show-abcdef123456 ====\nGit evidence captured:")).toBe(true);
		expect(isGitEvidenceDisplayText("==== Evidence superseded: git-status-abcdef123456 ====\nCommand:")).toBe(true);
		expect(isGitEvidenceDisplayText("==== git-grep-abcdef123456 ====\n(no matches)")).toBe(true);
		expect(isGitEvidenceDisplayText("[Evidence span git-diff-abcdef123456:1-2 hash=abc]")).toBe(true);
		expect(isGitEvidenceDisplayText("ordinary tool output")).toBe(false);
	});

	it("only treats immutable git evidence commands as cacheable", () => {
		expect(canReuseGitEvidenceWithoutExecuting(`git show ${FULL_SHA}`)).toBe(true);
		expect(canReuseGitEvidenceWithoutExecuting(`git diff-tree --stat --no-commit-id -r ${FULL_SHA}`)).toBe(true);
		expect(canReuseGitEvidenceWithoutExecuting(`git log -1 --format="%H%n%s" ${FULL_SHA}`)).toBe(true);
		expect(canReuseGitEvidenceWithoutExecuting(`git log --max-count=1 --format="%H%n%s" ${FULL_SHA}`)).toBe(true);
		expect(canReuseGitEvidenceWithoutExecuting(`git show ${SHORT_SHA}`)).toBe(false);
		expect(canReuseGitEvidenceWithoutExecuting("git status --short")).toBe(false);
		expect(canReuseGitEvidenceWithoutExecuting("git diff")).toBe(false);
		expect(canReuseGitEvidenceWithoutExecuting("git show HEAD")).toBe(false);
		expect(canReuseGitEvidenceWithoutExecuting(`git show ${SHORT_SHA} HEAD`)).toBe(false);
		expect(canReuseGitEvidenceWithoutExecuting(`git show ${SHORT_SHA} && git status --short`)).toBe(false);
		expect(canReuseGitEvidenceWithoutExecuting(`git show ${SHORT_SHA} | head -200`)).toBe(false);
		expect(canReuseGitEvidenceWithoutExecuting("git log --oneline -5")).toBe(false);
		expect(canReuseGitEvidenceWithoutExecuting("git log -1 HEAD")).toBe(false);
		expect(canReuseGitEvidenceWithoutExecuting(`git log --oneline --all ${SHORT_SHA}`)).toBe(false);
	});

	it("classifies dynamic git evidence into current-state series", () => {
		expect(getGitEvidenceSeriesKey("git status --short", "status", "dynamic")).toBe("working_tree:status");
		expect(getGitEvidenceSeriesKey("git diff", "diff", "dynamic")).toBe("working_tree:diff:unstaged");
		expect(getGitEvidenceSeriesKey("git diff --cached", "diff", "dynamic")).toBe("working_tree:diff:cached");
		expect(getGitEvidenceSeriesKey("git diff HEAD", "diff", "dynamic")).toBe("working_tree:diff:head");
		expect(getGitEvidenceSeriesKey("git show HEAD", "show", "dynamic")).toBe("head:show");
		expect(getGitEvidenceSeriesKey("git log --oneline -5", "log", "dynamic")).toBe("head:log");
		expect(getGitEvidenceSeriesKey("git diff -- src/a.ts", "diff", "dynamic")).toBeUndefined();
		expect(getGitEvidenceSeriesKey("git status --short src/a.ts", "status", "dynamic")).toBeUndefined();
		expect(getGitEvidenceSeriesKey("git show HEAD -- src/a.ts", "show", "dynamic")).toBeUndefined();
		expect(getGitEvidenceSeriesKey("git diff --cached src/a.ts", "diff", "dynamic")).toBeUndefined();
		expect(getGitEvidenceSeriesKey("git show HEAD src/a.ts", "show", "dynamic")).toBeUndefined();
		expect(getGitEvidenceSeriesKey("git show abcdef1 && git status --short", "show", "dynamic")).toBeUndefined();
	});
});

describe("big output evidence store", () => {
	it("does not rewrite duplicate big output evidence", async () => {
		const cwd = await makeTempDir();
		const output = Array.from({ length: 120 }, (_, index) => `line ${index}`).join("\n");
		const first = await tryStoreBigOutput(cwd, output, 0);
		expect(first).toBeDefined();
		const oldDate = new Date(Date.now() - 60_000);
		await utimes(first!.rawPath, oldDate, oldDate);

		const second = await tryStoreBigOutput(cwd, output, 0);
		expect(second?.rawPath).toBe(first!.rawPath);
		const fileStat = await stat(first!.rawPath);
		expect(Math.abs(fileStat.mtimeMs - oldDate.getTime())).toBeLessThan(1000);
	});
});

describe("createGitEvidenceResult", () => {
	it("stores raw output and returns a compact digest", async () => {
		const cwd = await makeTempDir();
		const result = await createGitEvidenceResult(`git show ${SHORT_SHA}`, cwd, DIFF_OUTPUT);

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

		expect(result?.text).toContain("Parser note: structured diff metadata was not detected");
		expect(result?.text).not.toContain("export const feature = true");
		expect(result?.text).toContain("use git_evidence_read");
	});

	it("reuses a full output file when the visible bash output was truncated", async () => {
		const cwd = await makeTempDir();
		const fullPath = join(cwd, "full-output.log");
		await writeFile(fullPath, DIFF_OUTPUT, "utf-8");

		const result = await createGitEvidenceResult("git show abcdef1", cwd, "[Showing lines 1-10]", fullPath);

		expect(result?.text).toContain("src/todo.ts");
		expect(await readFile(result!.details.rawPath!, "utf-8")).toBe(DIFF_OUTPUT);
	});

	it("marks evidence incomplete when the full output file cannot be read", async () => {
		const cwd = await makeTempDir();
		const result = await createGitEvidenceResult(
			`git show ${SHORT_SHA}`,
			cwd,
			"[Showing lines 1-10]",
			join(cwd, "missing.log"),
		);

		expect(result?.details.rawIncomplete).toBe(true);
		expect(result?.text).toContain("Raw warning: full bash output was unavailable");
		expect(result?.text).toContain("exact raw output is not available");
		expect(result?.text).toContain("Collect narrower git evidence");
		expect(result?.text).not.toContain("use git_evidence_read");
	});

	it("does not present raw storage failures as exact readable evidence", async () => {
		const cwd = await makeTempDir();
		const blockedCwd = join(cwd, "not-a-directory");
		await writeFile(blockedCwd, "file blocks evidence directory creation", "utf-8");

		const result = await createGitEvidenceResult(
			"git show abcdef1:src/feature.ts",
			blockedCwd,
			"export const feature = true;\n",
		);

		expect(result?.details.rawStorageFailed).toBe(true);
		expect(result?.details.rawPath).toBeUndefined();
		expect(result?.text).toContain("Raw warning: evidence storage failed");
		expect(result?.text).toContain("exact raw output is not available");
		expect(result?.text).toContain("Collect narrower git evidence");
		expect(result?.text).not.toContain("use git_evidence_read");
	});

	it("extracts file summaries from --stat output", async () => {
		const cwd = await makeTempDir();
		const result = await createGitEvidenceResult("git show --stat 1234567", cwd, STAT_OUTPUT);

		expect(result?.text).toContain("1234567890abcdef feat: update files");
		expect(result?.text).toContain("src/a.ts (+2/-1)");
		expect(result?.text).toContain("src/binary.png (+0/-0)");
	});

	it("marks broad ref logs with all_refs scope warnings", async () => {
		const cwd = await makeTempDir();
		const result = await createGitEvidenceResult("git log -25 --oneline --all", cwd, CUSTOM_LOG_OUTPUT);

		expect(result?.details.scope?.type).toBe("all_refs");
		expect(result?.text).toContain("Scope: all_refs");
		expect(result?.text).toContain("Scope warning:");
	});

	it("marks default logs as current_head scope", async () => {
		const cwd = await makeTempDir();
		const result = await createGitEvidenceResult("git log -25 --oneline", cwd, CUSTOM_LOG_OUTPUT);

		expect(result?.details.scope?.type).toBe("current_head");
		expect(result?.text).toContain("Scope: current_head");
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
			await createGitEvidenceResult(`git show ${sha}`, cwd, `${sha} commit ${index}`);
		}
		const evidenceDir = join(cwd, ".pix", "session-evidence", "git");
		const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000);
		for (const file of await readdir(evidenceDir)) {
			if (file.endsWith(".txt")) await utimes(join(evidenceDir, file), oldDate, oldDate);
		}

		await createGitEvidenceResult("git show fffffff", cwd, "fffffff trigger");

		const files = await readdir(evidenceDir);
		expect(files.filter((file) => file.endsWith(".txt")).length).toBe(161);
	});

	it("does not prune protected evidence files", async () => {
		const cwd = await makeTempDir();
		for (let index = 0; index < 205; index++) {
			const sha = index.toString(16).padStart(7, "0");
			await createGitEvidenceResult(`git show ${sha}`, cwd, `${sha} protected commit ${index}`);
		}

		const files = await readdir(join(cwd, ".pix", "session-evidence", "git"));
		expect(files.filter((file) => file.endsWith(".txt")).length).toBe(205);
	});

	it("does not split UTF-8 multi-byte characters at the truncation boundary", async () => {
		const cwd = await makeTempDir();
		const emoji = "\u2705";
		const target = 20 * 1024 * 1024 + 1024;
		const output = emoji.repeat(Math.ceil(target / emoji.length));

		const result = await createGitEvidenceResult("git show abcdef1", cwd, output);

		expect(result).toBeDefined();
		const raw = await readFile(result!.details.rawPath!, "utf-8");
		expect(raw).not.toContain("\uFFFD");
	});
});

describe("applyGitEvidenceTransform", () => {
	it("replaces bash tool results for git inspection output", async () => {
		const cwd = await makeTempDir();
		const messages: AgentMessage[] = [assistantCall("c1", "git show abcdef1"), toolResult("c1", DIFF_OUTPUT)];

		const result = await applyGitEvidenceTransform(messages, cwd, {});

		expect(result).not.toBe(messages);
		expect(resultText(result[1])).toContain("Git evidence captured:");
		expect(resultText(result[1])).toContain("src/todo.ts");
		expect(resultText(result[1])).not.toContain("Author: Test");
	});

	it("does not replace non-git bash output", async () => {
		const cwd = await makeTempDir();
		const messages: AgentMessage[] = [assistantCall("c1", "echo ok"), toolResult("c1", "ok")];

		expect(await applyGitEvidenceTransform(messages, cwd, {})).toBe(messages);
	});

	it("also compacts interactive bashExecution messages", async () => {
		const cwd = await makeTempDir();
		const message: BashExecutionMessage = {
			role: "bashExecution",
			command: `git show ${SHORT_SHA}`,
			output: DIFF_OUTPUT,
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: 0,
		};

		const result = await applyGitEvidenceTransform([message], cwd, {});

		expect(result[0].role).toBe("bashExecution");
		expect((result[0] as BashExecutionMessage).output).toContain("Git evidence captured:");
		expect((result[0] as BashExecutionMessage).output).not.toContain("Author: Test");
		expect((result[0] as BashExecutionMessage).fullOutputPath).toContain(".pix/session-evidence/git/");
	});

	it("keeps only the two latest git evidence results detailed in context", async () => {
		const cwd = await makeTempDir();
		const messages: AgentMessage[] = [
			assistantCall("c1", `git show ${SHORT_SHA}`),
			toolResult("c1", DIFF_OUTPUT),
			assistantCall("c2", "git show abcdef2"),
			toolResult("c2", DIFF_OUTPUT.replace("abcdef1234567890", "bbbbbbb1234567890")),
			assistantCall("c3", "git show abcdef3"),
			toolResult("c3", DIFF_OUTPUT.replace("abcdef1234567890", "ccccccc1234567890")),
		];

		const result = await applyGitEvidenceTransform(messages, cwd, {});

		// bash 返回的已经是 compactText，旧 evidence 只有比 compactText 更大时才会再次压缩。
		expect(resultText(result[1])).toContain("+const nextValue = getNextValue();");
		expect(resultText(result[3])).toContain("+const nextValue = getNextValue();");
		expect(resultText(result[5])).toContain("+const nextValue = getNextValue();");
	});

	it("marks older dynamic git status evidence as superseded", async () => {
		const cwd = await makeTempDir();
		const messages: AgentMessage[] = [
			assistantCall("s1", "git status --short"),
			toolResult("s1", " M first.ts\n"),
			assistantCall("s2", "git status --short"),
			toolResult("s2", " M second.ts\n"),
		];

		const result = await applyGitEvidenceTransform(messages, cwd, {});
		const firstText = resultText(result[1]);
		const secondText = resultText(result[3]);
		const firstDetails = (result[1] as ToolResultMessage).details?.gitEvidence;
		const secondDetails = (result[3] as ToolResultMessage).details?.gitEvidence;

		expect(firstText).toContain("Evidence superseded:");
		expect(firstText).toContain("Do not use it as current repository state");
		expect(firstText).toContain(`Superseded by: ${secondDetails?.id}`);
		expect(firstText).toContain(`Use git_evidence_read with ${secondDetails?.id}`);
		expect(firstText).not.toContain("first.ts");
		expect(firstDetails?.supersededBy).toBe(secondDetails?.id);
		expect(secondText).toContain("Git evidence captured:");
		expect(secondText).toContain("second.ts");
		expect(secondText).not.toContain("Evidence superseded:");
	});

	it("does not let superseded tombstones consume detailed evidence slots", async () => {
		const cwd = await makeTempDir();
		const show = await createGitEvidenceResult("git show abcdef1", cwd, DIFF_OUTPUT);
		const firstStatus = await createGitEvidenceResult("git status --short", cwd, " M first.ts\n");
		const secondStatus = await createGitEvidenceResult("git status --short", cwd, " M second.ts\n");
		const messages: AgentMessage[] = [
			{
				...toolResult("show", show!.details.detailedText),
				details: { gitEvidence: show!.details },
			},
			{
				...toolResult("status-1", firstStatus!.details.detailedText),
				details: { gitEvidence: firstStatus!.details },
			},
			{
				...toolResult("status-2", secondStatus!.details.detailedText),
				details: { gitEvidence: secondStatus!.details },
			},
		];

		const result = await applyGitEvidenceTransform(messages, cwd, {});

		expect(resultText(result[0])).toContain("Prefer git_evidence_read/search");
		expect(resultText(result[1])).toContain("Evidence superseded:");
		expect(resultText(result[2])).toContain("Prefer git_evidence_read/search");
	});

	it("does not supersede dynamic git status evidence from different git contexts", async () => {
		const cwd = await makeTempDir();
		const repoA = await makeTempDir();
		const repoB = await makeTempDir();
		const messages: AgentMessage[] = [
			assistantCall("s1", `git -C ${repoA} status --short`),
			toolResult("s1", " M repo-a.ts\n"),
			assistantCall("s2", `git -C ${repoB} status --short`),
			toolResult("s2", " M repo-b.ts\n"),
		];

		const result = await applyGitEvidenceTransform(messages, cwd, {});

		expect(resultText(result[1])).toContain("repo-a.ts");
		expect(resultText(result[1])).not.toContain("Evidence superseded:");
		expect(resultText(result[3])).toContain("repo-b.ts");
		expect(resultText(result[3])).not.toContain("Evidence superseded:");
	});

	it("does not supersede path-limited dynamic git evidence", async () => {
		const cwd = await makeTempDir();
		const messages: AgentMessage[] = [
			assistantCall("d1", "git diff -- src/a.ts"),
			toolResult("d1", DIFF_OUTPUT.replace("src/todo.ts", "src/a.ts")),
			assistantCall("d2", "git diff -- src/b.ts"),
			toolResult("d2", DIFF_OUTPUT.replace("src/todo.ts", "src/b.ts")),
		];

		const result = await applyGitEvidenceTransform(messages, cwd, {});

		expect(resultText(result[1])).toContain("src/a.ts");
		expect(resultText(result[1])).not.toContain("Evidence superseded:");
		expect(resultText(result[3])).toContain("src/b.ts");
		expect(resultText(result[3])).not.toContain("Evidence superseded:");
	});

	it("does not treat historical truncated git output as complete evidence", async () => {
		const cwd = await makeTempDir();
		const truncatedResult = {
			...toolResult("t1", "export const feature = true;\n"),
			details: { truncation: { truncated: true } },
		} satisfies ToolResultMessage & { details: { truncation: { truncated: boolean } } };
		const messages: AgentMessage[] = [assistantCall("t1", "git show abcdef1:src/feature.ts"), truncatedResult];

		const result = await applyGitEvidenceTransform(messages, cwd, {});
		const text = resultText(result[1]);

		expect(text).toContain("Raw warning: full bash output was unavailable");
		expect(text).toContain("exact raw output is not available");
		expect(text).not.toContain("use git_evidence_read");
	});

	it("does not supersede different dynamic git diff series", async () => {
		const cwd = await makeTempDir();
		const messages: AgentMessage[] = [
			assistantCall("d1", "git diff"),
			toolResult("d1", DIFF_OUTPUT.replace("src/todo.ts", "src/unstaged.ts")),
			assistantCall("d2", "git diff --cached"),
			toolResult("d2", DIFF_OUTPUT.replace("src/todo.ts", "src/cached.ts")),
		];

		const result = await applyGitEvidenceTransform(messages, cwd, {});

		expect(resultText(result[1])).toContain("Git evidence captured:");
		expect(resultText(result[1])).not.toContain("Evidence superseded:");
		expect(resultText(result[3])).toContain("Git evidence captured:");
		expect(resultText(result[3])).not.toContain("Evidence superseded:");
	});

	it("does not supersede immutable git show evidence", async () => {
		const cwd = await makeTempDir();
		const messages: AgentMessage[] = [
			assistantCall("i1", `git show ${SHORT_SHA}`),
			toolResult("i1", DIFF_OUTPUT.replace("abcdef1234567890", "abcdef1111111111")),
			assistantCall("i2", "git show abcdef2"),
			toolResult("i2", DIFF_OUTPUT.replace("abcdef1234567890", "abcdef2222222222")),
		];

		const result = await applyGitEvidenceTransform(messages, cwd, {});

		expect(resultText(result[1])).toContain("Git evidence captured:");
		expect(resultText(result[1])).not.toContain("Evidence superseded:");
		expect(resultText(result[3])).toContain("Git evidence captured:");
		expect(resultText(result[3])).not.toContain("Evidence superseded:");
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

	it("reads grep evidence ids", async () => {
		const cwd = await makeTempDir();
		const evidence = await createGitEvidenceResult(
			"git grep shouldDowngradeBeacon",
			cwd,
			"test.ts:shouldDowngradeBeacon();\n",
		);
		const tool = createGitEvidenceReadToolDefinition(cwd);

		const result = await tool.execute(
			"read-grep-evidence",
			{ id: evidence!.details.id, limit: 2 },
			undefined,
			undefined,
			{} as never,
		);
		const text = result.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n");

		expect(evidence!.details.id).toMatch(/^git-grep-/u);
		expect(text).toContain("shouldDowngradeBeacon");
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
						excerptHash: undefined,
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

	it("returns schema help for findings values", async () => {
		const cwd = await makeTempDir();
		const tool = createGitEvidenceFindingsToolDefinition(cwd);

		const result = await tool.execute("schema-help", { action: "schema" }, undefined, undefined, {} as never);
		const text = result.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n");

		expect(text).toContain("claimKind:");
		expect(text).toContain("inventory: scope/theme/classification");
		expect(text).toContain("basis:");
		expect(text).toContain("metadata: commit subject");
		expect(text).toContain("overview/summary/scope -> claimKind=inventory");
		expect(JSON.stringify(tool.parameters)).toContain(
			"Optional hash for validation; auto-computed when omitted, rejected when mismatched",
		);
		expect(JSON.stringify(tool.parameters)).not.toContain("auto-computed if not provided or incorrect");
	});

	it("normalizes common claimKind and basis aliases", async () => {
		const cwd = await makeTempDir();
		const evidence = await createGitEvidenceResult("git log -5 --oneline", cwd, CUSTOM_LOG_OUTPUT);
		const tool = createGitEvidenceFindingsToolDefinition(cwd);

		const result = await tool.execute(
			"add-normalized-finding",
			{
				action: "add",
				claimKind: "summary",
				basis: "git_log",
				evidenceSpans: [{ evidenceId: evidence!.details.id, startLine: 1, endLine: 8 }],
				confidence: "high",
				title: "commit overview",
				summary: "The recent commits focus on rendering compatibility.",
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
		expect(text).toContain("(inventory, metadata");
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

	it("rejects mismatched evidence span hashes", async () => {
		const cwd = await makeTempDir();
		const evidence = await createGitEvidenceResult("git show abcdef1", cwd, DIFF_OUTPUT);
		const tool = createGitEvidenceFindingsToolDefinition(cwd);

		await expect(
			tool.execute(
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
					title: "mismatched hash",
					summary: "Hash mismatch should be surfaced.",
				},
				undefined,
				undefined,
				{} as never,
			),
		).rejects.toThrow("Git evidence span hash mismatch");
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

	it("returns actionable messages for invalid findings values", async () => {
		const cwd = await makeTempDir();
		const tool = createGitEvidenceFindingsToolDefinition(cwd);

		await expect(
			tool.execute(
				"add-invalid-kind",
				{
					action: "add",
					claimKind: "narrative",
					basis: "metadata",
					title: "invalid kind",
					summary: "This uses an unsupported claim kind.",
				},
				undefined,
				undefined,
				{} as never,
			),
		).rejects.toThrow(
			'Invalid claimKind "narrative". Allowed: inventory, content, behavior, correctness, absence, causality, hypothesis.',
		);

		await expect(
			tool.execute(
				"add-invalid-basis",
				{
					action: "add",
					claimKind: "inventory",
					basis: "narrative prose",
					title: "invalid basis",
					summary: "This uses a prose basis.",
				},
				undefined,
				undefined,
				{} as never,
			),
		).rejects.toThrow(
			'Invalid basis "narrative prose". Allowed: metadata, stat, raw_diff, source, raw_diff_and_source.',
		);
	});

	it("requires search evidence for absence findings", async () => {
		const cwd = await makeTempDir();
		const tool = createGitEvidenceFindingsToolDefinition(cwd);

		await expect(
			tool.execute(
				"add-unsupported-absence",
				{
					action: "add",
					claimKind: "absence",
					basis: "source",
					title: "missing tests",
					summary: "No tests exist for this behavior.",
				},
				undefined,
				undefined,
				{} as never,
			),
		).rejects.toThrow("absence findings require search evidence spans");
	});

	it("records absence findings with grep evidence", async () => {
		const cwd = await makeTempDir();
		const evidence = await createGitEvidenceResult("git grep shouldDowngradeBeacon -- __tests__", cwd, "");
		const tool = createGitEvidenceFindingsToolDefinition(cwd);

		const result = await tool.execute(
			"add-supported-absence",
			{
				action: "add",
				claimKind: "absence",
				basis: "source",
				evidenceSpans: [{ evidenceId: evidence!.details.id, startLine: 1, endLine: 1 }],
				confidence: "medium",
				title: "no matching tests found",
				summary: "Search evidence for the test tree returned no matches.",
				limitations: "Only the searched test tree is covered by this absence claim.",
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
		expect(text).toContain("(absence, source");
		expect(text).toContain(evidence!.details.id);
	});

	it("requires limitations and both evidence types for causality findings", async () => {
		const cwd = await makeTempDir();
		const evidence = await createGitEvidenceResult("git show abcdef1", cwd, DIFF_OUTPUT);
		const tool = createGitEvidenceFindingsToolDefinition(cwd);

		await expect(
			tool.execute(
				"add-unsupported-causality",
				{
					action: "add",
					claimKind: "causality",
					basis: "raw_diff",
					evidenceSpans: [{ evidenceId: evidence!.details.id, startLine: 11, endLine: 13 }],
					title: "change caused test failure",
					summary: "This tries to prove causality from only a diff.",
				},
				undefined,
				undefined,
				{} as never,
			),
		).rejects.toThrow("causality findings require limitations");
	});

	it("records causality findings with raw and source evidence plus limitations", async () => {
		const cwd = await makeTempDir();
		await writeFile(join(cwd, "todo.ts"), "const nextValue = getNextValue();\nvalidateTodo(nextValue);\n", "utf-8");
		const evidence = await createGitEvidenceResult("git show abcdef1", cwd, DIFF_OUTPUT);
		const tool = createGitEvidenceFindingsToolDefinition(cwd);

		const result = await tool.execute(
			"add-supported-causality",
			{
				action: "add",
				claimKind: "causality",
				basis: "raw_diff_and_source",
				evidenceSpans: [{ evidenceId: evidence!.details.id, startLine: 11, endLine: 13 }],
				sourceSpans: [{ path: "todo.ts", startLine: 1, endLine: 2 }],
				confidence: "medium",
				title: "validation change affected behavior",
				summary: "The diff and current source both show validateTodo in the update path.",
				limitations: "Causality is limited to the inspected diff/source and does not include runtime reproduction.",
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
		expect(text).toContain("(causality, raw_diff_and_source");
		expect(text).toContain("source=todo.ts:1-2");
	});
});
