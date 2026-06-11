/**
 * Read / bash batch tracking for aggregated same-turn display.
 *
 * Records tool calls within one user turn (until the next user message) so
 * compact-tools can render combined headers (Read (N), Bash (N)).
 *
 * Same-type tool calls merge only when back-to-back with no intervening content.
 * A batch group is broken when visible assistant text or thinking appears after tool
 * activity within the same assistant message, a different tool type runs (tool_call only),
 * or the batch is reset. Pre-tool text in a new assistant message does not break prior batches.
 */
import type { ExtensionAPI } from "../../index.ts";
import { isToolCallEventType } from "../../index.ts";
import { isBashFileMutationCommand, recordBashToolCall } from "./lib/bash-batch-display.ts";
import { isBatchDebugEnabled, setBatchDebugEnabled } from "./lib/batch-debug.ts";
import { resetAllBatchState, snapshotBatchDebugState } from "./lib/batch-global-store.ts";
import { setDisplayCwd } from "./lib/format-tree-call.ts";
import { recordReadToolCall, setReadBatchCwd } from "./lib/read-batch-display.ts";
import { replayBatchStateFromSessionMessages } from "./lib/session-batch-replay.ts";
import {
	beginAssistantMessage,
	recordContentBreak,
	recordOtherTool,
	recordTextStreamingDelta,
	recordTextStreamingEnd,
	recordTextStreamingStart,
	recordToolCallOrder,
} from "./lib/tool-batch-sequence.ts";
import { getPatchedToolExecutionClass, isToolVisibilityPatchInstalled } from "./lib/tool-visibility-patch.ts";

export function builtin(pi: ExtensionAPI) {
	/** True while pix replays persisted messages after session_start (avoid wiping batch replay). */
	let hydratingSession = false;

	pi.registerCommand("batch-debug", {
		description: "Print batch state; use `/batch-debug on|off` to toggle visibility logging",
		handler: async (args, ctx) => {
			const trimmed = args.trim().toLowerCase();
			if (trimmed === "on" || trimmed === "off") {
				setBatchDebugEnabled(trimmed === "on");
				const msg = `Batch debug logging ${trimmed === "on" ? "enabled" : "disabled"}`;
				if (ctx.hasUI) ctx.ui.notify(msg, "info");
				else console.info(msg);
				return;
			}

			const snapshot = snapshotBatchDebugState();
			const lines = [
				`Batch debug logging: ${isBatchDebugEnabled() ? "on" : "off"} (PIX_BATCH_DEBUG=1 also enables)`,
				`Tool visibility patch: ${isToolVisibilityPatchInstalled() ? "installed" : "NOT installed"}`,
				`Patch target: ${getPatchedToolExecutionClass() ? "ToolExecutionComponent export" : "none"}`,
				"Batch debug snapshot:",
				JSON.stringify(snapshot, null, 2),
			];
			const text = lines.join("\n");
			if (ctx.hasUI) {
				ctx.ui.notify(text, "info");
			} else {
				console.info(text);
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		setDisplayCwd(ctx.cwd);
		setReadBatchCwd(ctx.cwd);
		hydratingSession = true;
		const context = (ctx.sessionManager as any).buildSessionContext();
		const messages = context.messages as Parameters<typeof replayBatchStateFromSessionMessages>[0];
		const applyReplay = (): void => {
			resetAllBatchState();
			setDisplayCwd(ctx.cwd);
			setReadBatchCwd(ctx.cwd);
			replayBatchStateFromSessionMessages(messages);
		};
		applyReplay();
		// Pix may emit message_start(user) while rebuilding chat — re-apply after that pass.
		queueMicrotask(() => {
			applyReplay();
			hydratingSession = false;
		});
	});

	pi.on("turn_start", async () => {
		hydratingSession = false;
	});

	pi.on("message_start", async (event) => {
		if (event.message.role === "user") {
			if (hydratingSession) return;
			resetAllBatchState();
			return;
		}
		if (event.message.role === "assistant") {
			beginAssistantMessage();
		}
	});

	pi.on("message_update", async (event) => {
		if (event.message.role !== "assistant") return;
		const assistantEvent = event.assistantMessageEvent;
		switch (assistantEvent.type) {
			case "thinking_delta":
				// Only visible thinking after tools breaks batches; empty encrypted placeholders must not.
				if (
					"delta" in assistantEvent &&
					typeof assistantEvent.delta === "string" &&
					/\S/.test(assistantEvent.delta)
				) {
					recordContentBreak();
				}
				break;
			case "thinking_end":
				if (
					"content" in assistantEvent &&
					typeof assistantEvent.content === "string" &&
					/\S/.test(assistantEvent.content)
				) {
					recordContentBreak();
				}
				break;
			case "text_start":
				recordTextStreamingStart();
				break;
			case "text_delta":
				if ("delta" in assistantEvent && typeof assistantEvent.delta === "string") {
					recordTextStreamingDelta(assistantEvent.delta);
				}
				break;
			case "text_end":
				if ("content" in assistantEvent && typeof assistantEvent.content === "string") {
					recordTextStreamingEnd(assistantEvent.content);
				}
				break;
		}
	});

	pi.on("tool_call", async (event) => {
		recordToolCallOrder(event.toolCallId);
		if (isToolCallEventType("read", event)) {
			recordReadToolCall(event.toolCallId, "read", event.input);
			return;
		}
		if (event.toolName === "read_many") {
			recordReadToolCall(event.toolCallId, "read_many", event.input);
			return;
		}
		if (isToolCallEventType("bash", event)) {
			const command = typeof event.input.command === "string" ? event.input.command : "";
			if (isBashFileMutationCommand(command)) {
				recordOtherTool();
				return;
			}
			recordBashToolCall(event.toolCallId, command);
			return;
		}
		recordOtherTool();
	});
}
