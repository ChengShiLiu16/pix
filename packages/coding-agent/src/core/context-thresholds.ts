/**
 * Centralized context-window pressure thresholds.
 *
 * As context usage (estimated tokens / model context window) climbs, three
 * passes engage in a fixed order, each more destructive than the last:
 *
 *   AGING_START_RATIO (0.50)       aging begins — old tool results lose detail
 *   STALE_PRUNE_START_RATIO (0.65) stale-read pruning begins — superseded
 *                                  results are stubbed out
 *   AGING_MEDIUM_RATIO (0.68)      aging escalates from light to medium
 *   EDIT_ARGS_COMPACT_RATIO (0.70) large edit/write arguments are compacted
 *   AGING_HEAVY_RATIO (0.70)       aging escalates from medium to heavy
 *   compaction threshold           summarize-and-drop history (model-specific:
 *                                  (window - reserve) / window, >= 0.75 after
 *                                  resolveCompactionSettings clamps reserve to
 *                                  <= 0.25 * window)
 *
 * ORDERING INVARIANT (must hold, least to most destructive):
 *   AGING_START_RATIO < STALE_PRUNE_START_RATIO < AGING_MEDIUM_RATIO
 *   <= EDIT_ARGS_COMPACT_RATIO <= AGING_HEAVY_RATIO < COMPACTION_THRESHOLD_MIN
 *
 * The `<=` between EDIT_ARGS_COMPACT_RATIO and AGING_HEAVY_RATIO is deliberate:
 * they currently coincide at 0.70 and may co-engage. That is safe because they
 * act on disjoint content — edit/write argument bodies vs. tool-result text —
 * so neither depends on the other's ordering. They are kept as separate knobs
 * so either can be tuned independently later.
 *
 * HYSTERESIS GAP (must hold to prevent heavy aging / compaction thrashing):
 *   AGING_HEAVY_RATIO + HEAVY_AGING_COMPACTION_GAP <= COMPACTION_THRESHOLD_MIN
 *
 * Keeping these in one place makes the ordering auditable; if you change one,
 * re-check the invariants.
 */

/** Brand type for context ratios (0.0 - 1.0) to enable compile-time checks. */
type ContextRatio = number & { readonly __brand: unique symbol };

/** Create a validated ContextRatio. Throws if not in [0, 1]. */
function ratio(n: number): ContextRatio {
	if (n < 0 || n > 1) throw new Error(`Invalid context ratio: ${n}`);
	return n as ContextRatio;
}

/** Context ratio at/above which tool-result aging begins (lightest level). */
export const AGING_START_RATIO = ratio(0.5);
/** Context ratio at/above which stale-read pruning runs. */
export const STALE_PRUNE_START_RATIO = ratio(0.65);
/** Context ratio at/above which aging escalates from light to medium. */
export const AGING_MEDIUM_RATIO = ratio(0.68);
/** Context ratio at/above which large edit/write arguments are compacted. */
export const EDIT_ARGS_COMPACT_RATIO = ratio(0.7);
/** Context ratio at/above which aging escalates from medium to heavy. */
// Changed from 0.80 to 0.70 to ensure heavy aging triggers BEFORE compaction
// threshold (>=0.75), with hysteresis gap.
export const AGING_HEAVY_RATIO = ratio(0.7);

/** Gap between heavy aging threshold and compaction threshold to prevent thrashing. */
export const HEAVY_AGING_COMPACTION_GAP = ratio(0.05);

/** Minimum compaction threshold after resolveCompactionSettings clamps reserve <= 0.25 * window. */
export const COMPACTION_THRESHOLD_MIN = ratio(0.75);

/** Minimum text length (chars) of a result before aging is worth it. */
export const MIN_AGING_CHARS = 800;
/** Minimum text length (chars) of a result before stale-stubbing is worth it. */
export const MIN_STALE_RESULT_CHARS = 600;

/**
 * Runtime validation of threshold invariants.
 * Runs on module load; throws if any invariant is violated.
 */
function validateThresholdInvariants(): void {
	const t = {
		AGING_START_RATIO,
		AGING_MEDIUM_RATIO,
		AGING_HEAVY_RATIO,
		EDIT_ARGS_COMPACT_RATIO,
		STALE_PRUNE_START_RATIO,
		HEAVY_AGING_COMPACTION_GAP,
		COMPACTION_THRESHOLD_MIN,
	};

	const checks: Array<{ name: string; pass: boolean }> = [
		{ name: "AGING_START < STALE_PRUNE_START", pass: t.AGING_START_RATIO < t.STALE_PRUNE_START_RATIO },
		{ name: "STALE_PRUNE_START < AGING_MEDIUM", pass: t.STALE_PRUNE_START_RATIO < t.AGING_MEDIUM_RATIO },
		{ name: "AGING_MEDIUM <= EDIT_ARGS_COMPACT", pass: t.AGING_MEDIUM_RATIO <= t.EDIT_ARGS_COMPACT_RATIO },
		{ name: "EDIT_ARGS_COMPACT <= AGING_HEAVY", pass: t.EDIT_ARGS_COMPACT_RATIO <= t.AGING_HEAVY_RATIO },
		{ name: "AGING_HEAVY < COMPACTION_THRESHOLD_MIN", pass: t.AGING_HEAVY_RATIO < t.COMPACTION_THRESHOLD_MIN },
		{
			name: "AGING_HEAVY + GAP <= COMPACTION_THRESHOLD_MIN",
			pass: t.AGING_HEAVY_RATIO + t.HEAVY_AGING_COMPACTION_GAP <= t.COMPACTION_THRESHOLD_MIN,
		},
	];

	for (const c of checks) {
		if (!c.pass) {
			throw new Error(`Threshold invariant violated: ${c.name}`);
		}
	}
}

// Run validation on module init.
validateThresholdInvariants();

/**
 * Compute the effective heavy aging threshold with hysteresis gap.
 *
 * The compaction threshold is `1 - reserveTokens / contextWindow` (after
 * resolveCompactionSettings clamps reserveTokens <= 0.25 * contextWindow).
 * To prevent heavy aging and compaction from triggering simultaneously
 * (which causes thrashing), we keep heavy aging at least
 * HEAVY_AGING_COMPACTION_GAP below the compaction threshold.
 *
 * @param contextWindow - Model context window size
 * @param reserveTokens - Reserved tokens after clamping (from resolveCompactionSettings)
 * @returns Effective heavy aging threshold (ratio 0-1)
 */
export function getEffectiveHeavyAgingThreshold(contextWindow: number, reserveTokens: number): number {
	if (contextWindow <= 0) return AGING_HEAVY_RATIO;
	// Compaction triggers when tokens > window - reserveTokens
	// i.e., ratio > (window - reserveTokens) / window = 1 - reserveTokens/window
	const compactionThreshold = 1 - reserveTokens / contextWindow;
	// Heavy aging threshold = compactionThreshold - gap
	const heavyThreshold = compactionThreshold - HEAVY_AGING_COMPACTION_GAP;
	// Clamp to at least the static AGING_HEAVY_RATIO (0.70) and below compaction threshold
	return Math.min(Math.max(heavyThreshold, AGING_HEAVY_RATIO), compactionThreshold - 0.01);
}
