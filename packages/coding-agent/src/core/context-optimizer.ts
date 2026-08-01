import type { AgentMessage } from "@chengshiliu16/pix-agent-core";
import type { TextContent } from "@chengshiliu16/pix-ai";
import {
	type CompactionSettings,
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextTokens,
	resolveCompactionSettings,
} from "./compaction/index.ts";
import { ageToolResults, compactEditArguments } from "./context-aging.ts";
import {
	accumulateTurnFocus,
	type CacheContinuityDecision,
	detectCacheSemantics,
	enforceCacheContinuity,
} from "./context-continuity.ts";
import { CONTEXT_DEBUG, contextDebug } from "./context-debug.ts";
import { emitContextPhase, emitTokenEstimation, isMetricsEnabled } from "./context-metrics.ts";
import { pruneStaleReads, pruneThinkingForNonAnthropic } from "./context-prune.ts";
import { buildFocusContext, computeReachability } from "./context-reachability.ts";
import {
	AGING_START_RATIO,
	EDIT_ARGS_COMPACT_RATIO,
	getEffectiveHeavyAgingThreshold,
	STALE_PRUNE_START_RATIO,
} from "./context-thresholds.ts";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from "./tools/truncate.ts";

function capAssistantTextBlocks(messages: AgentMessage[]): AgentMessage[] {
	const MAX_ASSISTANT_TEXT_BYTES = DEFAULT_MAX_BYTES * 2; // 100KB
	if (messages.length === 0) return messages;

	let changed = false;
	const next = messages.map((msg) => {
		if (msg.role !== "assistant") return msg;
		const content = msg.content;
		if (!content || !Array.isArray(content)) return msg;

		let messageChanged = false;
		const newContent = content.map((block) => {
			if (block.type !== "text") return block;
			const bytes = Buffer.byteLength(block.text, "utf-8");
			if (bytes <= MAX_ASSISTANT_TEXT_BYTES) return block;

			messageChanged = true;
			const truncated = truncateHead(block.text, { maxBytes: MAX_ASSISTANT_TEXT_BYTES });
			if (truncated.firstLineExceedsLimit) {
				return {
					type: "text",
					text: `[Assistant text block (${formatSize(bytes)}) exceeds limit. Truncated.]`,
				} satisfies TextContent;
			}

			const totalSize = formatSize(truncated.totalBytes);
			return {
				type: "text",
				text: `${truncated.content}\n\n[Truncated: ${formatSize(MAX_ASSISTANT_TEXT_BYTES)} of ${totalSize} shown.]`,
			} satisfies TextContent;
		});

		if (!messageChanged) return msg;
		changed = true;
		return { ...msg, content: newContent };
	});

	return changed ? next : messages;
}

export interface OptimizeOutgoingContextOptions {
	cwd: string;
	contextWindow: number;
	provider: string;
	sessionId: string; // For metrics correlation
	compactionSettings?: CompactionSettings; // User-configured compaction settings
	/**
	 * Active model's cost metadata (input/cacheRead/cacheWrite rates). Used to
	 * derive the cache-gate pricing: the hit price is model specific on
	 * OpenAI-style auto caching (e.g. opencode-go kimi-k2.6 bills cacheRead at
	 * 0.16 vs 0.95 input ≈ 0.17x), and a write premium in the metadata (gpt-5.6
	 * bills cacheWrite at 1.25x) marks Anthropic-style pricing that the gate must
	 * keep conservative.
	 */
	model?: { cost?: { input?: number; cacheRead?: number; cacheWrite?: number } };
}

export type ContextOptimizationStageName =
	| "assistant_cap"
	| "aging"
	| "stale_prune"
	| "thinking_prune"
	| "edit_compact";

export type ContextOptimizationImpact = "none" | "low" | "medium" | "high";

export interface ContextOptimizationStageReport {
	name: ContextOptimizationStageName;
	ran: boolean;
	changed: boolean;
	tokensBefore: number;
	tokensAfter: number;
	savedTokens: number;
	durationMs: number;
	destructiveLevel: ContextOptimizationImpact;
	cacheBreakRisk: ContextOptimizationImpact;
	changedMessages: number;
	omittedResultsAdded: number;
	reason?: string;
}

