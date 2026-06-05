import type { AgentMessage } from "@earendil-works/pix-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pix-ai";
import { describe, expect, it } from "vitest";
import { ageToolResults } from "../src/core/context-aging.ts";
import { computeReachability } from "../src/core/context-reachability.ts";

function userMessage(text: string): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: 0,
	} as AgentMessage;
}

function assistantCall(id: string, name: string, args: Record<string, unknown>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: args }],
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

function toolResult(id: string, toolName: string, text: string, isError = false): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName,
		content: [{ type: "text", text }],
		isError,
		timestamp: 0,
	};
}

function resultText(message: AgentMessage): string {
	if (message.role !== "toolResult") return "";
	return (message as ToolResultMessage).content
		.filter((b): b is { type: "text"; text: string } => b.type === "text")
		.map((b) => b.text)
		.join("");
}

const BIG = "x".repeat(1000);
const FIFTY_LINES = Array.from({ length: 50 }, (_, i) => `line ${i + 1}: ${"x".repeat(30)}`).join("\n");

describe("computeReachability", () => {
	it("marks a focus-window result as active", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "read", { path: "/src/a.ts" }),
			toolResult("c1", "read", BIG),
			userMessage("check it"),
			userMessage("turn 2"),
			assistantCall("c2", "read", { path: "/src/a.ts" }),
			toolResult("c2", "read", BIG),
		];
		const reachability = computeReachability(messages, 2, "/");
		// c1 is before the focus window → adjacent (same path as focus)
		expect(reachability.get(1)).toBe("adjacent");
		// c2 is within the focus window → active
		expect(reachability.get(5)).toBe("active");
	});

	it("marks a result as adjacent when its scope overlaps a recent target", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "grep", { pattern: "foo", path: "/src" }),
			toolResult("c1", "grep", BIG),
			userMessage("check it"),
			userMessage("turn 2"),
			assistantCall("c2", "read", { path: "/src/core/a.ts" }),
			toolResult("c2", "read", BIG),
		];
		const reachability = computeReachability(messages, 2, "/");
		// grep on /src is adjacent to read on /src/core/a.ts (scope overlap)
		expect(reachability.get(1)).toBe("adjacent");
		expect(reachability.get(5)).toBe("active");
	});

	it("marks results as unrelated when they have no path overlap", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "read", { path: "/src/a.ts" }),
			toolResult("c1", "read", BIG),
			userMessage("check it"),
			userMessage("turn 2"),
			assistantCall("c2", "read", { path: "/lib/b.ts" }),
			toolResult("c2", "read", BIG),
		];
		const reachability = computeReachability(messages, 2, "/");
		expect(reachability.get(1)).toBe("unrelated");
		expect(reachability.get(5)).toBe("active");
	});

	it("uses explicit recent user path mentions as focus targets", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "read", { path: "packages/coding-agent/src/core/context-aging.ts" }),
			toolResult("c1", "read", BIG),
			userMessage("unrelated turn"),
			userMessage("继续看 packages/coding-agent/src/core/context-aging.ts 的上下文压缩"),
		];
		const reachability = computeReachability(messages, 2, "/repo");
		expect(reachability.get(1)).toBe("adjacent");
	});

	it("marks read_many as active when any file matches a recent target", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "read_many", { files: [{ path: "/a.ts" }, { path: "/b.ts" }] }),
			toolResult("c1", "read_many", BIG),
			userMessage("check it"),
			assistantCall("c2", "read", { path: "/b.ts" }),
			toolResult("c2", "read", BIG),
		];
		const reachability = computeReachability(messages, 2, "/");
		expect(reachability.get(1)).toBe("active");
	});

	it("marks edit target paths as active focus", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "read", { path: "/a.ts" }),
			toolResult("c1", "read", BIG),
			userMessage("fix it"),
			assistantCall("c2", "edit", { path: "/a.ts", old_string: "x", new_string: "y" }),
			toolResult("c2", "edit", BIG),
		];
		const reachability = computeReachability(messages, 2, "/");
		// Earlier read of /a.ts is active because recent edit targets /a.ts
		expect(reachability.get(1)).toBe("active");
	});

	it("ignores messages beyond lookbackUserTurns", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "read", { path: "/src/a.ts" }),
			toolResult("c1", "read", BIG),
			userMessage("turn 1"),
			userMessage("turn 2"),
			userMessage("turn 3"),
			assistantCall("c2", "read", { path: "/lib/b.ts" }),
			toolResult("c2", "read", BIG),
		];
		const reachability = computeReachability(messages, 2, "/");
		// c1 is beyond 2 user turns of the end → unrelated
		expect(reachability.get(1)).toBe("unrelated");
		// c2 is within the last 2 user turns → active
		expect(reachability.get(6)).toBe("active");
	});
});

