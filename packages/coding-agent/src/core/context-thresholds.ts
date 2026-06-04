/**
 * Centralized context-window pressure thresholds.
 *
 * As context usage (estimated tokens / model context window) climbs, three
 * passes engage in a fixed order, each more destructive than the last:
 *
 *   AGING_START_RATIO (0.5)        aging begins — old tool results lose detail
 *   STALE_PRUNE_START_RATIO (0.65) stale-read pruning begins — superseded
 *                                  results are stubbed out
 *   compaction threshold           summarize-and-drop history (model-specific:
 *                                  (window - reserve) / window, >= 0.75 after
 *                                  resolveCompactionSettings clamps reserve to
 *                                  <= 0.25 * window)
 *
 * ORDERING INVARIANT (must hold, least to most destructive):
 *   AGING_START_RATIO < STALE_PRUNE_START_RATIO < compaction threshold
 *
 * Keeping these in one place makes the ordering auditable; if you change one,
 * re-check the invariant. The aging escalation ratios (medium/heavy) and the
 * edit-argument compaction ratio sit between stale-start and compaction.
 */

/** Context ratio at/above which tool-result aging begins (lightest level). */
export const AGING_START_RATIO = 0.5;
/** Context ratio at/above which aging escalates from light to medium. */
export const AGING_MEDIUM_RATIO = 0.7;
/** Context ratio at/above which aging escalates from medium to heavy. */
export const AGING_HEAVY_RATIO = 0.8;
/** Context ratio at/above which large edit/write arguments are compacted. */
export const EDIT_ARGS_COMPACT_RATIO = 0.7;
/** Context ratio at/above which stale-read pruning runs. */
export const STALE_PRUNE_START_RATIO = 0.65;

/** Minimum text length (chars) of a result before aging is worth it. */
export const MIN_AGING_CHARS = 800;
/** Minimum text length (chars) of a result before stale-stubbing is worth it. */
export const MIN_STALE_RESULT_CHARS = 600;
