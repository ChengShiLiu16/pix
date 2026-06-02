import type { AgentMessage } from "@earendil-works/pix-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pix-ai";
import { describe, expect, it } from "vitest";
import { ageToolResults, compactEditArguments } from "../src/core/context-aging.ts";

const BIG = "x".repeat(1000);

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

function toolResult(id: string, toolName: string, text = BIG, isError = false): ToolResultMessage {
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

/** Build a conversation with N user turns after the tool result. */
function buildConversation(toolName: string, resultText: string, userTurnsAfter: number): AgentMessage[] {
	const messages: AgentMessage[] = [
		assistantCall("c1", toolName, toolName === "bash" ? { command: "cat /a.ts" } : { path: "/a.ts" }),
		toolResult("c1", toolName, resultText),
	];
	for (let i = 0; i < userTurnsAfter; i++) {
		messages.push(userMessage(`turn ${i}`));
	}
	return messages;
}

// 50-line read result with enough chars per line to exceed MIN_AGING_CHARS (800)
const FIFTY_LINES = Array.from({ length: 50 }, (_, i) => `line ${i + 1}: ${"x".repeat(30)}`).join("\n");

describe("ageToolResults", () => {
	// --- threshold gating ---

	it("does not age when context ratio is below 50%", () => {
		const messages = buildConversation("read", BIG, 20);
		expect(ageToolResults(messages, 0.4)).toBe(messages);
	});

	it("starts aging at 50% context ratio", () => {
		const messages = buildConversation("read", FIFTY_LINES, 20);
		const result = ageToolResults(messages, 0.5);
		expect(resultText(result[1])).toContain("lines not shown");
	});

	it("returns original array when nothing needs aging", () => {
		const messages = buildConversation("read", BIG, 0);
		expect(ageToolResults(messages, 0.8)).toBe(messages);
	});

	// --- age gating ---

	it("does not age a result that is too recent (age < minAge)", () => {
		// Light aging requires age >= 10; only 5 user turns after
		const messages = buildConversation("read", FIFTY_LINES, 5);
		const result = ageToolResults(messages, 0.6); // light aging
		expect(resultText(result[1])).toBe(FIFTY_LINES);
	});

	it("ages a result that is old enough", () => {
		// Light aging requires age >= 10; 12 user turns after
		const messages = buildConversation("read", FIFTY_LINES, 12);
		const result = ageToolResults(messages, 0.6); // light aging
		expect(resultText(result[1])).toContain("lines not shown");
	});

	// --- size gating ---

	it("does not age a small result below the threshold", () => {
		const messages = buildConversation("read", "tiny result", 12);
		const result = ageToolResults(messages, 0.6);
		expect(resultText(result[1])).toBe("tiny result");
	});

	// --- error and mutation results ---

	it("does not age error results", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "read", { path: "/a.ts" }),
			toolResult("c1", "read", BIG, true),
			...Array.from({ length: 12 }, (_, i) => userMessage(`turn ${i}`)),
		];
		const result = ageToolResults(messages, 0.8);
		expect(resultText(result[1])).toBe(BIG);
	});

	it("does not age edit results", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "edit", { path: "/a.ts" }),
			toolResult("c1", "edit", BIG),
			...Array.from({ length: 12 }, (_, i) => userMessage(`turn ${i}`)),
		];
		const result = ageToolResults(messages, 0.8);
		expect(resultText(result[1])).toBe(BIG);
	});

	it("does not age write results", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "write", { path: "/a.ts" }),
			toolResult("c1", "write", BIG),
			...Array.from({ length: 12 }, (_, i) => userMessage(`turn ${i}`)),
		];
		const result = ageToolResults(messages, 0.8);
		expect(resultText(result[1])).toBe(BIG);
	});

	// --- read aging levels ---

	it("light aging: keeps head 20 + tail 5 lines for read", () => {
		const messages = buildConversation("read", FIFTY_LINES, 12);
		const result = ageToolResults(messages, 0.6); // light
		const text = resultText(result[1]);
		expect(text).toContain("line 1:");
		expect(text).toContain("line 20:");
		expect(text).toContain("line 50:");
		expect(text).toContain("lines not shown");
		expect(text).not.toContain("line 21:");
	});

	it("medium aging: keeps head 5 lines for read", () => {
		const messages = buildConversation("read", FIFTY_LINES, 8);
		const result = ageToolResults(messages, 0.75); // medium
		const text = resultText(result[1]);
		expect(text).toContain("line 1:");
		expect(text).toContain("line 5:");
		expect(text).toContain("lines not shown");
		expect(text).not.toContain("line 6:");
	});

	it("heavy aging: replaces read with single-line placeholder", () => {
		const messages = buildConversation("read", FIFTY_LINES, 5);
		const result = ageToolResults(messages, 0.9); // heavy
		const text = resultText(result[1]);
		expect(text).toContain("Read result omitted to save context");
		expect(text).toContain("/a.ts");
		expect(text).toContain("50 lines total");
		expect(text).not.toContain("line 1:");
	});

	// --- bash aging ---

	it("light aging: keeps tail 10 lines for bash", () => {
		const messages = buildConversation("bash", FIFTY_LINES, 12);
		const result = ageToolResults(messages, 0.6); // light
		const text = resultText(result[1]);
		expect(text).toContain("line 50:");
		expect(text).toContain("earlier lines not shown");
	});

	it("heavy aging: replaces bash with single-line placeholder", () => {
		const messages = buildConversation("bash", FIFTY_LINES, 5);
		const result = ageToolResults(messages, 0.9); // heavy
		const text = resultText(result[1]);
		expect(text).toContain("Bash output omitted to save context");
		expect(text).toContain("/a.ts");
		expect(text).toContain("50 lines total");
	});

	// --- grep aging ---

	it("light aging: keeps first 20 matches for grep", () => {
		const grepOutput = Array.from({ length: 50 }, (_, i) => `/a.ts:${i + 1}: match text here`).join("\n");
		const messages = buildConversation("grep", grepOutput, 12);
		const result = ageToolResults(messages, 0.6); // light
		const text = resultText(result[1]);
		expect(text).toContain("/a.ts:1:");
		expect(text).toContain("/a.ts:20:");
		expect(text).toContain("more matches not shown");
		expect(text).not.toContain("/a.ts:21:");
	});

	it("heavy aging: replaces grep with single-line placeholder", () => {
		const grepOutput = Array.from({ length: 50 }, (_, i) => `/a.ts:${i + 1}: match text here`).join("\n");
		const messages = buildConversation("grep", grepOutput, 5);
		const result = ageToolResults(messages, 0.9); // heavy
		const text = resultText(result[1]);
		expect(text).toContain("Grep result omitted to save context");
		expect(text).toContain("matches total");
	});

	// --- ls/find aging ---

	it("light aging: keeps first 30 entries for ls", () => {
		const lsOutput = Array.from({ length: 50 }, (_, i) => `/src/subdirectory/deeply/nested/file${i}.ts`).join("\n");
		const messages = buildConversation("ls", lsOutput, 12);
		const result = ageToolResults(messages, 0.6); // light
		const text = resultText(result[1]);
		expect(text).toContain("file0.ts");
		expect(text).toContain("more entries not shown");
	});

	it("heavy aging: replaces ls with single-line placeholder", () => {
		const lsOutput = Array.from({ length: 50 }, (_, i) => `/src/subdirectory/deeply/nested/file${i}.ts`).join("\n");
		const messages = buildConversation("ls", lsOutput, 5);
		const result = ageToolResults(messages, 0.9); // heavy
		const text = resultText(result[1]);
		expect(text).toContain("Ls result omitted to save context");
		expect(text).toContain("/a.ts");
		expect(text).toContain("entries total");
	});

	it("heavy aging: replaces find with single-line placeholder", () => {
		const findOutput = Array.from({ length: 50 }, (_, i) => `/src/subdirectory/deeply/nested/file${i}.ts`).join("\n");
		const messages = buildConversation("find", findOutput, 5);
		const result = ageToolResults(messages, 0.9); // heavy
		const text = resultText(result[1]);
		expect(text).toContain("Find result omitted to save context");
	});

	// --- batch tool aging ---

	it("heavy aging: replaces read_many with single-line placeholder", () => {
		const readOutput = Array.from({ length: 50 }, (_, i) => `line ${i + 1}: ${"x".repeat(30)}`).join("\n");
		const messages = buildConversation("read_many", readOutput, 5);
		const result = ageToolResults(messages, 0.9); // heavy
		const text = resultText(result[1]);
		expect(text).toContain("Read result omitted to save context");
		expect(text).toContain("/a.ts");
	});

	it("heavy aging: replaces grep_many with single-line placeholder", () => {
		const grepOutput = Array.from({ length: 50 }, (_, i) => `/a.ts:${i + 1}: match text here`).join("\n");
		const messages = buildConversation("grep_many", grepOutput, 5);
		const result = ageToolResults(messages, 0.9); // heavy
		const text = resultText(result[1]);
		expect(text).toContain("Grep result omitted to save context");
		expect(text).toContain("matches total");
	});

	it("heavy aging: replaces ls_many with single-line placeholder", () => {
		const lsOutput = Array.from({ length: 50 }, (_, i) => `/src/subdirectory/deeply/nested/file${i}.ts`).join("\n");
		const messages = buildConversation("ls_many", lsOutput, 5);
		const result = ageToolResults(messages, 0.9); // heavy
		const text = resultText(result[1]);
		expect(text).toContain("Ls result omitted to save context");
		expect(text).toContain("entries total");
	});

	// --- short results not aged ---

	it("does not age a read result that fits within head+tail budget", () => {
		// 15 lines, each long enough to exceed MIN_AGING_CHARS
		const shortRead = Array.from({ length: 15 }, (_, i) => `line ${i + 1}: ${"x".repeat(30)}`).join("\n");
		const messages = buildConversation("read", shortRead, 12);
		const result = ageToolResults(messages, 0.6); // light, head=20, tail=5
		// 15 lines < 20+5 = 25, no truncation needed
		expect(resultText(result[1])).toBe(shortRead);
	});

	// --- multiple results at different ages ---

	it("ages old results but keeps recent ones", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "read", { path: "/old.ts" }),
			toolResult("c1", "read", FIFTY_LINES),
			// 12 user turns → old enough for light aging
			...Array.from({ length: 12 }, (_, i) => userMessage(`old turn ${i}`)),
			assistantCall("c2", "read", { path: "/new.ts" }),
			toolResult("c2", "read", FIFTY_LINES),
			// 2 user turns → too recent
			...Array.from({ length: 2 }, (_, i) => userMessage(`new turn ${i}`)),
		];
		const result = ageToolResults(messages, 0.6); // light aging, minAge=10
		// Old result (index 1, age=14) should be aged
		expect(resultText(result[1])).toContain("lines not shown");
		// New result (index 15, age=2) should be untouched
		expect(resultText(result[15])).toBe(FIFTY_LINES);
	});
});

