/**
 * Rebuild bash/read batch groups from persisted session messages on load/reload.
 * Live tool_call events do not replay for historical rows; without this, batch slots stay
 * empty while renderCall returns EMPTY and the visibility patch hides forever.
 */
import { isBashFileMutationCommand, recordBashToolCall } from "./bash-batch-display.ts";
import { resetAllBatchState } from "./batch-global-store.ts";
import { recordReadToolCall } from "./read-batch-display.ts";
import {
	beginAssistantMessage,
	recordContentBreak,
	recordOtherTool,
	recordTextStreamingDelta,
	recordTextStreamingEnd,
	recordTextStreamingStart,
	recordToolCallOrder,
} from "./tool-batch-sequence.ts";

type ToolCallBlock = {
	type: "toolCall";
	id: string;
	name: string;
	arguments?: Record<string, unknown>;
};

type AssistantBlock =
	| { type: "thinking"; thinking?: string }
	| { type: "text"; text?: string }
	| ToolCallBlock
	| { type: string };

type SessionMessage = {
	role: string;
	content?: AssistantBlock[];
};

function replayToolCallBlock(block: ToolCallBlock): void {
	recordToolCallOrder(block.id);
	const input = block.arguments ?? {};
	if (block.name === "read") {
		recordReadToolCall(block.id, "read", input);
		return;
	}
	if (block.name === "read_many") {
		recordReadToolCall(block.id, "read_many", input);
		return;
	}
	if (block.name === "bash") {
		const command = typeof input.command === "string" ? input.command : "";
		if (isBashFileMutationCommand(command)) {
			recordOtherTool();
			return;
		}
		recordBashToolCall(block.id, command);
		return;
	}
	recordOtherTool();
}

function replayAssistantMessage(message: SessionMessage): void {
	beginAssistantMessage();
	for (const block of message.content ?? []) {
		if (block.type === "thinking") {
			const thinkingBlock = block as { type: "thinking"; thinking?: string };
			const thinkingText = typeof thinkingBlock.thinking === "string" ? thinkingBlock.thinking : "";
			if (thinkingText.trim()) {
				recordContentBreak();
			}
			continue;
		}
		if (block.type === "text") {
			const textBlock = block as { type: "text"; text?: string };
			const text = typeof textBlock.text === "string" ? textBlock.text : "";
			recordTextStreamingStart();
			if (text) recordTextStreamingDelta(text);
			recordTextStreamingEnd(text);
			continue;
		}
		if (block.type === "toolCall") {
			replayToolCallBlock(block as ToolCallBlock);
		}
	}
}

/** Walk aligned session messages and populate batch stores (call after resetAllBatchState). */
export function replayBatchStateFromSessionMessages(messages: readonly SessionMessage[]): void {
	for (const message of messages) {
		if (message.role === "user") {
			resetAllBatchState();
			continue;
		}
		if (message.role === "assistant") {
			replayAssistantMessage(message);
		}
	}
}
