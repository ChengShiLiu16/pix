/**
 * Structured metrics emission for context window management.
 *
 * Supports multiple sinks: console (human-readable), JSONL file, structured JSON.
 * Controlled by PIX_CONTEXT_DEBUG environment variable:
 *   - "1" or "true"       -> console sink (human-readable)
 *   - "json"              -> console sink (JSON lines)
 *   - "file:/path/to.log" -> JSONL file append
 */

import { appendFile } from "node:fs/promises";
import type { MetricsEvent } from "./context-metrics-types.ts";

type MetricsSink = (event: MetricsEvent) => void | Promise<void>;

const sinks: MetricsSink[] = [];
let initialized = false;

type SinkKind = { mode: "human" } | { mode: "json" } | { mode: "file"; path: string };

/**
 * Resolve PIX_CONTEXT_DEBUG to a recognized sink kind, or undefined if unset or
 * unrecognized. Single source of truth shared by isMetricsEnabled() and
 * initSinks() so they never disagree about which values actually emit.
 */
function resolveSinkKind(): SinkKind | undefined {
	const debug = typeof process !== "undefined" ? process.env.PIX_CONTEXT_DEBUG : undefined;
	if (!debug) return undefined;
	if (debug === "1" || debug === "true") return { mode: "human" };
	if (debug === "json") return { mode: "json" };
	if (debug.startsWith("file:")) return { mode: "file", path: debug.slice(5) };
	return undefined;
}

/** Check if metrics will actually be emitted, to guard expensive instrumentation. */
export function isMetricsEnabled(): boolean {
	if (initialized) return sinks.length > 0;
	return resolveSinkKind() !== undefined;
}

/** Initialize sinks based on PIX_CONTEXT_DEBUG. Safe to call multiple times. */
function initSinks(): void {
	if (initialized) return;
	initialized = true;

	const kind = resolveSinkKind();
	if (!kind) return;

	switch (kind.mode) {
		case "human":
			sinks.push(consoleSinkHuman);
			break;
		case "json":
			sinks.push(consoleSinkJson);
			break;
		case "file":
			sinks.push(createFileSink(kind.path));
			break;
	}
}

/** Human-readable console sink. */
function consoleSinkHuman(event: MetricsEvent): void {
	let ts: string;
	let session: string;

	switch (event.type) {
		case "context_phase": {
			ts = new Date(event.event.timestamp).toISOString();
			session = event.event.sessionId.slice(0, 8);
			const e = event.event;
			console.log(
				`[${ts}] [ctx:${session}] ${e.phase}: ${e.tokensBefore}->${e.tokensAfter} tok ` +
					`(ratio ${e.ratioBefore.toFixed(2)}->${e.ratioAfter.toFixed(2)}) ${e.durationMs.toFixed(1)}ms`,
			);
			break;
		}
		case "compaction": {
			ts = new Date(event.event.timestamp).toISOString();
			session = event.event.sessionId.slice(0, 8);
			const e = event.event;
			console.log(
				`[${ts}] [ctx:${session}] compaction[${e.reason}]: summary ${e.summaryTokensBefore}->${e.summaryTokensAfter} ` +
					`keptRecent=${e.keptRecentTokens} dropped=${e.droppedMessages} ` +
					`compactTemplate=${e.compactTemplateUsed} doubleCompact=${e.doubleCompactTriggered} ${e.durationMs.toFixed(1)}ms`,
			);
			break;
		}
		case "compaction_quality": {
			ts = new Date(event.event.timestamp).toISOString();
			session = event.event.sessionId.slice(0, 8);
			const e = event.event;
			console.log(
				`[${ts}] [ctx:${session}] quality: ratio=${e.compressionRatio.toFixed(2)} retention=${e.keyItemRetention.toFixed(2)} ` +
					`structure=${e.structurePreservation.toFixed(2)} anchors=${e.anchorRetention.toFixed(2)} ` +
					`constraints=${e.userConstraintRetention.toFixed(2)} next=${e.nextStepRetention.toFixed(2)} ` +
					`lostAnchors=${e.lostCriticalAnchorCount}/${e.criticalAnchorCount} restored=${e.restoredCriticalAnchorCount} ` +
					`template=${e.compactTemplateUsed} double=${e.doubleCompactTriggered}`,
			);
			break;
		}
		case "token_estimation": {
			ts = new Date(event.event.timestamp).toISOString();
			session = event.event.sessionId.slice(0, 8);
			const e = event.event;
			console.log(
				`[${ts}] [ctx:${session}] estTokens: ${e.estimatedTokens} tokens from ${e.messageCount} messages (usageAvailable=${e.hasUsageData})`,
			);
			break;
		}
	}
}