describe("ageToolResults with reachability", () => {
	it("does not age active results even when old and context is heavy", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "read", { path: "/src/a.ts" }),
			toolResult("c1", "read", FIFTY_LINES),
			userMessage("check it"),
			userMessage("turn 2"),
			// 5 user turns → old enough for heavy aging (minAge=3)
			...Array.from({ length: 5 }, (_, i) => userMessage(`turn ${i}`)),
			assistantCall("c2", "read", { path: "/src/a.ts" }),
			toolResult("c2", "read", FIFTY_LINES),
		];
		const reachability = computeReachability(messages, 2, "/");
		const result = ageToolResults(messages, 0.9, reachability);
		// c2 is active → kept full
		expect(resultText(result[10])).toBe(FIFTY_LINES);
	});

	it("protects adjacent results below heavy aging", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "ls", { path: "/src" }),
			toolResult("c1", "ls", FIFTY_LINES),
			// 5 user turns
			...Array.from({ length: 5 }, (_, i) => userMessage(`turn ${i}`)),
			assistantCall("c2", "read", { path: "/src/core/a.ts" }),
			toolResult("c2", "read", FIFTY_LINES),
		];
		const reachability = computeReachability(messages, 2, "/");
		const result = ageToolResults(messages, 0.75, reachability, 0.8);
		// ls on /src is adjacent to read on /src/core/a.ts → kept full (not heavy)
		expect(resultText(result[1])).toBe(FIFTY_LINES);
	});

	it("ages adjacent results under heavy pressure", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "ls", { path: "/src" }),
			toolResult("c1", "ls", FIFTY_LINES),
			// 5 user turns
			...Array.from({ length: 5 }, (_, i) => userMessage(`turn ${i}`)),
			assistantCall("c2", "read", { path: "/src/core/a.ts" }),
			toolResult("c2", "read", FIFTY_LINES),
		];
		const reachability = computeReachability(messages, 2, "/");
		const result = ageToolResults(messages, 0.9, reachability); // heavy aging
		// Under heavy pressure even adjacent results are trimmed to free space.
		expect(resultText(result[1])).toContain("entries total");
	});

	it("replaces unrelated results with natural language placeholder under heavy aging", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "read", { path: "/src/a.ts" }),
			toolResult("c1", "read", FIFTY_LINES),
			// 5 user turns
			...Array.from({ length: 5 }, (_, i) => userMessage(`turn ${i}`)),
			assistantCall("c2", "read", { path: "/lib/b.ts" }),
			toolResult("c2", "read", FIFTY_LINES),
		];
		const reachability = computeReachability(messages, 2, "/");
		const result = ageToolResults(messages, 0.9, reachability);
		// First read is unrelated (different path) → replaced by placeholder
		expect(resultText(result[1])).toContain("Earlier read of");
		expect(resultText(result[1])).toContain("omitted to save context");
		// Second read is active → kept full
		expect(resultText(result[8])).toBe(FIFTY_LINES);
	});

	it("does not replace unrelated results below MIN_AGING_CHARS", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "read", { path: "/src/a.ts" }),
			toolResult("c1", "read", "tiny result"),
			...Array.from({ length: 5 }, (_, i) => userMessage(`turn ${i}`)),
			assistantCall("c2", "read", { path: "/lib/b.ts" }),
			toolResult("c2", "read", "tiny result"),
		];
		const reachability = computeReachability(messages, 2, "/");
		const result = ageToolResults(messages, 0.9, reachability);
		expect(resultText(result[1])).toBe("tiny result");
	});
});
