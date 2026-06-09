import type { AgentMessage } from "@chengshiliu16/pix-agent-core";
import type { AssistantMessage, Model } from "@chengshiliu16/pix-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type CompactionPreparation, compact, estimateTokens, generateSummary } from "../src/core/compaction/index.ts";

const { completeSimpleMock, emitCompactionMock, emitCompactionQualityMock } = vi.hoisted(() => ({
	completeSimpleMock: vi.fn(),
	emitCompactionMock: vi.fn(),
	emitCompactionQualityMock: vi.fn(),
}));

vi.mock("@chengshiliu16/pix-ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@chengshiliu16/pix-ai")>();
	return {
		...actual,
		completeSimple: completeSimpleMock,
	};
});

vi.mock("../src/core/context-metrics.ts", () => ({
	emitCompaction: emitCompactionMock,
	emitCompactionQuality: emitCompactionQualityMock,
}));

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
		emitCompactionMock.mockReset();
		emitCompactionQualityMock.mockReset();
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
			fileOps: {
				read: new Set(["packages/coding-agent/src/core/context-optimizer.ts"]),
				written: new Set(),
				edited: new Set(),
			},
			settings: { enabled: true, reserveTokens: 500000, keepRecentTokens: 20000 },
		};

		await compact(preparation, createModel(false, 128000), "test-key");

		expect(completeSimpleMock.mock.calls.map((call) => call[2]?.maxTokens)).toEqual([128000, 128000]);
	});

	it("restores previous critical anchors without injecting empty sections", async () => {
		completeSimpleMock.mockReset();
		completeSimpleMock.mockResolvedValue({
			...mockSummaryResponse,
			content: [{ type: "text", text: "## Goal\nContinue work" }],
		});
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: messages,
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 600000,
			previousSummary:
				'## Critical Context\n- Keep packages/coding-agent/src/core/context-aging.ts and restoreHint() visible.\n- Error was "Context overflow recovery failed".',
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 500000, keepRecentTokens: 20000 },
		};

		const result = await compact(preparation, createModel(false), "test-key");

		// 旧摘要中的关键锚点会被恢复，但恢复区明确要求后续重新验证。
		expect(result.summary).toContain("## Critical Context Anchors Preserved");
		expect(result.summary).toContain("re-verify before treating them as current facts");
		expect(result.summary).toContain("packages/coding-agent/src/core/context-aging.ts");
		expect(result.summary).toContain("restoreHint()");
		expect(result.summary).toContain('"Context overflow recovery failed"');
		// 模型没产出的章节不会用空壳补齐，否则会掩盖结构丢失。
		expect(result.summary).not.toContain("## Constraints & Preferences");
		expect(result.summary).not.toContain("(none recorded)");
	});

	it("emits quality metrics for constraint, next step, and critical anchor retention", async () => {
		completeSimpleMock.mockReset();
		emitCompactionQualityMock.mockReset();
		completeSimpleMock.mockResolvedValue({
			...mockSummaryResponse,
			content: [{ type: "text", text: "## Goal\nContinue work" }],
		});
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: messages,
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 600000,
			previousSummary: [
				"## Goal",
				"Reduce context safely",
				"",
				"## Constraints & Preferences",
				"- Do not lose user constraints",
				"",
				"## Progress",
				"- [ ] Wire metrics",
				"",
				"## Key Decisions",
				"- **Evidence**: Keep packages/coding-agent/src/core/context-optimizer.ts visible",
				"",
				"## Next Steps",
				"1. Run npm run check",
				"",
				"## Critical Context",
				'- Error was "Context overflow recovery failed"',
			].join("\n"),
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 500000, keepRecentTokens: 20000 },
		};

		await compact(
			preparation,
			createModel(false),
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			"session-quality",
		);

		expect(emitCompactionQualityMock).toHaveBeenCalledTimes(1);
		// 质量指标基于模型 raw summary 计算；后处理和文件清单都不能把丢失伪装成保留。
		expect(emitCompactionQualityMock.mock.calls[0][0]).toMatchObject({
			sessionId: "session-quality",
			requiredSectionRetention: expect.closeTo(1 / 6),
			userConstraintRetention: 0,
			nextStepRetention: 0,
			criticalAnchorCount: 2,
			lostCriticalAnchorCount: 2,
			restoredCriticalAnchorCount: 2,
		});
	});

	it("re-estimates token counts when a message object is mutated in place", () => {
		const message = { role: "user" as const, content: "short", timestamp: Date.now() } satisfies AgentMessage;
		const before = estimateTokens(message);
		message.content = "x".repeat(1000);

		expect(estimateTokens(message)).toBeGreaterThan(before + 100);
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
		emitCompactionMock.mockReset();
		emitCompactionQualityMock.mockReset();
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
		// reserveTokens=2000 时软上限约 1000 tokens；6000 个 ASCII 字符约 1500 tokens。
		const bigPrev = "x".repeat(6000);
		await generateSummary(messages, createModel(false), 2000, "test-key", undefined, undefined, undefined, bigPrev);
		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		const text = promptTextOf(completeSimpleMock.mock.calls[0]);
		expect(text).toContain("MUST be compacted");
		expect(text).not.toContain("PRESERVE all existing information");
	});

	it("collapses the summary once when the produced output still exceeds the hard cap", async () => {
		// reserveTokens=2000 时硬上限约 1600 tokens；7000 个 ASCII 字符约 1750 tokens。
		completeSimpleMock.mockReset();
		completeSimpleMock.mockResolvedValueOnce(longSummaryResponse(7000)).mockResolvedValueOnce(mockSummaryResponse);

		const result = await generateSummary(messages, createModel(false), 2000, "test-key");

		expect(completeSimpleMock).toHaveBeenCalledTimes(2);
		// 第二次 collapse 从头摘要，不携带 previous-summary。
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
