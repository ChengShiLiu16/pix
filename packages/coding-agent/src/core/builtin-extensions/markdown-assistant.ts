/**
 * Assistant markdown rendering: stream plain text, beautify when complete.
 * pi-thinking-steps owns the primary patch when active; this extension installs
 * a fallback patch only when thinking-steps has not taken over.
 */
import type { ExtensionAPI } from "../../index.ts";
import { installMarkdownAssistantPatch, restoreMarkdownAssistantPatch } from "./lib/markdown-assistant-patch.ts";
import {
	clearAssistantMarkdownStreamingState,
	markAssistantMessageFinalized,
	markAssistantMessageStreaming,
	resetAssistantMarkdownStreamingState,
} from "./lib/markdown-render.ts";

export function builtin(pi: ExtensionAPI) {
	pi.on("session_start", async () => {
		resetAssistantMarkdownStreamingState();
		try {
			await installMarkdownAssistantPatch();
		} catch (err) {
			console.error(
				"[markdown-assistant] installMarkdownAssistantPatch failed:",
				err instanceof Error ? err.message : err,
			);
		}
	});

	pi.on("session_shutdown", async () => {
		resetAssistantMarkdownStreamingState();
		restoreMarkdownAssistantPatch();
	});

	pi.on("message_start", async (event) => {
		if (event.message.role === "assistant") {
			markAssistantMessageStreaming(event.message);
		}
	});

	pi.on("message_update", async (event) => {
		if (event.message.role === "assistant") {
			markAssistantMessageStreaming(event.message);
		}
	});

	pi.on("message_end", async (event) => {
		if (event.message.role === "assistant") {
			markAssistantMessageFinalized(event.message);
		}
	});

	pi.on("agent_end", async () => {
		clearAssistantMarkdownStreamingState();
	});
}
