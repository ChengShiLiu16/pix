import type { Message } from "@earendil-works/pix-ai";
import { describe, expect, it } from "vitest";
import { safeJsonStringifyForTokens, serializeConversation } from "../../src/harness/compaction/compaction.ts";

describe("compaction serialization", () => {
	it("serializes circular tool-call arguments for token estimates", () => {
		const args: Record<string, unknown> = { path: "src/index.ts" };
		args.self = args;

		const serialized = safeJsonStringifyForTokens(args);

		expect(serialized).toContain('"path":"src/index.ts"');
		expect(serialized).toContain("[Circular Object]");
		expect(serialized).toContain("truncated");
	});

	it("serializes assistant tool calls with circular arguments", () => {
		const circular: Record<string, unknown> = { path: "src/index.ts" };
		circular.self = circular;
		const messages: Message[] = [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call-1", name: "read", arguments: circular }],
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
				timestamp: Date.now(),
			},
		];

		expect(serializeConversation(messages)).toContain(
			'read(path="src/index.ts", self={"path":"src/index.ts","self":[Circular Object]}',
		);
	});
});
