import type { AgentMessage } from "@chengshiliu16/pix-agent-core";
import type { ToolResultMessage } from "@chengshiliu16/pix-ai";
import { beforeEach, describe, expect, it } from "vitest";
import {
	accumulateTurnFocus,
	detectPrefixCaching,
	enforceCacheContinuity,
	resetContinuityState,
} from "../src/core/context-continuity.ts";
import { requiredSavingsForCacheBreak } from "../src/core/context-thresholds.ts";

function userMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: 0 } as AgentMessage;
}

function assistantCall(id: string, name: string, args: Record<string, unknown>): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: args }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		stopReason: "toolUse",
		timestamp: 0,
	} as AgentMessage;
}

function toolResult(id: string, toolName: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 0,
	};
}

function withText(message: AgentMessage, text: string): AgentMessage {
	return { ...(message as ToolResultMessage), content: [{ type: "text", text }] } as AgentMessage;
}

function resultText(message: AgentMessage): string {
	const content = (message as ToolResultMessage).content;
	return content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

/** ~10k tokens of tool output, big enough for the gate arithmetic to bite. */
const BIG = "x".repeat(40_000);

const BASE_OPTIONS = { sessionId: "s", ratio: 0.66, compactionRatio: 0.9 };

function conversation(): AgentMessage[] {
	return [
		userMessage("find the bug"),
		assistantCall("t1", "read", { path: "/a.ts" }),
		toolResult("t1", "read", BIG),
		userMessage("keep going"),
		assistantCall("t2", "read", { path: "/b.ts" }),
		toolResult("t2", "read", "small result"),
	];
}

describe("enforceCacheContinuity", () => {
	beforeEach(() => {
		resetContinuityState();
	});

	it("passes the first request through and records what was emitted", () => {
		const messages = conversation();
		const decision = enforceCacheContinuity(messages, messages, BASE_OPTIONS);

		expect(decision.regime).toBe("no_history");
		expect(decision.applied).toBe(true);
		expect(decision.messages).toBe(messages);
	});

	it("reports no break when the second request re-sends identical bytes", () => {
		const messages = conversation();
		enforceCacheContinuity(messages, messages, BASE_OPTIONS);

		const decision = enforceCacheContinuity(messages, messages, BASE_OPTIONS);
		expect(decision.regime).toBe("no_break");
		expect(decision.breakIndex).toBe(-1);
	});

	it("keeps a rewrite whose savings repay the cache miss", () => {
		const messages = conversation();
		enforceCacheContinuity(messages, messages, BASE_OPTIONS);

		const candidate = messages.slice();
		candidate[2] = withText(messages[2], "[read result omitted]");

		const decision = enforceCacheContinuity(messages, candidate, BASE_OPTIONS);
		expect(decision.regime).toBe("economic_pass");
		expect(decision.applied).toBe(true);
		expect(decision.breakIndex).toBe(2);
		expect(decision.savedTokens).toBeGreaterThan(decision.requiredSavedTokens);
		expect(resultText(decision.messages[2])).toBe("[read result omitted]");
	});

	it("rolls back a rewrite that does not repay the cache miss", () => {
		const messages = conversation();
		enforceCacheContinuity(messages, messages, BASE_OPTIONS);

		// Trims 25% of the result — real savings, but far below the break-even
		// point for invalidating ~10k cached tokens.
		const candidate = messages.slice();
		candidate[2] = withText(messages[2], "x".repeat(30_000));

		const decision = enforceCacheContinuity(messages, candidate, BASE_OPTIONS);
		expect(decision.regime).toBe("economic_reject");
		expect(decision.applied).toBe(false);
		expect(decision.savedTokens).toBeLessThan(decision.requiredSavedTokens);
		expect(decision.requiredSavedTokens).toBe(requiredSavingsForCacheBreak(decision.brokenSuffixTokens));
		// Prefix restored byte-for-byte, so the provider still sees a cache hit.
		expect(resultText(decision.messages[2])).toBe(BIG);
	});

	it("accepts a modest rewrite once compaction is imminent", () => {
		const messages = conversation();
		const relief = { ...BASE_OPTIONS, ratio: 0.88, compactionRatio: 0.9 };
		enforceCacheContinuity(messages, messages, relief);

		const candidate = messages.slice();
		candidate[2] = withText(messages[2], "x".repeat(30_000));

		const decision = enforceCacheContinuity(messages, candidate, relief);
		expect(decision.regime).toBe("relief");
		expect(decision.applied).toBe(true);
		expect(resultText(decision.messages[2])).toHaveLength(30_000);
	});

	it("never restores a result it already emitted in reduced form", () => {
		const messages = conversation();
		enforceCacheContinuity(messages, messages, BASE_OPTIONS);

		const aged = messages.slice();
		aged[2] = withText(messages[2], "[read result omitted]");
		const first = enforceCacheContinuity(messages, aged, BASE_OPTIONS);
		expect(first.applied).toBe(true);

		// Next request the focus shifts back and the aging pass would hand back the
		// full text. Un-aging has negative savings, so it must not go out.
		const second = enforceCacheContinuity(messages, messages, BASE_OPTIONS);
		expect(second.applied).toBe(false);
		expect(second.savedTokens).toBeLessThan(0);
		expect(resultText(second.messages[2])).toBe("[read result omitted]");
	});

	it("always rewrites messages appended since the last request", () => {
		const first = conversation();
		enforceCacheContinuity(first, first, BASE_OPTIONS);

		const messages = [...first, assistantCall("t3", "read", { path: "/c.ts" }), toolResult("t3", "read", BIG)];
		const candidate = messages.slice();
		candidate[7] = withText(messages[7], "[read result omitted]");

		const decision = enforceCacheContinuity(messages, candidate, BASE_OPTIONS);
		expect(decision.regime).toBe("no_break");
		expect(resultText(decision.messages[7])).toBe("[read result omitted]");
	});

	it("does not gate when the provider is not serving cache hits", () => {
		const messages = conversation();
		enforceCacheContinuity(messages, messages, BASE_OPTIONS);

		const candidate = messages.slice();
		candidate[2] = withText(messages[2], "x".repeat(39_000));

		const decision = enforceCacheContinuity(messages, candidate, { ...BASE_OPTIONS, disabled: true });
		expect(decision.applied).toBe(true);
		expect(resultText(decision.messages[2])).toHaveLength(39_000);
	});

	it("does not record dry runs", () => {
		const messages = conversation();
		const candidate = messages.slice();
		candidate[2] = withText(messages[2], "[read result omitted]");

		enforceCacheContinuity(messages, candidate, { ...BASE_OPTIONS, commit: false });
		// The probe left no trace, so the real request is still the first one.
		const decision = enforceCacheContinuity(messages, messages, BASE_OPTIONS);
		expect(decision.regime).toBe("no_history");
	});

	it("re-aligns instead of matching by position after history is replaced", () => {
		const messages = conversation();
		enforceCacheContinuity(messages, messages, BASE_OPTIONS);

		// Compaction replaces the head of the conversation: keys stop matching, so
		// nothing is treated as previously cached.
		const compacted: AgentMessage[] = [
			userMessage("summary"),
			assistantCall("t9", "read", { path: "/z.ts" }),
			toolResult("t9", "read", BIG),
		];
		const candidate = compacted.slice();
		candidate[2] = withText(compacted[2], "[read result omitted]");

		const decision = enforceCacheContinuity(compacted, candidate, BASE_OPTIONS);
		expect(decision.regime).toBe("no_history");
		expect(resultText(decision.messages[2])).toBe("[read result omitted]");
	});
});

describe("detectPrefixCaching", () => {
	function assistantWithUsage(cacheRead: number, cacheWrite: number): AgentMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			stopReason: "stop",
			timestamp: 0,
			usage: { input: 10, output: 10, cacheRead, cacheWrite, totalTokens: 20 },
		} as AgentMessage;
	}

	it("assumes caching when no usage has been reported yet", () => {
		expect(detectPrefixCaching([userMessage("hi")])).toBe(true);
	});

	it("detects caching from reported cache reads", () => {
		expect(detectPrefixCaching([userMessage("hi"), assistantWithUsage(1200, 0)])).toBe(true);
	});

	it("detects the absence of caching when usage never reports cache activity", () => {
		const messages = [userMessage("hi"), assistantWithUsage(0, 0), userMessage("again"), assistantWithUsage(0, 0)];
		expect(detectPrefixCaching(messages)).toBe(false);
	});
});

