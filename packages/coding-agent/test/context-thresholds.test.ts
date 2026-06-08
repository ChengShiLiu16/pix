import { describe, expect, it } from "vitest";
import {
	AGING_HEAVY_RATIO,
	AGING_MEDIUM_RATIO,
	AGING_START_RATIO,
	COMPACTION_THRESHOLD_MIN,
	EDIT_ARGS_COMPACT_RATIO,
	getEffectiveHeavyAgingThreshold,
	HEAVY_AGING_COMPACTION_GAP,
	STALE_PRUNE_START_RATIO,
} from "../src/core/context-thresholds.ts";

describe("context thresholds", () => {
	it("keeps context optimizations ordered before compaction", () => {
		expect(AGING_START_RATIO).toBeLessThan(STALE_PRUNE_START_RATIO);
		expect(STALE_PRUNE_START_RATIO).toBeLessThan(AGING_MEDIUM_RATIO);
		expect(AGING_MEDIUM_RATIO).toBeLessThanOrEqual(EDIT_ARGS_COMPACT_RATIO);
		expect(EDIT_ARGS_COMPACT_RATIO).toBeLessThanOrEqual(AGING_HEAVY_RATIO);
		expect(AGING_HEAVY_RATIO).toBeLessThan(COMPACTION_THRESHOLD_MIN);
		expect(AGING_HEAVY_RATIO + HEAVY_AGING_COMPACTION_GAP).toBeLessThanOrEqual(COMPACTION_THRESHOLD_MIN);
	});

	it("keeps the effective heavy-aging threshold below compaction", () => {
		const threshold = getEffectiveHeavyAgingThreshold(200000, 20000);
		const compactionThreshold = 1 - 20000 / 200000;

		expect(threshold).toBeGreaterThanOrEqual(AGING_HEAVY_RATIO);
		expect(threshold).toBeLessThan(compactionThreshold);
		expect(threshold + HEAVY_AGING_COMPACTION_GAP).toBeLessThanOrEqual(compactionThreshold);
	});
});
