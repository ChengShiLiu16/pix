import type { AgentMessage } from "@earendil-works/pix-agent-core";
import type { AssistantMessage, Model } from "@earendil-works/pix-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type CompactionPreparation, compact, generateSummary } from "../src/core/compaction/index.ts";

const { completeSimpleMock } = vi.hoisted(() => ({
	completeSimpleMock: vi.fn(),
}));

vi.mock("@earendil-works/pix-ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pix-ai")>();
	return {
		...actual,
		completeSimple: completeSimpleMock,
	};
});

function createModel(reasoning: boolean, maxTokens = 8192): Model<"anthropic-messages"> {
	return {
		id: reasoning ? "reasoning-model" : "non-reasoning-model",
		name: reasoning ? "Reasoning Model" : "Non-reasoning Model",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens,
	};
}

const mockSummaryResponse: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "## Goal\nTest summary" }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-sonnet-4-5",
	usage: {
		input: 10,
		output: 10,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 20,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: Date.now(),
};

const messages: AgentMessage[] = [{ role: "user", content: "Summarize this.", timestamp: Date.now() }];

describe("generateSummary reasoning options", () => {
	beforeEach(() => {
		completeSimpleMock.mockReset();
		completeSimpleMock.mockResolvedValue(mockSummaryResponse);
	});

	it("uses the provided thinking level for reasoning-capable models", async () => {
		await generateSummary(
			messages,
			createModel(true),
			2000,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			"medium",
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			reasoning: "medium",
			apiKey: "test-key",
		});
	});

	it("does not set reasoning when thinking is off", async () => {
		await generateSummary(
			messages,
			createModel(true),
			2000,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			"off",
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			apiKey: "test-key",
		});
		expect(completeSimpleMock.mock.calls[0][2]).not.toHaveProperty("reasoning");
	});

	it("does not set reasoning for non-reasoning models", async () => {
		await generateSummary(
			messages,
			createModel(false),
			2000,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			"medium",
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			apiKey: "test-key",
		});
		expect(completeSimpleMock.mock.calls[0][2]).not.toHaveProperty("reasoning");
	});

	it("clamps compaction summary maxTokens to the model output cap", async () => {
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: messages,
			turnPrefixMessages: messages,
			isSplitTurn: true,
			tokensBefore: 600000,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 500000, keepRecentTokens: 20000 },
		};

		await compact(preparation, createModel(false, 128000), "test-key");

		expect(completeSimpleMock.mock.calls.map((call) => call[2]?.maxTokens)).toEqual([128000, 128000]);
	});
});

function promptTextOf(call: unknown[]): string {
	const ctx = call[1] as { messages: Array<{ content: Array<{ text: string }> }> };
	return ctx.messages[0].content[0].text;
}

function longSummaryResponse(chars: number): AssistantMessage {
	return { ...mockSummaryResponse, content: [{ type: "text", text: "y".repeat(chars) }] };
}

describe("generateSummary growth bounding (P2-8)", () => {
	beforeEach(() => {
		completeSimpleMock.mockReset();
		completeSimpleMock.mockResolvedValue(mockSummaryResponse);
	});

	it("uses the update prompt when the previous summary is small", async () => {
		await generateSummary(
			messages,
			createModel(false),
			2000,
			"test-key",
			undefined,
			undefined,
			undefined,
			"small prev",
		);
		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(promptTextOf(completeSimpleMock.mock.calls[0])).toContain("PRESERVE all existing information");
	});

	it("switches to the compaction prompt once the previous summary exceeds the soft cap", async () => {
		// reserveTokens=2000 → soft cap 1000 tokens. 6000 ASCII chars ≈ 1500 tokens.
		const bigPrev = "x".repeat(6000);
		await generateSummary(messages, createModel(false), 2000, "test-key", undefined, undefined, undefined, bigPrev);
		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		const text = promptTextOf(completeSimpleMock.mock.calls[0]);
		expect(text).toContain("MUST be compacted");
		expect(text).not.toContain("PRESERVE all existing information");
	});

	it("collapses the summary once when the produced output still exceeds the hard cap", async () => {
		// reserveTokens=2000 → hard cap 1600 tokens. 7000 ASCII chars ≈ 1750 tokens.
		completeSimpleMock.mockReset();
		completeSimpleMock.mockResolvedValueOnce(longSummaryResponse(7000)).mockResolvedValueOnce(mockSummaryResponse);

		const result = await generateSummary(messages, createModel(false), 2000, "test-key");

		expect(completeSimpleMock).toHaveBeenCalledTimes(2);
		// The second (collapse) call re-summarizes from scratch: no previous-summary tag.
		const collapseText = promptTextOf(completeSimpleMock.mock.calls[1]);
		expect(collapseText).toContain("The messages above are a conversation to summarize");
		expect(collapseText).not.toContain("<previous-summary>");
		expect(result).toBe("## Goal\nTest summary");
	});

	it("does not collapse when the produced output is within the hard cap", async () => {
		await generateSummary(messages, createModel(false), 2000, "test-key");
		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
	});
});