describe("accumulateTurnFocus", () => {
	beforeEach(() => {
		resetContinuityState();
	});

	const emptyFocus = () => ({
		targetPaths: new Set<string>(),
		targetScopes: new Set<string>(),
		focusToolCallIds: new Set<string>(),
	});

	it("unions focus across the requests of one turn", () => {
		const turn = [userMessage("go"), assistantCall("t1", "read", { path: "/a.ts" })];

		const first = accumulateTurnFocus("s", turn, {
			...emptyFocus(),
			targetPaths: new Set(["/a.ts"]),
		});
		expect([...first.targetPaths]).toEqual(["/a.ts"]);

		// Same turn, the model moved on to another file: /a.ts must stay protected.
		const second = accumulateTurnFocus("s", turn, {
			...emptyFocus(),
			targetPaths: new Set(["/b.ts"]),
		});
		expect([...second.targetPaths].sort()).toEqual(["/a.ts", "/b.ts"]);
	});

	it("resets when a new user turn starts", () => {
		const turn = [userMessage("go")];
		accumulateTurnFocus("s", turn, { ...emptyFocus(), targetPaths: new Set(["/a.ts"]) });

		const nextTurn = [...turn, userMessage("new topic")];
		const focus = accumulateTurnFocus("s", nextTurn, {
			...emptyFocus(),
			targetPaths: new Set(["/b.ts"]),
		});
		expect([...focus.targetPaths]).toEqual(["/b.ts"]);
	});
});
