/**
 * Tests for SGR (1006) mouse sequence parsing.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { parseMouse } from "../src/keys.ts";

describe("parseMouse", () => {
	it("returns null for non-mouse input", () => {
		assert.strictEqual(parseMouse("a"), null);
		assert.strictEqual(parseMouse("\x1b[A"), null); // arrow up
		assert.strictEqual(parseMouse("\x1b[<u"), null); // kitty disable
		assert.strictEqual(parseMouse(""), null);
	});

	it("parses a left-button press and converts to 0-based coords", () => {
		const e = parseMouse("\x1b[<0;20;5M");
		assert.ok(e);
		assert.strictEqual(e.action, "down");
		assert.strictEqual(e.button, "left");
		assert.strictEqual(e.x, 19);
		assert.strictEqual(e.y, 4);
		assert.strictEqual(e.wheel, undefined);
		assert.strictEqual(e.shift, false);
		assert.strictEqual(e.ctrl, false);
		assert.strictEqual(e.alt, false);
	});

	it("parses a release (lowercase m) keeping the released button", () => {
		const e = parseMouse("\x1b[<0;20;5m");
		assert.ok(e);
		assert.strictEqual(e.action, "up");
		assert.strictEqual(e.button, "left");
	});

	it("parses middle and right buttons", () => {
		assert.strictEqual(parseMouse("\x1b[<1;1;1M")?.button, "middle");
		assert.strictEqual(parseMouse("\x1b[<2;1;1M")?.button, "right");
	});

	it("parses wheel up and down", () => {
		const up = parseMouse("\x1b[<64;10;10M");
		assert.strictEqual(up?.wheel, "up");
		assert.strictEqual(up?.button, "none");
		const down = parseMouse("\x1b[<65;10;10M");
		assert.strictEqual(down?.wheel, "down");
		assert.strictEqual(down?.button, "none");
	});

	it("parses horizontal wheel left/right distinctly from vertical", () => {
		// SGR wheel codes: 64=up, 65=down, 66=left, 67=right. Direction is the low TWO
		// bits — a regression here (cb & 1) misreads 66 as "up" and 67 as "down", which
		// turned diagonal trackpad scrolling into vertical jitter.
		assert.strictEqual(parseMouse("\x1b[<66;10;10M")?.wheel, "left");
		assert.strictEqual(parseMouse("\x1b[<67;10;10M")?.wheel, "right");
	});

	it("keeps direction across wheel modifiers (shift/ctrl)", () => {
		assert.strictEqual(parseMouse("\x1b[<68;1;1M")?.wheel, "up"); // 64 + shift(4)
		assert.strictEqual(parseMouse("\x1b[<81;1;1M")?.wheel, "down"); // 65 + ctrl(16)
		assert.strictEqual(parseMouse("\x1b[<70;1;1M")?.wheel, "left"); // 66 + shift(4)
	});

	it("parses motion (drag) as action move", () => {
		// 32 (motion) + 0 (left held)
		const e = parseMouse("\x1b[<32;3;3M");
		assert.strictEqual(e?.action, "move");
		assert.strictEqual(e?.button, "left");
	});

	it("decodes modifier bits (shift=4, alt=8, ctrl=16)", () => {
		// 0 (left) + 4 (shift) + 16 (ctrl) = 20
		const e = parseMouse("\x1b[<20;2;2M");
		assert.ok(e);
		assert.strictEqual(e.shift, true);
		assert.strictEqual(e.ctrl, true);
		assert.strictEqual(e.alt, false);
		assert.strictEqual(e.button, "left");
	});

	it("handles large coordinates beyond the legacy 223 limit", () => {
		const e = parseMouse("\x1b[<0;500;400M");
		assert.strictEqual(e?.x, 499);
		assert.strictEqual(e?.y, 399);
	});
});