/** JSON lines console sink. */
function consoleSinkJson(event: MetricsEvent): void {
	console.log(JSON.stringify(event));
}

/** Create a JSONL file append sink. */
function createFileSink(filePath: string): MetricsSink {
	let writeQueue: Promise<void> = Promise.resolve();
	return async (event: MetricsEvent) => {
		const line = `${JSON.stringify(event)}\n`;
		writeQueue = writeQueue
			.then(async () => {
				await appendFile(filePath, line);
			})
			.catch(() => {
				// Swallow write errors to avoid crashing the session
			});
		await writeQueue;
	};
}

/** Emit event to all sinks. Safe to call before init. */
export function emit(event: MetricsEvent): void {
	initSinks();
	for (const sink of sinks) {
		try {
			sink(event);
		} catch {
			// Sink errors must not break the main flow
		}
	}
}

/** Emit a context phase event. */
export function emitContextPhase(
	sessionId: string,
	contextWindow: number,
	phase: "optimize_start" | "git_evidence_transform" | "aging" | "stale_prune" | "optimize_end",
	tokensBefore: number,
	tokensAfter: number,
	durationMs: number,
): void {
	if (!sessionId || contextWindow <= 0) return;
	const timestamp = Date.now();
	emit({
		type: "context_phase",
		event: {
			timestamp,
			sessionId,
			phase,
			contextWindow,
			tokensBefore,
			tokensAfter,
			ratioBefore: tokensBefore / contextWindow,
			ratioAfter: tokensAfter / contextWindow,
			durationMs,
		},
	});
}

/** Emit a token estimation debug event. */
export function emitTokenEstimation(
	sessionId: string,
	contextWindow: number,
	estimatedTokens: number,
	messageCount: number,
	hasUsageData: boolean,
): void {
	if (!sessionId) return;
	emit({
		type: "token_estimation",
		event: {
			timestamp: Date.now(),
			sessionId,
			contextWindow,
			estimatedTokens,
			messageCount,
			hasUsageData,
		},
	});
}

/** Emit a compaction event. */
export function emitCompaction(event: {
	sessionId: string;
	reason: "manual" | "threshold" | "overflow";
	summaryTokensBefore: number;
	summaryTokensAfter: number;
	keptRecentTokens: number;
	droppedMessages: number;
	compactTemplateUsed: boolean;
	doubleCompactTriggered: boolean;
	durationMs: number;
}): void {
	emit({
		type: "compaction",
		event: {
			timestamp: Date.now(),
			...event,
		},
	});
}

/** Emit a compaction quality metrics event. */
export function emitCompactionQuality(event: {
	sessionId: string;
	compressionRatio: number; // outputTokens / inputTokens
	keyItemRetention: number; // keptKeyItems / totalKeyItems (of previous summary)
	structurePreservation: number; // sectionsPreserved / totalSections
	anchorRetention: number; // anchorsPreserved / totalAnchors
	requiredSectionRetention: number;
	userConstraintRetention: number;
	nextStepRetention: number;
	criticalAnchorCount: number;
	lostCriticalAnchorCount: number;
	restoredCriticalAnchorCount: number;
	compactTemplateUsed: boolean;
	doubleCompactTriggered: boolean;
}): void {
	emit({
		type: "compaction_quality",
		event: {
			timestamp: Date.now(),
			...event,
		},
	});
}
