import assert from "node:assert/strict";
import { deriveThinkingSteps, splitThinkingIntoStepTexts, summarizeThinkingText } from "../parse.js";
import { getOversizedThinkingInfo, renderThinkingStepsLines, THINKING_PARSE_CHAR_LIMIT } from "../render.js";
import type { ThinkingThemeLike } from "../types.js";

const theme: ThinkingThemeLike = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

const taggedTheme: ThinkingThemeLike = {
  fg: (color, text) => `[${color}]${text}[/${color}]`,
  bold: (text) => `<b>${text}</b>`,
};

function testSplitsListItemsIntoSteps(): void {
  const steps = splitThinkingIntoStepTexts("Plan:\n\n- Inspect files\n- Patch renderer\n- Run tests");

  assert.equal(steps.filter((step) => step.includes("- ")).length, 3);
  assert.ok(steps.some((step) => step.includes("Inspect files")));
}

function testSummarizesExplicitFailure(): void {
  assert.equal(summarizeThinkingText("npm test failed with exit code 1."), "Npm test failed with exit code 1.");
}

function testDerivesRedactedThinkingStep(): void {
  const steps = deriveThinkingSteps([{ contentIndex: 0, text: "", redacted: true }]);

  assert.equal(steps.length, 1);
  assert.equal(steps[0]?.summary, "Reasoning is hidden by the provider.");
}

function testRendersCollapsedLines(): void {
  const steps = deriveThinkingSteps([{ contentIndex: 0, text: "I should inspect src/app.ts before editing." }]);
  const lines = renderThinkingStepsLines(theme, 80, {
    mode: "collapsed",
    steps,
    isActive: false,
  });

  assert.ok(lines.length > 0);
  assert.ok(lines[0]?.includes("Thinking"));
}

function testDetectsOversizedThinkingBeforeDerivation(): void {
  const oversized = getOversizedThinkingInfo([
    { contentIndex: 0, text: "x".repeat(THINKING_PARSE_CHAR_LIMIT + 1) },
  ]);

  assert.equal(oversized?.totalChars, THINKING_PARSE_CHAR_LIMIT + 1);
  assert.equal(oversized?.blockCount, 1);
}

function testActiveSummaryConnectorStaysMuted(): void {
  const steps = deriveThinkingSteps([{ contentIndex: 0, text: "I should inspect src/app.ts before editing." }]);
  const activeStepId = steps[0]?.id;

  assert.ok(activeStepId);

  const lines = renderThinkingStepsLines(taggedTheme, 80, {
    mode: "summary",
    steps,
    activeStepId,
    isActive: true,
  });

  assert.ok(lines.some((line) => line.includes("[muted]└─[/muted]")));
  assert.ok(!lines.some((line) => line.includes("[accent]└─[/accent]")));
}

const tests = [
  testSplitsListItemsIntoSteps,
  testSummarizesExplicitFailure,
  testDerivesRedactedThinkingStep,
  testRendersCollapsedLines,
  testDetectsOversizedThinkingBeforeDerivation,
  testActiveSummaryConnectorStaysMuted,
];

for (const test of tests) {
  test();
}

console.log(`thinking-steps: ${tests.length} tests passed`);
