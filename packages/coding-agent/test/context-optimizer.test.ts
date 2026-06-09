import type { AgentMessage } from "@chengshiliu16/pix-agent-core";
import type { ToolResultMessage } from "@chengshiliu16/pix-ai";
import { describe, expect, it } from "vitest";
import {
	type OptimizationReport,
	optimizeOutgoingContextWithReport,
	shouldUseOptimizedContextInsteadOfCompaction,
} from "../src/core/context-optimizer.ts";

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

function stage(report: OptimizationReport, name: string) {
	const found = report.stages.find((item) => item.name === name);
	if (!found) throw new Error(`missing stage ${name}`);
	return found;
}

describe("optimizeOutgoingContextWithReport", () => {
	it("reports stale prune savings and omitted restore coverage", async () => {
		const bigRead = "x".repeat(40_000);
		const messages: AgentMessage[] = [
			assistantCall("read-1", "read", { path: "/a.ts" }),
			toolResult("read-1", "read", bigRead),
			assistantCall("edit-1", "edit", { path: "/a.ts", old_string: "x", new_string: "y" }),
			toolResult("edit-1", "edit", "ok"),
		];

		const result = await optimizeOutgoingContextWithReport(messages, {
			cwd: "/repo",
			contextWindow: 12_000,
			provider: "anthropic",
			sessionId: "session-optimizer",
			compactionSettings: { enabled: true, reserveTokens: 2_000, keepRecentTokens: 3_000 },
		});

		const stalePrune = stage(result.report, "stale_prune");
		expect(stalePrune.ran).toBe(true);
		expect(stalePrune.changed).toBe(true);
		expect(stalePrune.cacheBreakRisk).toBe("high");
		expect(stalePrune.savedTokens).toBeGreaterThan(5_000);
		expect(stalePrune.omittedResultsAdded).toBe(1);
		expect(result.report.cacheBreakRisk).toBe("high");
		expect(result.report.savedTokens).toBeGreaterThan(5_000);
		expect(result.report.omittedResultsAdded).toBe(1);
		expect(
			shouldUseOptimizedContextInsteadOfCompaction(result.report, {
				enabled: true,
				reserveTokens: 2_000,
				keepRecentTokens: 3_000,
			}),
		).toBe(true);
	});

	it("does not use high cache-risk optimization when savings are too small", () => {
		const report: OptimizationReport = {
			contextWindow: 100_000,
			tokensBefore: 96_000,
			tokensAfter: 94_000,
			savedTokens: 2_000,
			ratioBefore: 0.96,
			ratioAfter: 0.94,
			changed: true,
			destructiveLevel: "medium",
			cacheBreakRisk: "high",
			changedMessages: 1,
			omittedResultsAdded: 1,
			stages: [],
		};

		expect(
			shouldUseOptimizedContextInsteadOfCompaction(report, {
				enabled: true,
				reserveTokens: 5_000,
				keepRecentTokens: 20_000,
			}),
		).toBe(false);
	});
});