export interface OptimizationReport {
	contextWindow: number;
	tokensBefore: number;
	tokensAfter: number;
	savedTokens: number;
	ratioBefore: number;
	ratioAfter: number;
	changed: boolean;
	destructiveLevel: ContextOptimizationImpact;
	cacheBreakRisk: ContextOptimizationImpact;
	changedMessages: number;
	omittedResultsAdded: number;
	stages: ContextOptimizationStageReport[];
	/**
	 * Outcome of the prefix-cache gate: whether the rewrite was allowed to break
	 * the provider's cached prefix, and the arithmetic behind that call.
	 */
	cacheGate?: CacheContinuityDecision;
}

export interface OptimizedOutgoingContext {
	messages: AgentMessage[];
	report: OptimizationReport;
}

const IMPACT_RANK: Record<ContextOptimizationImpact, number> = {
	none: 0,
	low: 1,
	medium: 2,
	high: 3,
};

function maxImpact(a: ContextOptimizationImpact, b: ContextOptimizationImpact): ContextOptimizationImpact {
	return IMPACT_RANK[a] >= IMPACT_RANK[b] ? a : b;
}

function ratioFor(tokens: number, contextWindow: number): number {
	return contextWindow > 0 ? tokens / contextWindow : 0;
}

function changedMessageCount(before: AgentMessage[], after: AgentMessage[]): number {
	if (before === after) return 0;
	const sharedLength = Math.min(before.length, after.length);
	let changed = Math.abs(before.length - after.length);
	for (let index = 0; index < sharedLength; index++) {
		if (before[index] !== after[index]) changed++;
	}
	return changed;
}

function contextOmittedCount(messages: AgentMessage[]): number {
	let count = 0;
	for (const message of messages) {
		if (message.role !== "toolResult") continue;
		const details = (message as { details?: unknown }).details;
		if (typeof details !== "object" || details === null || Array.isArray(details)) continue;
		const omitted = (details as Record<string, unknown>).contextOmitted;
		if (typeof omitted === "object" && omitted !== null) count++;
	}
	return count;
}

function estimateIfNeeded(messages: AgentMessage[], contextWindow: number, shouldEstimate: boolean): number {
	return shouldEstimate && contextWindow > 0 ? estimateContextTokens(messages).tokens : 0;
}

function estimatePressureTokens(messages: AgentMessage[], contextWindow: number): number {
	return contextWindow > 0 ? estimateContextTokens(messages).tokens : 0;
}

function createStageReport(args: {
	name: ContextOptimizationStageName;
	ran: boolean;
	beforeMessages: AgentMessage[];
	afterMessages: AgentMessage[];
	tokensBefore: number;
	tokensAfter: number;
	durationMs: number;
	destructiveLevel: ContextOptimizationImpact;
	cacheBreakRisk: ContextOptimizationImpact;
	reason?: string;
}): ContextOptimizationStageReport {
	return {
		name: args.name,
		ran: args.ran,
		changed: args.beforeMessages !== args.afterMessages,
		tokensBefore: args.tokensBefore,
		tokensAfter: args.tokensAfter,
		savedTokens: Math.max(0, args.tokensBefore - args.tokensAfter),
		durationMs: args.durationMs,
		destructiveLevel: args.destructiveLevel,
		cacheBreakRisk: args.cacheBreakRisk,
		changedMessages: changedMessageCount(args.beforeMessages, args.afterMessages),
		omittedResultsAdded: Math.max(
			0,
			contextOmittedCount(args.afterMessages) - contextOmittedCount(args.beforeMessages),
		),
		reason: args.reason,
	};
}

function createReport(
	messages: AgentMessage[],
	result: AgentMessage[],
	contextWindow: number,
	stages: ContextOptimizationStageReport[],
): OptimizationReport {
	const measuredStages = stages.filter((stage) => stage.tokensBefore > 0 || stage.tokensAfter > 0);
	const tokensBefore = measuredStages[0]?.tokensBefore ?? 0;
	const tokensAfter = measuredStages[measuredStages.length - 1]?.tokensAfter ?? tokensBefore;
	let destructiveLevel: ContextOptimizationImpact = "none";
	let cacheBreakRisk: ContextOptimizationImpact = "none";
	let changedMessages = 0;
	let omittedResultsAdded = 0;
	for (const stage of stages) {
		if (!stage.changed) continue;
		destructiveLevel = maxImpact(destructiveLevel, stage.destructiveLevel);
		cacheBreakRisk = maxImpact(cacheBreakRisk, stage.cacheBreakRisk);
		changedMessages += stage.changedMessages;
		omittedResultsAdded += stage.omittedResultsAdded;
	}
	return {
		contextWindow,
		tokensBefore,
		tokensAfter,
		savedTokens: Math.max(0, tokensBefore - tokensAfter),
		ratioBefore: ratioFor(tokensBefore, contextWindow),
		ratioAfter: ratioFor(tokensAfter, contextWindow),
		changed: messages !== result,
		destructiveLevel,
		cacheBreakRisk,
		changedMessages,
		omittedResultsAdded,
		stages,
	};
}

