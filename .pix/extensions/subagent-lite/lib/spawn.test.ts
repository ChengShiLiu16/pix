/**
 * Run: npx tsx --tsconfig extensions/subagent-lite/lib/tsconfig.test.json extensions/subagent-lite/lib/spawn.test.ts
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  buildBlockedToolReason,
  buildCoordinatorHint,
  buildTaskDisabledReason,
  buildToggleMessage,
  buildWorkerCompleteFollowUp,
  buildWorkerViewDisabledReason,
  COORDINATOR_BLOCKED_TOOLS,
  MAX_BACKGROUND,
} from "./multitask-prompt.ts";
import {
  assessWorkerSuccess,
  buildSpawnArgs,
  DEFAULT_TOOLS,
  FAST_FAIL_MS,
  formatDuration,
  formatSessionModel,
  formatWorkerFailure,
  isLikelyErrorOutput,
  summarizeOutput,
  truncateForChat,
} from "./spawn.ts";
import {
  formatParallelTaskResultCollapsed,
  formatParallelTaskResultExpanded,
  formatSubResultsSection,
  formatWorkerResultCollapsed,
  formatWorkerResultExpanded,
  formatWorkerViewHint,
  resolveTaskDetails,
  type ParallelTaskDetails,
  type TaskDetails,
} from "./task-render.ts";
import {
  clearWorkerExpandState,
  isWorkerExpanded,
  registerWorkerToolCall,
  resolveWorkerToolCallId,
  toggleWorkerExpand,
} from "./task-expand.ts";
import { buildWorkerViewMarkdown } from "./worker-view-content.ts";
import { buildWorkerViewPagerContent } from "./worker-view.ts";
import {
  buildSubResult,
  createWorkerStreamParser,
  getFinalOutput,
  summarizeArgs,
} from "./worker-stream.ts";
import {
  buildMissingPromptError,
  normalizeTaskItem,
  resolveTaskPrompt,
} from "./task-params.ts";
import {
  formatWorkerShortcutKey,
  formatWorkerViewActionHint,
  formatWorkerViewShortcutHint,
  orderWorkerIdsMostRecentFirst,
  resolveWorkerShortcutIndex,
  selectWorkerIdByShortcutIndex,
  workerShortcutModifierLabel,
} from "./worker-shortcuts.ts";

function testBuildSpawnArgsDefaults(): void {
  const args = buildSpawnArgs(undefined, "find auth code");
  assert.deepEqual(args.slice(0, 7), ["--mode", "json", "-p", "--no-session", "--no-extensions", "--tools", DEFAULT_TOOLS]);
  assert.equal(args.at(-1), "Task: find auth code");
  assert.ok(!args.includes("--model"));
}

function testBuildSpawnArgsWithAgent(): void {
  const args = buildSpawnArgs(
    {
      name: "scout",
      description: "read-only",
      tools: ["read", "grep"],
      model: "claude-haiku-4-5",
      systemPrompt: "Scout only",
    },
    "map routes",
    { systemPromptFile: "/tmp/scout.md" },
  );
  assert.ok(args.includes("read,grep"));
  assert.ok(args.includes("claude-haiku-4-5"));
  assert.ok(args.includes("/tmp/scout.md"));
}

function testSessionModelPreferredOverAgent(): void {
  const args = buildSpawnArgs(
    { name: "w", description: "", model: "claude-sonnet-4-5", systemPrompt: "" },
    "task",
    { sessionModel: "deepseek/deepseek-v4-pro" },
  );
  assert.ok(args.includes("deepseek/deepseek-v4-pro"));
  assert.ok(!args.includes("claude-sonnet-4-5"));
}

function testFormatSessionModel(): void {
  assert.equal(formatSessionModel({ provider: "deepseek", id: "deepseek-v4-pro" }), "deepseek/deepseek-v4-pro");
  assert.equal(formatSessionModel({ id: "gpt-4o" }), "gpt-4o");
  assert.equal(formatSessionModel(undefined), undefined);
}

function testSummarizeOutput(): void {
  assert.equal(summarizeOutput("  hello\nworld  "), "hello world");
  assert.match(summarizeOutput("x".repeat(300)), /…$/);
}

function testTruncateForChat(): void {
  assert.equal(truncateForChat("short"), "short");
  assert.match(truncateForChat("x".repeat(4000)), /truncated/);
}

function testFormatWorkerFailure(): void {
  const msg = formatWorkerFailure(1, "", "No API key found for anthropic.");
  assert.match(msg, /exit code 1/);
  assert.match(msg, /No API key found/);
  assert.match(msg, /Hint:/);
}

function testWorkerAgentFileExists(): void {
  const workerPath = path.join(process.env.HOME ?? "", ".pi/agent/agents/worker.md");
  const content = fs.readFileSync(workerPath, "utf-8");
  assert.match(content, /name:\s*worker/);
  assert.doesNotMatch(content, /^model:/m);
  assert.match(content, /MUST read/);
  assert.match(content, /技术栈/);
}

function testCoordinatorHint(): void {
  const hint = buildCoordinatorHint();
  assert.match(hint, /MULTITASK/);
  assert.match(hint, /task\(\{ background: true/);
  assert.match(hint, new RegExp(String(MAX_BACKGROUND)));
  assert.match(hint, /followUp.*仅一行状态/);
  assert.match(hint, new RegExp(`${workerShortcutModifierLabel()}\\+1`));
  assert.match(hint, /task 工具行/);
}

function testBlockedTools(): void {
  assert.ok(COORDINATOR_BLOCKED_TOOLS.has("read_many"));
  assert.ok(COORDINATOR_BLOCKED_TOOLS.has("bash"));
  assert.ok(!COORDINATOR_BLOCKED_TOOLS.has("task"));
  assert.match(buildBlockedToolReason("read"), /Multitask ON/);
}

function testToggleMessage(): void {
  assert.match(buildToggleMessage(true), /Multitask ON/);
  assert.match(buildToggleMessage(true), /followUp 仅状态/);
  assert.match(buildToggleMessage(true), new RegExp(`${workerShortcutModifierLabel()}\\+1`));
  assert.match(buildToggleMessage(true), /\/view-worker/);
  assert.match(buildToggleMessage(false), /Multitask OFF/);
  assert.match(buildToggleMessage(false), /task.*禁用/);
  assert.match(buildToggleMessage(false), /已有的 worker/);
}

function testTaskDisabledReason(): void {
  assert.match(buildTaskDisabledReason(), /Multitask OFF/);
  assert.match(buildTaskDisabledReason(), /\/multitask/);
  assert.match(buildTaskDisabledReason(), /task/);
}

function testWorkerViewDisabledReason(): void {
  assert.match(buildWorkerViewDisabledReason(), /Multitask OFF/);
  assert.match(buildWorkerViewDisabledReason(), /已有的 worker/);
}

function testWorkerCompleteFollowUpSuccess(): void {
  const line = buildWorkerCompleteFollowUp(
    "abc123",
    "explore auth module",
    true,
    "## Done\nMapped routes.\n".repeat(500),
    0,
    { durationMs: 52000, toolCalls: 8 },
  );
  assert.match(line, /Worker #abc123/);
  assert.match(line, /✓/);
  assert.match(line, /in 52\.0s/);
  assert.match(line, /explore auth module/);
  const mod = workerShortcutModifierLabel();
  assert.match(line, new RegExp(`▸ ${mod}\\+1 查看 worker #abc123`));
  assert.doesNotMatch(line, /Mapped routes/);
  assert.doesNotMatch(line, /\n/);
}

function testWorkerCompleteFollowUpSuccessIsOneLine(): void {
  const line = buildWorkerCompleteFollowUp(
    "d4906a69",
    "调查顶层结构和配置文件",
    true,
    "项目分析报告：PPTist\n### 1. 项目名称和简介\nPPTist v2.0.0",
    0,
    { durationMs: 51500, toolCalls: 12 },
  );
  assert.equal(line.split("\n").length, 1);
  const mod = workerShortcutModifierLabel();
  assert.match(line, new RegExp(`✓ Worker #d4906a69 完成 in 51\\.5s（调查顶层结构和配置文件） — ▸ ${mod}\\+1 查看 worker #d4906a69`));
}

function testFormatDuration(): void {
  assert.equal(formatDuration(350), "350ms");
  assert.equal(formatDuration(2500), "2.5s");
}

function testIsLikelyErrorOutput(): void {
  assert.ok(isLikelyErrorOutput("No API key found for anthropic."));
  assert.ok(!isLikelyErrorOutput("## Completed\nMapped auth routes."));
}

function testAssessWorkerSuccess(): void {
  const fastEmpty = assessWorkerSuccess(0, "ok", { durationMs: 300, toolCalls: 0 });
  assert.equal(fastEmpty.ok, false);
  assert.match(fastEmpty.reason ?? "", /no tool activity/);

  const apiErr = assessWorkerSuccess(0, "No API key found for anthropic.", { durationMs: 5000, toolCalls: 0 });
  assert.equal(apiErr.ok, false);

  const good = assessWorkerSuccess(0, "x".repeat(200), { durationMs: 45000, toolCalls: 12 });
  assert.equal(good.ok, true);

  const exitFail = assessWorkerSuccess(1, "error", { durationMs: FAST_FAIL_MS + 100, toolCalls: 0 });
  assert.equal(exitFail.ok, false);
}

function testWorkerCompleteFollowUpFailure(): void {
  const line = buildWorkerCompleteFollowUp(
    "dfd3b223",
    "分析 PPTist 项目全景",
    false,
    "No API key found for anthropic.",
    1,
    { durationMs: 340, toolCalls: 0 },
    "no tool activity in 340ms — worker likely did not run",
  );
  assert.match(line, /✗/);
  assert.match(line, /失败/);
  assert.doesNotMatch(line, /未执行分析/);
  assert.match(line, /in 340ms/);
  assert.match(line, /exit 1/);
  assert.match(line, /tool calls: 0/);
  assert.match(line, new RegExp(`▸ ${workerShortcutModifierLabel()}\\+1 查看 worker #dfd3b223 错误详情`));
  assert.doesNotMatch(line, /No API key found/);
  assert.doesNotMatch(line, /\n/);
}

const theme = {
  fg: (_: string, text: string) => text,
  bold: (text: string) => text,
};

function testResolveTaskDetailsPrefersCompleted(): void {
  const stored: TaskDetails = { workerId: "abc", status: "running", description: "scout" };
  const completed: TaskDetails = {
    workerId: "abc",
    status: "done",
    description: "scout",
    output: "## Done",
    durationMs: 45000,
    toolCalls: 12,
  };
  const resolved = resolveTaskDetails(stored, undefined, completed);
  assert.equal(resolved?.status, "done");
  assert.equal(resolved?.toolCalls, 12);
}

function testWorkerResultCollapsedRunning(): void {
  const text = formatWorkerResultCollapsed(
    { workerId: "abc", status: "running", description: "scout routes" },
    "",
    theme,
  );
  assert.match(text, /⚡/);
  assert.match(text, /Worker #abc/);
  assert.match(text, /running/);
  assert.doesNotMatch(text, /Ctrl\+O/);
}

function testWorkerResultCollapsedDone(): void {
  const text = formatWorkerResultCollapsed(
    {
      workerId: "abc",
      status: "done",
      description: "scout routes",
      durationMs: 45000,
      toolCalls: 12,
      output: "## Mapped auth routes\n- login\n- logout",
      summary: "Mapped auth routes",
    },
    "",
    theme,
    () => 1,
  );
  assert.match(text, /45\.0s/);
  assert.match(text, /12 tools/);
  assert.match(text, /Mapped auth routes/);
  const mod = workerShortcutModifierLabel();
  assert.match(text, new RegExp(`▸ ${mod}\\+1 查看 worker #abc`));
  assert.doesNotMatch(text, /Ctrl\+O/);
}

function testWorkerViewHint(): void {
  const hint = formatWorkerViewHint("abc123", theme, () => 1);
  const mod = workerShortcutModifierLabel();
  assert.match(hint, new RegExp(`${mod}\\+1 查看 worker #abc123`));
  const fallback = formatWorkerViewHint("abc123", theme);
  assert.match(fallback, /\/view-worker abc123/);
}

function testWorkerShortcutHelpers(): void {
  const ids = orderWorkerIdsMostRecentFirst(["a", "b", "c"]);
  assert.deepEqual(ids, ["c", "b", "a"]);
  assert.equal(selectWorkerIdByShortcutIndex(ids, 1), "c");
  assert.equal(selectWorkerIdByShortcutIndex(ids, 3), "a");
  assert.equal(resolveWorkerShortcutIndex(ids, "b"), 2);
  const mod = workerShortcutModifierLabel();
  assert.equal(formatWorkerShortcutKey(3), `${mod}+3`);
  assert.match(formatWorkerViewShortcutHint(2, "abc123"), new RegExp(`${mod}\\+2 查看 worker #abc123`));
  assert.match(formatWorkerViewActionHint(1, "abc123", "error"), /错误详情/);
}

function testBuildWorkerViewMarkdown(): void {
  const md = buildWorkerViewMarkdown({
    workerId: "abc",
    status: "done",
    description: "scout routes",
    output: "## Report\n- item",
    subResults: [{ toolName: "read", summary: "file.ts", content: "export function login() {}" }],
  });
  assert.match(md, /scout routes/);
  assert.match(md, /Sub-results/);
  assert.match(md, /read/);
  assert.match(md, /login/);
  assert.match(md, /## Report/);
}

function testBuildWorkerViewMarkdownFullSubResults(): void {
  const longContent = "x".repeat(300);
  const md = buildWorkerViewMarkdown({
    workerId: "abc",
    status: "done",
    description: "scout",
    output: "full output line",
    subResults: [
      { toolName: "grep", summary: longContent.slice(0, 200), content: longContent },
      { toolName: "read", summary: "short", content: "short", isError: true },
    ],
  });
  assert.ok(md.includes(longContent));
  assert.match(md, /✗.*read/);
  assert.match(md, /full output line/);
}

function testBuildWorkerViewMarkdownParallel(): void {
  const md = buildWorkerViewMarkdown({
    parallel: true,
    results: [
      {
        workerId: "aaa",
        status: "done",
        description: "task one",
        output: "Result one full text",
        subResults: [{ toolName: "read", summary: "a", content: "file a contents" }],
      },
      {
        workerId: "bbb",
        status: "done",
        description: "task two",
        output: "Result two full text",
        subResults: [{ toolName: "ls", summary: "b", content: "3 files listed" }],
      },
    ],
  });
  assert.match(md, /parallel workers/);
  assert.match(md, /aaa/);
  assert.match(md, /bbb/);
  assert.match(md, /file a contents/);
  assert.match(md, /Result two full text/);
}

function testBuildWorkerViewMarkdownRunning(): void {
  const md = buildWorkerViewMarkdown({
    workerId: "abc",
    status: "running",
    description: "in progress",
  });
  assert.match(md, /still running/i);
  assert.doesNotMatch(md, /Sub-results/);
}

function testBuildWorkerViewPagerContent(): void {
  const text = buildWorkerViewPagerContent({
    workerId: "abc",
    status: "done",
    description: "scout routes",
    output: "full output",
    subResults: [{ toolName: "grep", summary: "hits", content: "line1\nline2\nline3" }],
  });
  assert.match(text, /^Worker View/m);
  assert.match(text, /Worker #abc · scout routes/);
  assert.match(text, /scout routes/);
  assert.match(text, /Sub-results/);
  assert.match(text, /grep/);
  assert.match(text, /line1/);
  assert.match(text, /full output/);
}

function testWorkerResultExpandedShowsFullOutput(): void {
  const output = "## Mapped auth routes\n- login\n- logout";
  const text = formatWorkerResultExpanded(
    {
      workerId: "abc",
      status: "done",
      description: "scout routes",
      durationMs: 45000,
      toolCalls: 12,
      output,
    },
    "",
    theme,
    false,
  );
  assert.ok(text.includes("Worker #abc"));
  assert.ok(text.includes(output));
  assert.match(text, /▾ expanded · Esc\/Ctrl\+↑ 返回/);
}

function testWorkerExpandStatePerToolCall(): void {
  clearWorkerExpandState();
  registerWorkerToolCall("abc123", "call-a");
  registerWorkerToolCall("def456", "call-b");
  assert.equal(isWorkerExpanded("call-a"), false);
  assert.equal(toggleWorkerExpand("call-a"), true);
  assert.equal(isWorkerExpanded("call-a"), true);
  assert.equal(isWorkerExpanded("call-b"), false);
  toggleWorkerExpand("call-b");
  assert.equal(isWorkerExpanded("call-b"), true);
  assert.equal(resolveWorkerToolCallId("abc"), "call-a");
  assert.equal(resolveWorkerToolCallId(), "call-b");
}

function testWorkerStreamParsesToolResults(): void {
  const stream = createWorkerStreamParser();
  stream.onLine(JSON.stringify({
    type: "tool_execution_start",
    toolName: "read",
    toolCallId: "1",
    args: { path: "src/auth.ts" },
  }));
  stream.onLine(JSON.stringify({
    type: "tool_execution_end",
    toolName: "read",
    toolCallId: "1",
    result: { content: [{ type: "text", text: "export function login() {}" }] },
    isError: false,
  }));
  stream.onLine(JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "## Done\nMapped routes." }] },
  }));
  const snap = stream.snapshot();
  assert.equal(snap.toolCalls, 1);
  assert.equal(snap.subResults.length, 1);
  assert.equal(snap.subResults[0]?.toolName, "read");
  assert.match(snap.subResults[0]?.content ?? "", /login/);
  assert.match(snap.subResults[0]?.argsSummary ?? "", /auth\.ts/);
  assert.equal(getFinalOutput(snap.messages), "## Done\nMapped routes.");
}

function testWorkerStreamCapturesUpdatesAndDedupes(): void {
  const stream = createWorkerStreamParser();
  stream.onLine(JSON.stringify({
    type: "tool_execution_start",
    toolName: "read_many",
    toolCallId: "rm1",
    args: { paths: ["a.ts", "b.ts"] },
  }));
  stream.onLine(JSON.stringify({
    type: "tool_execution_update",
    toolCallId: "rm1",
    toolName: "read_many",
    partialResult: { content: [{ type: "text", text: "partial chunk" }] },
  }));
  stream.onLine(JSON.stringify({
    type: "tool_execution_end",
    toolCallId: "rm1",
    toolName: "read_many",
    result: { content: [{ type: "text", text: "final combined output" }] },
    isError: false,
  }));
  stream.onLine(JSON.stringify({
    type: "message_end",
    message: {
      role: "toolResult",
      toolCallId: "rm1",
      toolName: "read_many",
      content: [{ type: "text", text: "final combined output" }],
    },
  }));
  const snap = stream.snapshot();
  assert.equal(snap.subResults.length, 1);
  assert.match(snap.subResults[0]?.content ?? "", /final combined output/);
}

function testWorkerStreamCountsEndWithoutStart(): void {
  const stream = createWorkerStreamParser();
  stream.onLine(JSON.stringify({
    type: "tool_execution_end",
    toolName: "read",
    toolCallId: "missing-start",
    result: { content: [{ type: "text", text: "file contents" }] },
  }));

  const snap = stream.snapshot();
  assert.equal(snap.toolCalls, 1);
  assert.equal(snap.subResults.length, 1);
}

function testWorkerStreamDedupesToolResultWithoutCallId(): void {
  const stream = createWorkerStreamParser();
  const message = {
    role: "toolResult",
    toolName: "read",
    content: [{ type: "text", text: "same result" }],
  };
  stream.onLine(JSON.stringify({ type: "message_end", message }));
  stream.onLine(JSON.stringify({ type: "agent_end", messages: [message] }));

  const snap = stream.snapshot();
  assert.equal(snap.toolCalls, 1);
  assert.equal(snap.subResults.length, 1);
}

function testSummarizeSubResultTruncatesPreviewOnly(): void {
  const long = "x".repeat(400);
  const sr = buildSubResult("grep", { content: [{ type: "text", text: long }] });
  assert.equal(sr.toolName, "grep");
  assert.match(sr.summary, /…$/);
  assert.equal(sr.content.length, 400);
}

function testSummarizeArgs(): void {
  assert.match(summarizeArgs({ path: "/tmp/foo.ts" }), /foo\.ts/);
}

function testWorkerResultExpandedIncludesSubResults(): void {
  const output = "## Mapped auth routes";
  const text = formatWorkerResultExpanded(
    {
      workerId: "abc",
      status: "done",
      description: "scout routes",
      durationMs: 45000,
      toolCalls: 3,
      output,
      subResults: [
        { toolName: "read", summary: "src/auth.ts", content: "export function login()" },
        { toolName: "grep", summary: "5 matches", content: "5 matches in 3 files" },
      ],
    },
    "",
    theme,
    false,
  );
  assert.match(text, /Sub-results:/);
  assert.match(text, /read/);
  assert.match(text, /grep/);
  assert.ok(text.includes(output));
}

function testParallelTaskResultExpanded(): void {
  const parallel: ParallelTaskDetails = {
    parallel: true,
    results: [
      {
        workerId: "aaa",
        status: "done",
        description: "task one",
        output: "Result one",
        subResults: [{ toolName: "read", summary: "file a", content: "file a" }],
      },
      {
        workerId: "bbb",
        status: "done",
        description: "task two",
        output: "Result two",
        subResults: [{ toolName: "ls", summary: "3 files", content: "3 files" }],
      },
    ],
  };
  const collapsed = formatParallelTaskResultCollapsed(parallel, "", theme);
  assert.match(collapsed, /2 parallel tasks/);
  assert.match(collapsed, /#aaa/);
  assert.match(collapsed, /#bbb/);
  assert.match(collapsed, /Tools: read/);

  const expanded = formatParallelTaskResultExpanded(parallel, "", theme, false);
  assert.match(expanded, /1\./);
  assert.match(expanded, /2\./);
  assert.match(expanded, /Sub-results:/);
  assert.match(expanded, /Result one/);
  assert.match(expanded, /Result two/);
}

function testFormatSubResultsSectionEmpty(): void {
  assert.equal(formatSubResultsSection([], theme), "");
  assert.equal(formatSubResultsSection(undefined, theme), "");
}

function testResolveTaskPromptAliases(): void {
  assert.equal(resolveTaskPrompt({ prompt: "  do work  " }), "do work");
  assert.equal(resolveTaskPrompt({ task: "via task field" }), "via task field");
  assert.equal(resolveTaskPrompt({ instruction: "single" }), "single");
  assert.equal(resolveTaskPrompt({ description: "label only" }), undefined);
}

function testBuildMissingPromptErrorDescriptionOnly(): void {
  const err = buildMissingPromptError({ description: "目录结构与入口分析" });
  assert.match(err, /prompt or tasks\[\] required/);
  assert.match(err, /目录结构与入口分析/);
  assert.match(err, /widget label/);
  assert.match(err, /Received keys: description/);
}

function testNormalizeTaskItemUsesPromptAliases(): void {
  const item = normalizeTaskItem({ task: "explore src/", description: "explore" });
  assert.equal(item.prompt, "explore src/");
  assert.equal(item.description, "explore");
}

function testNormalizeTaskItemDoesNotUseDescriptionAsPrompt(): void {
  const item = normalizeTaskItem({ description: "目录结构分析" });

  assert.equal(item.prompt, "");
  assert.equal(item.description, "目录结构分析");
}

const tests = [
  testBuildSpawnArgsDefaults,
  testBuildSpawnArgsWithAgent,
  testSessionModelPreferredOverAgent,
  testFormatDuration,
  testIsLikelyErrorOutput,
  testAssessWorkerSuccess,
  testFormatSessionModel,
  testSummarizeOutput,
  testTruncateForChat,
  testFormatWorkerFailure,
  testWorkerAgentFileExists,
  testCoordinatorHint,
  testBlockedTools,
  testToggleMessage,
  testTaskDisabledReason,
  testWorkerViewDisabledReason,
  testWorkerCompleteFollowUpSuccess,
  testWorkerCompleteFollowUpSuccessIsOneLine,
  testWorkerCompleteFollowUpFailure,
  testResolveTaskDetailsPrefersCompleted,
  testWorkerResultCollapsedRunning,
  testWorkerResultCollapsedDone,
  testWorkerViewHint,
  testWorkerShortcutHelpers,
  testBuildWorkerViewMarkdown,
  testBuildWorkerViewMarkdownFullSubResults,
  testBuildWorkerViewMarkdownParallel,
  testBuildWorkerViewMarkdownRunning,
  testBuildWorkerViewPagerContent,
  testWorkerResultExpandedShowsFullOutput,
  testWorkerExpandStatePerToolCall,
  testWorkerStreamParsesToolResults,
  testWorkerStreamCapturesUpdatesAndDedupes,
  testWorkerStreamCountsEndWithoutStart,
  testWorkerStreamDedupesToolResultWithoutCallId,
  testSummarizeSubResultTruncatesPreviewOnly,
  testSummarizeArgs,
  testWorkerResultExpandedIncludesSubResults,
  testParallelTaskResultExpanded,
  testFormatSubResultsSectionEmpty,
  testResolveTaskPromptAliases,
  testBuildMissingPromptErrorDescriptionOnly,
  testNormalizeTaskItemUsesPromptAliases,
  testNormalizeTaskItemDoesNotUseDescriptionAsPrompt,
];
let failed = 0;
for (const test of tests) {
  try {
    test();
    console.log(`✓ ${test.name}`);
  } catch (err) {
    failed++;
    console.error(`✗ ${test.name}`, err);
  }
}
if (failed > 0) process.exit(1);
console.log(`\n${tests.length} passed`);
