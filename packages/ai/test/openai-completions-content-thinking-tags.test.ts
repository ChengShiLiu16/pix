import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { streamOpenAICompletions } from "../src/providers/openai-completions.ts";
import type { AssistantMessage, AssistantMessageEvent, Context, Model, OpenAICompletionsCompat } from "../src/types.ts";

type StreamDelta = Record<string, unknown>;

function buildModel(
	baseUrl: string,
	contentThinkingTags: NonNullable<OpenAICompletionsCompat["contentThinkingTags"]>,
): Model<"openai-completions"> {
	return {
		id: "repro-model",
		name: "Repro Model",
		api: "openai-completions",
		provider: "repro-provider",
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
		compat: { contentThinkingTags },
	};
}

function buildContext(): Context {
	return {
		messages: [{ role: "user", content: "hello", timestamp: 1 }],
	};
}

async function collectEvents(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	return events;
}

function getDoneMessage(events: AssistantMessageEvent[]): AssistantMessage {
	const done = events.find(
		(event): event is Extract<AssistantMessageEvent, { type: "done" }> => event.type === "done",
	);
	if (!done) {
		throw new Error("Expected stream to finish with a done event");
	}
	return done.message;
}

async function streamFromDeltas(
	deltas: StreamDelta[],
	contentThinkingTags: NonNullable<OpenAICompletionsCompat["contentThinkingTags"]>,
): Promise<AssistantMessage> {
	const server = http.createServer((_req, res) => {
		res.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		for (const delta of deltas) {
			res.write(
				`data: ${JSON.stringify({
					id: "chatcmpl-repro",
					object: "chat.completion.chunk",
					created: 0,
					model: "repro-model",
					choices: [{ index: 0, delta, finish_reason: null }],
				})}\n\n`,
			);
		}
		res.write(
			`data: ${JSON.stringify({
				id: "chatcmpl-repro",
				object: "chat.completion.chunk",
				created: 0,
				model: "repro-model",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: { prompt_tokens: 1, completion_tokens: 1 },
			})}\n\n`,
		);
		res.write("data: [DONE]\n\n");
		res.end();
	});

	server.listen(0, "127.0.0.1");
	await once(server, "listening");

	try {
		const { port } = server.address() as AddressInfo;
		const events = await collectEvents(
			streamOpenAICompletions(buildModel(`http://127.0.0.1:${port}`, contentThinkingTags), buildContext(), {
				apiKey: "test-key",
			}),
		);
		return getDoneMessage(events);
	} finally {
		server.close();
		await once(server, "close");
	}
}

describe("openai-completions content thinking tags", () => {
	it("keeps literal tags as text when the compat flag is disabled", async () => {
		const message = await streamFromDeltas([{ content: "before <thinking>visible</thinking> after" }], "none");

		expect(message.content).toEqual([{ type: "text", text: "before <thinking>visible</thinking> after" }]);
	});

	it("moves tagged content into a thinking block when the compat flag is enabled", async () => {
		const message = await streamFromDeltas([{ content: "before <thinking>hidden</thinking> after" }], "xml");

		expect(message.content).toEqual([
			{ type: "text", text: "before " },
			{ type: "thinking", thinking: "hidden", thinkingSignature: "content_thinking_tags" },
			{ type: "text", text: " after" },
		]);
	});

	it("parses tags split across stream chunks", async () => {
		const message = await streamFromDeltas(
			[{ content: "before <thi" }, { content: "nking>hidden</thi" }, { content: "nking> after" }],
			"xml",
		);

		expect(message.content).toEqual([
			{ type: "text", text: "before " },
			{ type: "thinking", thinking: "hidden", thinkingSignature: "content_thinking_tags" },
			{ type: "text", text: " after" },
		]);
	});

	it("treats an unclosed tag as thinking until the stream ends", async () => {
		const message = await streamFromDeltas([{ content: "before <thinking>unfinished" }], "xml");

		expect(message.content).toEqual([
			{ type: "text", text: "before " },
			{ type: "thinking", thinking: "unfinished", thinkingSignature: "content_thinking_tags" },
		]);
	});

	it("keeps content-tag thinking separate from structured reasoning fields", async () => {
		const message = await streamFromDeltas(
			[{ content: "<thinking>tag reasoning</thinking>", reasoning_content: "structured reasoning" }],
			"xml",
		);

		expect(message.content).toEqual([
			{ type: "thinking", thinking: "tag reasoning", thinkingSignature: "content_thinking_tags" },
			{ type: "thinking", thinking: "structured reasoning", thinkingSignature: "reasoning_content" },
		]);
	});
});
