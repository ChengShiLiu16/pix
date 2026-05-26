import assert from "node:assert/strict";
import { inferThinkingRole, summarizeThinkingText } from "../parse.js";

function testPrefersLaterExplicitSuccessAfterFailure(): void {
  const summary = summarizeThinkingText("npm test failed with exit code 1. npm test passed after updating mocks.");

  assert.equal(summary, "Tests passed after updating mocks.");
}

function testPreservesConcreteFileFocus(): void {
  const summary = summarizeThinkingText("Before editing I should inspect src/render.ts and renderThinkingStepsLines().");

  assert.ok(summary.includes("src/render.ts"));
}

function testRoleInference(): void {
  assert.equal(inferThinkingRole("I need to verify the test suite passed."), "verify");
  assert.equal(inferThinkingRole("Search for render call sites."), "search");
}

const tests = [
  testPrefersLaterExplicitSuccessAfterFailure,
  testPreservesConcreteFileFocus,
  testRoleInference,
];

for (const test of tests) {
  test();
}

console.log(`summarizer-challenger: ${tests.length} tests passed`);