export function shouldUseOptimizedContextInsteadOfCompaction(
	report: OptimizationReport,
	settings: CompactionSettings,
): boolean {
	if (report.contextWindow <= 0 || !report.changed) return false;
	const threshold = report.contextWindow - settings.reserveTokens;
	if (report.tokensAfter > threshold) return false;

	const headroomTokens = threshold - report.tokensAfter;
	const minSavedTokens = Math.max(1024, Math.floor(report.contextWindow * 0.01));
	const minHeadroomTokens = Math.max(512, Math.floor(report.contextWindow * 0.005));
	if (report.savedTokens < minSavedTokens || headroomTokens < minHeadroomTokens) return false;

	if (report.cacheBreakRisk === "high") {
		const minHighRiskSavings = Math.max(minSavedTokens, Math.floor(report.contextWindow * 0.03));
		return report.savedTokens >= minHighRiskSavings;
	}
	return true;
}

async function optimizeOutgoingContextInternal(
	messages: AgentMessage[],
	options: OptimizeOutgoingContextOptions,
	collectReport: boolean,
	commitLedger: boolean,
): Promise<OptimizedOutgoingContext> {
	const startTime = performance.now();
	const stages: ContextOptimizationStageReport[] = [];

	// Metrics enabled check - guard expensive token estimations used only for metrics
	const metricsEnabled = isMetricsEnabled();
	const shouldMeasureStages = (metricsEnabled || collectReport) && options.contextWindow > 0;

	let next = messages;
	let previousTokens = estimateIfNeeded(next, options.contextWindow, shouldMeasureStages);
	const capStartTime = performance.now();
	const capped = capAssistantTextBlocks(next);
	const afterCapTokens = estimateIfNeeded(capped, options.contextWindow, shouldMeasureStages);
	stages.push(
		createStageReport({
			name: "assistant_cap",
			ran: true,
			beforeMessages: next,
			afterMessages: capped,
			tokensBefore: previousTokens,
			tokensAfter: afterCapTokens,
			durationMs: performance.now() - capStartTime,
			destructiveLevel: "low",
			cacheBreakRisk: "medium",
		}),
	);
	next = capped;
	previousTokens = afterCapTokens;

	if (metricsEnabled)
		emitContextPhase(options.sessionId, options.contextWindow, "optimize_start", 0, previousTokens, 0);

	// 在更具破坏性的 stale-read 剪枝前，先渐进压缩旧工具结果。
	const baselineTokens = shouldMeasureStages ? previousTokens : estimatePressureTokens(next, options.contextWindow);
	let currentTokens = baselineTokens;
	let currentRatio = ratioFor(currentTokens, options.contextWindow);

	// Emit token estimation debug event (only if metrics enabled)
	if (metricsEnabled) {
		emitTokenEstimation(options.sessionId, options.contextWindow, baselineTokens, messages.length, false);
	}

	// Compute effective heavy aging threshold with hysteresis gap from compaction.
	// Uses the user-configured compaction settings (clamped to window-safe band).
	const settings = options.compactionSettings ?? DEFAULT_COMPACTION_SETTINGS;
	const clampedSettings = resolveCompactionSettings(settings, options.contextWindow);
	const effectiveHeavyThreshold = getEffectiveHeavyAgingThreshold(
		options.contextWindow,
		clampedSettings.reserveTokens,
	);

	if (currentRatio >= AGING_START_RATIO) {
		const agingStartTime = performance.now();
		const beforeAging = next;
		// Focus accumulates across the requests of one user turn so a result cannot
		// lose its protection (and get aged) mid-turn just because the model moved
		// on to another file.
		const focus = accumulateTurnFocus(options.sessionId, next, buildFocusContext(next, 2, options.cwd));
		const reachability = computeReachability(next, 2, options.cwd, focus);
		next = ageToolResults(next, currentRatio, reachability, effectiveHeavyThreshold);
		const afterAgingTokens = estimateIfNeeded(next, options.contextWindow, shouldMeasureStages);
		stages.push(
			createStageReport({
				name: "aging",
				ran: true,
				beforeMessages: beforeAging,
				afterMessages: next,
				tokensBefore: previousTokens,
				tokensAfter: afterAgingTokens,
				durationMs: performance.now() - agingStartTime,
				destructiveLevel: currentRatio >= effectiveHeavyThreshold ? "high" : "medium",
				cacheBreakRisk: "medium",
			}),
		);
		if (metricsEnabled) {
			emitContextPhase(
				options.sessionId,
				options.contextWindow,
				"aging",
				previousTokens,
				afterAgingTokens,
				performance.now() - agingStartTime,
			);
		}
		previousTokens = afterAgingTokens;
		if (next !== beforeAging) {
			currentTokens = shouldMeasureStages ? afterAgingTokens : estimatePressureTokens(next, options.contextWindow);
			currentRatio = ratioFor(currentTokens, options.contextWindow);
		}
	} else {
		stages.push(
			createStageReport({
				name: "aging",
				ran: false,
				beforeMessages: next,
				afterMessages: next,
				tokensBefore: previousTokens,
				tokensAfter: previousTokens,
				durationMs: 0,
				destructiveLevel: "medium",
				cacheBreakRisk: "medium",
				reason: "below_threshold",
			}),
		);
	}

	// stale-read 剪枝会重写中段历史，并让 Anthropic 前缀缓存从该点失效。
	// 仅在上下文足够高时执行，确保 token 节省能抵消一次性 cache miss.
	if (options.contextWindow > 0 && currentTokens > options.contextWindow * STALE_PRUNE_START_RATIO) {
		const pruneStartTime = performance.now();
		const beforePrune = next;
		next = pruneStaleReads(next, options.cwd);
		const afterPruneTokens = estimateIfNeeded(next, options.contextWindow, shouldMeasureStages);
		stages.push(
			createStageReport({
				name: "stale_prune",
				ran: true,
				beforeMessages: beforePrune,
				afterMessages: next,
				tokensBefore: previousTokens,
				tokensAfter: afterPruneTokens,
				durationMs: performance.now() - pruneStartTime,
				destructiveLevel: "medium",
				cacheBreakRisk: "high",
			}),
		);
		if (metricsEnabled) {
			emitContextPhase(
				options.sessionId,
				options.contextWindow,
				"stale_prune",
				previousTokens,
				afterPruneTokens,
				performance.now() - pruneStartTime,
			);
		}
		previousTokens = afterPruneTokens;
		if (next !== beforePrune) {
			currentTokens = shouldMeasureStages ? afterPruneTokens : estimatePressureTokens(next, options.contextWindow);
			currentRatio = ratioFor(currentTokens, options.contextWindow);
		}
	} else {
		stages.push(
			createStageReport({
				name: "stale_prune",
				ran: false,
				beforeMessages: next,
				afterMessages: next,
				tokensBefore: previousTokens,
				tokensAfter: previousTokens,
				durationMs: 0,
				destructiveLevel: "medium",
				cacheBreakRisk: "high",
				reason: "below_threshold",
			}),
		);
	}

	const thinkingStartTime = performance.now();
	const beforeThinking = next;
	next = pruneThinkingForNonAnthropic(next, options.provider);
	const afterThinkingTokens = estimateIfNeeded(next, options.contextWindow, shouldMeasureStages);
	stages.push(
		createStageReport({
			name: "thinking_prune",
			ran: options.provider !== "anthropic",
			beforeMessages: beforeThinking,
			afterMessages: next,
			tokensBefore: previousTokens,
			tokensAfter: afterThinkingTokens,
			durationMs: performance.now() - thinkingStartTime,
			destructiveLevel: "low",
			cacheBreakRisk: options.provider === "anthropic" ? "none" : "low",
			reason: options.provider === "anthropic" ? "provider_preserves_cache" : undefined,
		}),
	);
	previousTokens = afterThinkingTokens;
	if (beforeThinking !== next) {
		currentTokens = shouldMeasureStages ? afterThinkingTokens : estimatePressureTokens(next, options.contextWindow);
		currentRatio = ratioFor(currentTokens, options.contextWindow);
	}

	const editStartTime = performance.now();
	const beforeEdit = next;
	const editRatio = currentRatio;
	const rewritten = compactEditArguments(next, editRatio);
	const afterEditTokens = estimateIfNeeded(rewritten, options.contextWindow, shouldMeasureStages);
	stages.push(
		createStageReport({
			name: "edit_compact",
			ran: editRatio >= EDIT_ARGS_COMPACT_RATIO,
			beforeMessages: beforeEdit,
			afterMessages: rewritten,
			tokensBefore: previousTokens,
			tokensAfter: afterEditTokens,
			durationMs: performance.now() - editStartTime,
			destructiveLevel: "low",
			cacheBreakRisk: "medium",
			reason: editRatio < EDIT_ARGS_COMPACT_RATIO ? "below_threshold" : undefined,
		}),
	);

	// Every pass above rewrites history in place, which invalidates the provider
	// prefix cache from the first changed message. Charge that cost against the
	// tokens saved and keep the rewrite only when it repays the cache miss.
	const semantics = detectCacheSemantics(messages, options.model);
	const gate = enforceCacheContinuity(messages, rewritten, {
		sessionId: options.sessionId,
		ratio: currentRatio,
		compactionRatio: options.contextWindow > 0 ? 1 - clampedSettings.reserveTokens / options.contextWindow : 0,
		semantics,
		commit: commitLedger,
	});
	const result = gate.messages;
	if (metricsEnabled) {
		emitContextPhase(
			options.sessionId,
			options.contextWindow,
			"cache_gate",
			gate.brokenSuffixTokens,
			gate.applied ? gate.brokenSuffixTokens - gate.savedTokens : gate.brokenSuffixTokens,
			0,
		);
	}

	// Measure aging+prune yield. The extra estimate only runs under PIX_CONTEXT_DEBUG, which is
	// exactly when metrics are enabled (PIX_CONTEXT_DEBUG=1 also drives the
	// CONTEXT_DEBUG log below, so no separate CONTEXT_DEBUG guard is needed).
	const shouldMeasureFinalTokens = shouldMeasureStages;
	const finalTokens = shouldMeasureFinalTokens ? afterEditTokens : currentTokens;
	if (metricsEnabled) {
		emitContextPhase(
			options.sessionId,
			options.contextWindow,
			"optimize_end",
			baselineTokens,
			finalTokens,
			performance.now() - startTime,
		);
	}

	const report = createReport(messages, result, options.contextWindow, stages);
	report.cacheGate = gate;
	if (!gate.applied) {
		// The rewrite was rolled back inside the cached region: report what is
		// actually being sent, not what the stages would have produced.
		const sentTokens = estimateIfNeeded(result, options.contextWindow, shouldMeasureStages);
		report.tokensAfter = sentTokens || report.tokensBefore;
		report.savedTokens = Math.max(0, report.tokensBefore - report.tokensAfter);
		report.ratioAfter = ratioFor(report.tokensAfter, options.contextWindow);
		report.changed = messages !== result;
	}
	if (CONTEXT_DEBUG && options.contextWindow > 0) {
		contextDebug(
			`optimize ${report.tokensBefore}->${report.tokensAfter} tok ` +
				`(ratio ${report.ratioBefore.toFixed(2)}->${report.ratioAfter.toFixed(2)}, ` +
				`saved ${report.savedTokens}, risk=${report.cacheBreakRisk})`,
		);
		if (gate.breakIndex >= 0) {
			contextDebug(
				`cache-gate ${gate.regime} @${gate.breakIndex}: saved ${gate.savedTokens} tok vs ` +
					`required ${gate.requiredSavedTokens} (suffix ${gate.brokenSuffixTokens})`,
			);
		}
	}
	return { messages: result, report };
}

export async function optimizeOutgoingContext(
	messages: AgentMessage[],
	options: OptimizeOutgoingContextOptions,
): Promise<AgentMessage[]> {
	const result = await optimizeOutgoingContextInternal(messages, options, false, true);
	return result.messages;
}

export async function optimizeOutgoingContextWithReport(
	messages: AgentMessage[],
	options: OptimizeOutgoingContextOptions,
): Promise<OptimizedOutgoingContext> {
	// Dry run: the caller is deciding whether to compact, not sending a request,
	// so this must not become the ledger's record of what the provider saw.
	return optimizeOutgoingContextInternal(messages, options, true, false);
}