// ============================================================================
// compactEditArguments
// ============================================================================

describe("compactEditArguments", () => {
	it("does not compact when context ratio is below 70%", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "edit", { path: "/a.ts", old_string: "x".repeat(500), new_string: "y" }),
		];
		expect(compactEditArguments(messages, 0.6)).toBe(messages);
	});

	it("compacts edit old_string when context ratio >= 70%", () => {
		const oldString = "x".repeat(500);
		const messages: AgentMessage[] = [
			assistantCall("c1", "edit", { path: "/a.ts", old_string: oldString, new_string: "y" }),
		];
		const result = compactEditArguments(messages, 0.75);
		expect(result).not.toBe(messages);
		const assistant = result[0] as AssistantMessage;
		const block = assistant.content[0] as { type: string; name: string; arguments: Record<string, unknown> };
		const compacted = block.arguments.old_string as string;
		expect(compacted).toContain("total)");
		expect(compacted.length).toBeLessThan(oldString.length);
		// Should preserve head and tail of old_string
		expect(compacted).toContain("chars not shown");
		expect(compacted.startsWith(oldString.slice(0, 50))).toBe(true);
		expect(compacted.endsWith(oldString.slice(-50))).toBe(true);
		// new_string should be preserved
		expect(block.arguments.new_string).toBe("y");
	});

	it("does not compact short old_string (< 200 chars)", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "edit", { path: "/a.ts", old_string: "short", new_string: "y" }),
		];
		expect(compactEditArguments(messages, 0.8)).toBe(messages);
	});

	it("does not compact non-edit tool calls", () => {
		const messages: AgentMessage[] = [assistantCall("c1", "read", { path: "/a.ts" })];
		expect(compactEditArguments(messages, 0.8)).toBe(messages);
	});

	it("preserves other arguments in edit calls", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "edit", {
				path: "/a.ts",
				old_string: "x".repeat(500),
				new_string: "y",
				replace_all: true,
			}),
		];
		const result = compactEditArguments(messages, 0.75);
		const assistant = result[0] as AssistantMessage;
		const block = assistant.content[0] as { type: string; name: string; arguments: Record<string, unknown> };
		expect(block.arguments.path).toBe("/a.ts");
		expect(block.arguments.new_string).toBe("y");
		expect(block.arguments.replace_all).toBe(true);
	});
});
