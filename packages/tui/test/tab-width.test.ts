import assert from "node:assert";
import { describe, it } from "node:test";
import { extractSegments, sliceWithWidth, visibleWidth } from "../src/utils.ts";

describe("tab width accounting", () => {
	it("keeps slice helper widths consistent with visible width", () => {
		const text = "out 192M\t.pix/skill-tests/results-ha";
		const slice = sliceWithWidth(text, 0, 10, true);

		assert.strictEqual(slice.text, "out 192M");
		assert.strictEqual(slice.width, 8);
		assert.strictEqual(visibleWidth(slice.text), slice.width);
	});

	it("keeps overlay segment widths consistent with visible width", () => {
		const text = "out 192M\t.pix/skill-tests/results-ha";
		// The tab spans cols 8..10 and straddles beforeEnd=10, so it is dropped (the compositor pads
		// the half-covered cells); `before` keeps only the fully-contained "out 192M". This avoids the
		// old 1-column overlay shift where beforeWidth (11) overran beforeEnd (10).
		const segments = extractSegments(text, 10, 13, 10, true);

		assert.strictEqual(segments.before, "out 192M");
		assert.strictEqual(segments.beforeWidth, 8);
		assert.strictEqual(visibleWidth(segments.before), segments.beforeWidth);
	});

	it("excludes a wide grapheme straddling the before/overlay boundary", () => {
		// "你" (width 2) occupies cols 1..2 and straddles beforeEnd=2. It must NOT be folded into
		// `before` (which would inflate beforeWidth to 3 and shift the overlay one column right);
		// the compositor fills that half-covered cell with padding instead.
		const segments = extractSegments("a你bc", 2, 2, 2, true);

		assert.strictEqual(segments.before, "a");
		assert.strictEqual(segments.beforeWidth, 1);
		assert.strictEqual(visibleWidth(segments.before), segments.beforeWidth);
	});
});
