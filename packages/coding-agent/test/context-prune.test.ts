import type { AgentMessage } from "@earendil-works/pix-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pix-ai";
import { describe, expect, it } from "vitest";
import { pruneStaleReads } from "../src/core/context-prune.ts";

const BIG = "x".repeat(1000);

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

function readResult(id: string, text = BIG, isError = false): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "read",
		content: [{ type: "text", text }],
		isError,
		timestamp: 0,
	};
}

function mutationResult(id: string, toolName: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName,
		content: [{ type: "text", text: "ok" }],
		isError: false,
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

describe("pruneStaleReads", () => {
	it("stubs an earlier read superseded by a later read of the same window", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "read", { path: "/a.ts" }),
			readResult("c1"),
			assistantCall("c2", "read", { path: "/a.ts" }),
			readResult("c2"),
		];
		const result = pruneStaleReads(messages);
		expect(resultText(result[1])).toContain("Stale read omitted");
		expect(resultText(result[3])).toBe(BIG);
	});

	it("stubs a read superseded by a later edit/write of the same path", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "read", { path: "/a.ts" }),
			readResult("c1"),
			assistantCall("c2", "edit", { path: "/a.ts" }),
			mutationResult("c2", "edit"),
		];
		const result = pruneStaleReads(messages);
		expect(resultText(result[1])).toContain("Stale read omitted");
	});

	it("keeps reads of different files", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "read", { path: "/a.ts" }),
			readResult("c1"),
			assistantCall("c2", "read", { path: "/b.ts" }),
			readResult("c2"),
		];
		expect(pruneStaleReads(messages)).toBe(messages);
	});

	it("keeps reads with different offset/limit windows", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "read", { path: "/a.ts", offset: 1, limit: 100 }),
			readResult("c1"),
			assistantCall("c2", "read", { path: "/a.ts", offset: 200, limit: 100 }),
			readResult("c2"),
		];
		expect(pruneStaleReads(messages)).toBe(messages);
	});

	it("does not stub small reads below the threshold", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "read", { path: "/a.ts" }),
			readResult("c1", "tiny"),
			assistantCall("c2", "read", { path: "/a.ts" }),
			readResult("c2", "tiny"),
		];
		expect(pruneStaleReads(messages)).toBe(messages);
	});

	it("does not stub error reads", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "read", { path: "/a.ts" }),
			readResult("c1", BIG, true),
			assistantCall("c2", "read", { path: "/a.ts" }),
			readResult("c2"),
		];
		const result = pruneStaleReads(messages);
		expect(resultText(result[1])).toBe(BIG);
	});

	it("returns the original array when nothing is stale", () => {
		const messages: AgentMessage[] = [assistantCall("c1", "read", { path: "/a.ts" }), readResult("c1")];
		expect(pruneStaleReads(messages)).toBe(messages);
	});

	it("recognizes the filePath alias when matching a later edit", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "read", { path: "/a.ts" }),
			readResult("c1"),
			assistantCall("c2", "edit", { filePath: "/a.ts" }),
			mutationResult("c2", "edit"),
		];
		const result = pruneStaleReads(messages);
		expect(resultText(result[1])).toContain("Stale read omitted");
	});

	it("does not treat a failed edit as superseding an earlier read", () => {
		const failedEdit: ToolResultMessage = { ...mutationResult("c2", "edit"), isError: true };
		const messages: AgentMessage[] = [
			assistantCall("c1", "read", { path: "/a.ts" }),
			readResult("c1"),
			assistantCall("c2", "edit", { path: "/a.ts" }),
			failedEdit,
		];
		expect(pruneStaleReads(messages)).toBe(messages);
	});

	it("does not treat a failed duplicate read as superseding an earlier read", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "read", { path: "/a.ts" }),
			readResult("c1"),
			assistantCall("c2", "read", { path: "/a.ts" }),
			readResult("c2", BIG, true),
		];
		const result = pruneStaleReads(messages);
		expect(resultText(result[1])).toBe(BIG);
	});
});
