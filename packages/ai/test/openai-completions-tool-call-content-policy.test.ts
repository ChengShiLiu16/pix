import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { streamOpenAICompletions } from "../src/providers/openai-completions.ts";
import type { AssistantMessage, AssistantMessageEvent, Context, Model, OpenAICompletionsCompat } from "../src/types.ts";

type StreamDelta = Record<string, unknown>;

function buildModel(baseUrl: string, compat: OpenAICompletionsCompat = {}): Model<"openai-completions"> {
	return {
		id: "repro-model",
		name: "Repro Model",
		api: "openai-completions",
		provider: "repro-provider",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
		compat,
	};
}

function buildContext(): Context {
	return {
		messages: [{ role: "user", content: "hello", timestamp: 1 }],
		tools: [
			{
				name: "todo_manage",
				description: "Manage todos",
				parameters: Type.Object({
					action: Type.String(),
					text: Type.Optional(Type.String()),
				}),
			},
		],
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
	compat: OpenAICompletionsCompat,
	finishReason: "stop" | "tool_calls" = "stop",
): Promise<AssistantMessageEvent[]> {
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
				choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
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
		return await collectEvents(
			streamOpenAICompletions(buildModel(`http://127.0.0.1:${port}`, compat), buildContext(), {
				apiKey: "test-key",
			}),
		);
	} finally {
		server.close();
		await once(server, "close");
	}
}

describe("openai-completions tool call content policy", () => {
	it("preserves same-turn text by default", async () => {
		const events = await streamFromDeltas(
			[
				{ content: '{"action":"add","text":"leaked"}' },
				{
					tool_calls: [
						{
							index: 0,
							id: "call_1",
							type: "function",
							function: { name: "todo_manage", arguments: '{"action":"add","text":"leaked"}' },
						},
					],
				},
			],
			{},
			"tool_calls",
		);

		expect(getDoneMessage(events).content).toEqual([
			{ type: "text", text: '{"action":"add","text":"leaked"}' },
			{ type: "toolCall", id: "call_1", name: "todo_manage", arguments: { action: "add", text: "leaked" } },
		]);
	});

	it("drops all standard content when configured provider also returns tool calls", async () => {
		const events = await streamFromDeltas(
			[
				{ content: '{"action":"add","text":"leaked"}' },
				{
					tool_calls: [
						{
							index: 0,
							id: "call_1",
							type: "function",
							function: { name: "todo_manage", arguments: '{"action":"add","text":"leaked"}' },
						},
					],
				},
				{ content: " trailing draft" },
			],
			{ toolCallContentPolicy: "drop-when-tool-calls" },
			"tool_calls",
		);

		expect(events.some((event) => event.type === "text_start" || event.type === "text_delta")).toBe(false);
		expect(getDoneMessage(events).content).toEqual([
			{ type: "toolCall", id: "call_1", name: "todo_manage", arguments: { action: "add", text: "leaked" } },
		]);
	});

	it("preserves content under drop policy when no tool calls are returned", async () => {
		const events = await streamFromDeltas([{ content: "visible " }, { content: "answer" }], {
			toolCallContentPolicy: "drop-when-tool-calls",
		});

		expect(getDoneMessage(events).content).toEqual([{ type: "text", text: "visible answer" }]);
	});

	it("drops everything including XML thinking block when tool calls are returned", async () => {
		const events = await streamFromDeltas(
			[
				{ content: "<thinking>Let's plan</thinking>" },
				{ content: '{"action":"add","text":"leaked"}' },
				{
					tool_calls: [
						{
							index: 0,
							id: "call_1",
							type: "function",
							function: { name: "todo_manage", arguments: '{"action":"add","text":"leaked"}' },
						},
					],
				},
			],
			{
				contentThinkingTags: "xml",
				toolCallContentPolicy: "drop-when-tool-calls",
			},
			"tool_calls",
		);

		// Everything from content channel is dropped, including thinking tags, when tool calls arrive
		expect(
			events.some(
				(event) => event.type === "text_start" || event.type === "text_delta" || event.type.startsWith("thinking"),
			),
		).toBe(false);
		expect(getDoneMessage(events).content).toEqual([
			{ type: "toolCall", id: "call_1", name: "todo_manage", arguments: { action: "add", text: "leaked" } },
		]);
	});

	it("preserves XML thinking block under drop policy when no tool calls are returned", async () => {
		const events = await streamFromDeltas(
			[{ content: "<thinking>Let's plan" }, { content: " step by step</thinking> Here is the answer." }],
			{
				contentThinkingTags: "xml",
				toolCallContentPolicy: "drop-when-tool-calls",
			},
			"stop",
		);

		// Without tool calls, both thinking block and standard text are fully preserved
		expect(getDoneMessage(events).content).toEqual([
			{ type: "thinking", thinking: "Let's plan step by step", thinkingSignature: "content_thinking_tags" },
			{ type: "text", text: " Here is the answer." },
		]);
	});

	it("drops fragmented leaked content chunks when tool calls are returned", async () => {
		const events = await streamFromDeltas(
			[
				{ content: "{" },
				{ content: '"action"' },
				{ content: ":" },
				{ content: '"add"' },
				{ content: "}" },
				{
					tool_calls: [
						{
							index: 0,
							id: "call_1",
							type: "function",
							function: { name: "todo_manage", arguments: '{"action":"add"}' },
						},
					],
				},
			],
			{
				toolCallContentPolicy: "drop-when-tool-calls",
			},
			"tool_calls",
		);

		expect(events.some((event) => event.type === "text_start" || event.type === "text_delta")).toBe(false);
		expect(getDoneMessage(events).content).toEqual([
			{ type: "toolCall", id: "call_1", name: "todo_manage", arguments: { action: "add" } },
		]);
	});
});
