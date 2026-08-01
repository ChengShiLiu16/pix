/**
 * Centralized context-window pressure thresholds.
 *
 * As context usage (estimated tokens / model context window) climbs, three
 * passes engage in a fixed order, each more destructive than the last:
 *
 *   AGING_START_RATIO (0.62)       aging begins — old tool results lose detail
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

/**
 * Context ratio at/above which tool-result aging begins (lightest level).
 *
 * Deliberately close to STALE_PRUNE_START_RATIO. Aging rewrites history, which
 * invalidates the provider prefix cache from the rewrite point (see
 * context-continuity.ts). Below this ratio the token savings almost never repay
 * the one-off cache miss, so starting earlier costs money without buying
 * headroom. The cache gate is the hard enforcement; this ratio just avoids
 * doing the work at all when it is certain to be rejected.
 */
export const AGING_START_RATIO = ratio(0.62);
/** Context ratio at/above which stale-read pruning runs. */
export const STALE_PRUNE_START_RATIO = ratio(0.65);
/** Context ratio at/above which aging escalates from light to medium. */
export const AGING_MEDIUM_RATIO = ratio(0.68);
/** Context ratio at/above which large edit/write arguments are compacted. */
export const EDIT_ARGS_COMPACT_RATIO = ratio(0.7);
/** Context ratio at/above which aging escalates from medium to heavy. */
export const AGING_HEAVY_RATIO = ratio(0.7);

/** Gap between heavy aging threshold and compaction threshold to prevent thrashing. */
export const HEAVY_AGING_COMPACTION_GAP = ratio(0.05);

/** Minimum compaction threshold after resolveCompactionSettings clamps reserve <= 0.25 * window. */
export const COMPACTION_THRESHOLD_MIN = ratio(0.75);

// ---------------------------------------------------------------------------
// Prefix-cache economics
// ---------------------------------------------------------------------------
//
// Providers cache the prompt as one contiguous prefix and bill matching tokens
// at a fraction of the base input price. Rewriting a message that was part of
// the previous request's cached prefix invalidates everything from that point
// on. The cost of that break depends on the provider's cache pricing, which
// differs by protocol:
//
//   Anthropic (anthropic-messages, explicit cache_control):
//     hits at CACHE_READ price, freshly written entries at a premium
//     (CACHE_WRITE price). A break re-bills the suffix at the write price.
//
//   OpenAI-style auto caching (openai-completions / openai-responses):
//     hits are billed from the model's `cacheRead` rate and writes are NOT
//     billed separately (`cacheWrite` is 0 in the model metadata). A break
//     re-bills the suffix at the full input price once; the auto cache then
//     re-arms for free, so there is no per-request write premium.
//
// Per request, with suffix S (tokens re-sent because of the break) and R tokens
// removed by the rewrite:
//   keep:    readPrice  * S
//   rewrite: writePrice * (S - R)
// so the immediate extra cost is `(writePrice - readPrice) * S - writePrice * R`,
// and every later request that reuses the new prefix saves `readPrice * R`.
// Over a horizon of N later requests the rewrite pays for itself when
//   R >= (writePrice - readPrice) * S / (writePrice + readPrice * N).

/**
 * Cache pricing semantics for one provider, derived from the model's cost
 * metadata (rates.cacheRead / rates.input) and the usage the provider reports.
 *
 * The multipliers are ratios over the base input price:
 *   readMultiplier  - price of a cache-hit token (0.1 for Anthropic, model
 *                     specific for OpenAI-style auto caching, e.g. 0.17 for
 *                     opencode-go kimi-k2.6).
 *   writeMultiplier - price of freshly written cache tokens. Anthropic bills
 *                     writes at a premium (1.25); OpenAI-style auto caching
 *                     does not bill writes separately, so the break re-bills
 *                     the suffix at full input price (1.0).
 */
export interface CacheSemantics {
	/** Cache category driving the gate's arithmetic. */
	kind: "anthropic" | "auto" | "none";
	readMultiplier: number;
	writeMultiplier: number;
}

/** Anthropic explicit-prefix-cache pricing: hits cheap, writes at a premium. */
export const ANTHROPIC_CACHE_SEMANTICS: CacheSemantics = {
	kind: "anthropic",
	readMultiplier: 0.1,
	writeMultiplier: 1.25,
};

/**
 * OpenAI-style automatic prefix caching: hits at the model's cacheRead rate,
 * writes not billed separately (suffix re-billed at full input price on break).
 */
export const OPENAI_AUTO_CACHE_SEMANTICS: CacheSemantics = {
	kind: "auto",
	readMultiplier: 0.5,
	writeMultiplier: 1,
};

/** No prefix caching: rewrites are unconditional wins, the gate is disabled. */
export const NO_CACHE_SEMANTICS: CacheSemantics = {
	kind: "none",
	readMultiplier: 1,
	writeMultiplier: 1,
};

/**
 * How many subsequent requests are assumed to reuse a freshly written prefix.
 * Conservative on purpose: a rewrite that only pays off after a very long tail
 * of future requests is not worth the immediate premium, since compaction or a
 * new user turn may invalidate the prefix first.
 */
export const CACHE_BREAK_REUSE_HORIZON = 8;
/**
 * Distance below the compaction threshold at which the cache gate switches to
 * "relief" mode. Inside this band the alternative to rewriting is compaction —
 * a full summarization request plus a total cache reset plus information loss —
 * so almost any rewrite is cheaper than doing nothing.
 */
export const CACHE_GATE_RELIEF_MARGIN = ratio(0.05);
/** Savings floor in relief mode; below this a cache break is never worth it. */
export const CACHE_GATE_MIN_SAVED_TOKENS = 512;

/**
 * Tokens a rewrite must remove to justify breaking the prefix cache at a point
 * with `brokenSuffixTokens` cached tokens after it.
 *
 * The arithmetic follows the provider's cache pricing (see CacheSemantics): a
 * rewrite inside the cached region re-bills the suffix at `writeMultiplier`
 * instead of `readMultiplier`, and each removed token is never re-sent again,
 * saving `writeMultiplier` now plus `readMultiplier` per later request.
 *
 * @param brokenSuffixTokens - Previously cached tokens invalidated by the break.
 * @param semantics - Provider cache pricing; defaults to Anthropic semantics.
 * @param horizon - Expected number of later requests reusing the new prefix.
 */
export function requiredSavingsForCacheBreak(
	brokenSuffixTokens: number,
	semantics: CacheSemantics = ANTHROPIC_CACHE_SEMANTICS,
	horizon: number = CACHE_BREAK_REUSE_HORIZON,
): number {
	if (brokenSuffixTokens <= 0 || semantics.kind === "none") return 0;
	const immediatePremium = semantics.writeMultiplier - semantics.readMultiplier;
	const perTokenPayoff = semantics.writeMultiplier + semantics.readMultiplier * Math.max(0, horizon);
	return Math.ceil((immediatePremium * brokenSuffixTokens) / perTokenPayoff);
}

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
