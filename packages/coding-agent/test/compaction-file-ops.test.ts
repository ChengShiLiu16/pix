import type { AgentMessage } from "@chengshiliu16/pix-agent-core";
import type { AssistantMessage } from "@chengshiliu16/pix-ai";
import { describe, expect, it } from "vitest";
import { computeFileLists, createFileOps, extractFileOpsFromMessage } from "../src/core/compaction/utils.ts";

function assistantCall(name: string, args: Record<string, unknown>): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: `${name}-1`, name, arguments: args }],
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

describe("compaction file operation tracking", () => {
	it("tracks aliases and batch reads for summary anchors", () => {
		const fileOps = createFileOps();
		extractFileOpsFromMessage(assistantCall("read", { file_path: "src/read.ts" }), fileOps);
		extractFileOpsFromMessage(
			assistantCall("read_many", { files: [{ path: "src/a.ts" }], paths: ["src/b.ts"] }),
			fileOps,
		);
		extractFileOpsFromMessage(assistantCall("edit", { filePath: "src/edit.ts" }), fileOps);
		extractFileOpsFromMessage(assistantCall("write", { path: "src/write.ts" }), fileOps);

		expect(computeFileLists(fileOps)).toEqual({
			readFiles: ["src/a.ts", "src/b.ts", "src/read.ts"],
			modifiedFiles: ["src/edit.ts", "src/write.ts"],
		});
	});
});
