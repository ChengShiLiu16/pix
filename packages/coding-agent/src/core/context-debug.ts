/**
 * Lightweight, env-gated debug logging for context-window optimization.
 * Enable with PIX_CONTEXT_DEBUG=1. Off by default — zero overhead.
 *
 * This deliberately does NOT use the extension event system: the data is
 * internal telemetry for pending tuning decisions (how much aging actually
 * saves at a given ratio; how often the pre-compaction predictive optimize
 * averts a compaction), not something extensions should consume. It mirrors
 * the PIX_TIMING pattern in timings.ts.
 */

export const CONTEXT_DEBUG = process.env.PIX_CONTEXT_DEBUG === "1";

export function contextDebug(message: string): void {
	if (CONTEXT_DEBUG) console.error(`[context] ${message}`);
}
