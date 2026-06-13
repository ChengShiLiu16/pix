import assert from "node:assert";
import { describe, it } from "node:test";
import { type Component, TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class TestComponent implements Component {
	lines: string[] = [];
	render(_width: number): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

function makeLines(n: number): string[] {
	return Array.from({ length: n }, (_, i) => `L${i}`);
}

// SGR wheel sequences (coords irrelevant for scrolling).
const WHEEL_UP = "\x1b[<64;1;1M";
const WHEEL_DOWN = "\x1b[<65;1;1M";

describe("TUI app-managed scroll", () => {
	it("pins to the bottom window when content exceeds the viewport", async () => {
		const term = new VirtualTerminal(10, 5);
		const tui = new TUI(term, false, { appScroll: true });
		const c = new TestComponent();
		c.lines = makeLines(10);
		tui.addChild(c);
		tui.start();
		await term.waitForRender();

		const view = (await term.flushAndGetViewport()).map((l) => l.trim());
		// 10 lines, height 5 -> bottom window is L5..L9
		assert.deepStrictEqual(view, ["L5", "L6", "L7", "L8", "L9"]);
		tui.stop();
	});

	it("scrolls toward older content on wheel up and clamps at the top", async () => {
		const term = new VirtualTerminal(10, 5);
		const tui = new TUI(term, false, { appScroll: true });
		const c = new TestComponent();
		c.lines = makeLines(10);
		tui.addChild(c);
		tui.start();
		await term.waitForRender();

		term.sendInput(WHEEL_UP); // step 3 -> offset 3 -> top = 5-3 = 2 -> L2..L6
		await term.waitForRender();
		let view = (await term.flushAndGetViewport()).map((l) => l.trim());
		assert.deepStrictEqual(view, ["L2", "L3", "L4", "L5", "L6"]);

		term.sendInput(WHEEL_UP); // offset 6 clamped to maxOffset 5 -> top 0 -> L0..L4
		await term.waitForRender();
		view = (await term.flushAndGetViewport()).map((l) => l.trim());
		assert.deepStrictEqual(view, ["L0", "L1", "L2", "L3", "L4"]);
		tui.stop();
	});

	it("scrolls back to the bottom on wheel down", async () => {
		const term = new VirtualTerminal(10, 5);
		const tui = new TUI(term, false, { appScroll: true });
		const c = new TestComponent();
		c.lines = makeLines(10);
		tui.addChild(c);
		tui.start();
		await term.waitForRender();

		tui.scrollBy(5); // jump to top
		await term.waitForRender();
		term.sendInput(WHEEL_DOWN); // -3 -> offset 2 -> top 3 -> L3..L7
		await term.waitForRender();
		let view = (await term.flushAndGetViewport()).map((l) => l.trim());
		assert.deepStrictEqual(view, ["L3", "L4", "L5", "L6", "L7"]);

		term.sendInput(WHEEL_DOWN); // -3 -> offset 0 -> bottom L5..L9
		await term.waitForRender();
		view = (await term.flushAndGetViewport()).map((l) => l.trim());
		assert.deepStrictEqual(view, ["L5", "L6", "L7", "L8", "L9"]);
		tui.stop();
	});

	it("stays pinned to the bottom as new content arrives", async () => {
		const term = new VirtualTerminal(10, 5);
		const tui = new TUI(term, false, { appScroll: true });
		const c = new TestComponent();
		c.lines = makeLines(6);
		tui.addChild(c);
		tui.start();
		await term.waitForRender();

		c.lines = makeLines(12); // grow content while pinned
		tui.requestRender();
		await term.waitForRender();
		const view = (await term.flushAndGetViewport()).map((l) => l.trim());
		assert.deepStrictEqual(view, ["L7", "L8", "L9", "L10", "L11"]);
		tui.stop();
	});

	it("pages up and down with PageUp/PageDown", async () => {
		const term = new VirtualTerminal(10, 5);
		const tui = new TUI(term, false, { appScroll: true });
		const c = new TestComponent();
		c.lines = makeLines(10);
		tui.addChild(c);
		tui.start();
		await term.waitForRender();

		term.sendInput("\x1b[5~"); // PageUp: page = 5-2 = 3 -> L2..L6
		await term.waitForRender();
		let view = (await term.flushAndGetViewport()).map((l) => l.trim());
		assert.deepStrictEqual(view, ["L2", "L3", "L4", "L5", "L6"]);

		term.sendInput("\x1b[6~"); // PageDown: back to bottom L5..L9
		await term.waitForRender();
		view = (await term.flushAndGetViewport()).map((l) => l.trim());
		assert.deepStrictEqual(view, ["L5", "L6", "L7", "L8", "L9"]);
		tui.stop();
	});

	it("shows ▲/▼ scroll indicators in the margin when content is off-screen", async () => {
		const term = new VirtualTerminal(10, 5);
		const tui = new TUI(term, false, { appScroll: true, marginX: 1 });
		const c = new TestComponent();
		c.lines = makeLines(10);
		tui.addChild(c);
		tui.start();
		await term.waitForRender();

		// Pinned to bottom: content hidden above -> ▲ on top row, no ▼ at bottom.
		let view = await term.flushAndGetViewport();
		assert.ok(view[0].includes("▲"), "expected ▲ on top row when content is above");
		assert.ok(!view[4].includes("▼"), "expected no ▼ when pinned to bottom");

		// Scroll up into the middle: content hidden both ways -> ▲ and ▼.
		tui.scrollBy(3);
		await term.waitForRender();
		view = await term.flushAndGetViewport();
		assert.ok(view[0].includes("▲"), "expected ▲ when content is above");
		assert.ok(view[4].includes("▼"), "expected ▼ when content is below");
		tui.stop();
	});

	it("does not scroll when appScroll is disabled", async () => {
		const term = new VirtualTerminal(10, 5);
		const tui = new TUI(term, false); // default: no app scroll
		const c = new TestComponent();
		c.lines = makeLines(4);
		tui.addChild(c);
		tui.start();
		await term.waitForRender();
		// scrollBy is a no-op; viewport reflects the natural bottom of content
		tui.scrollBy(3);
		await term.waitForRender();
		const view = (await term.flushAndGetViewport()).map((l) => l.trim()).filter(Boolean);
		assert.deepStrictEqual(view, ["L0", "L1", "L2", "L3"]);
		tui.stop();
	});
});

describe("TUI click hit-testing", () => {
	class ClickBlock implements Component {
		clicks: Array<{ localY: number; x: number }> = [];
		n: number;
		constructor(n: number) {
			this.n = n;
		}
		render(_width: number): string[] {
			return Array.from({ length: this.n }, (_, i) => `B${i}`);
		}
		handleMouse(evt: { x: number }, localY: number): void {
			this.clicks.push({ localY, x: evt.x });
		}
		invalidate(): void {}
	}

	function clickAt(row0: number, col0: number): string {
		// SGR release (lowercase m), coords are 1-based.
		return `\x1b[<0;${col0 + 1};${row0 + 1}m`;
	}

	it("routes a click to the owning component with the correct localY", async () => {
		const term = new VirtualTerminal(10, 6);
		const tui = new TUI(term, false, { appScroll: true });
		const head = new TestComponent();
		head.lines = ["H0", "H1"]; // rows 0..1
		const block = new ClickBlock(3); // rows 2..4
		tui.addChild(head);
		tui.addChild(block);
		tui.start();
		await term.waitForRender();

		term.sendInput(clickAt(3, 4)); // screen row 3 -> inside block, localY 1
		await term.waitForRender();
		assert.deepStrictEqual(block.clicks, [{ localY: 1, x: 4 }]);
		tui.stop();
	});

	it("does not route clicks that miss every mouse-aware component", async () => {
		const term = new VirtualTerminal(10, 6);
		const tui = new TUI(term, false, { appScroll: true });
		const head = new TestComponent();
		head.lines = ["H0", "H1"];
		const block = new ClickBlock(2); // rows 2..3
		tui.addChild(head);
		tui.addChild(block);
		tui.start();
		await term.waitForRender();

		term.sendInput(clickAt(0, 0)); // row 0 is head (not mouse-aware)
		await term.waitForRender();
		assert.deepStrictEqual(block.clicks, []);
		tui.stop();
	});

	it("maps clicks correctly after scrolling", async () => {
		const term = new VirtualTerminal(10, 4);
		const tui = new TUI(term, false, { appScroll: true });
		const head = new TestComponent();
		head.lines = ["H0", "H1", "H2", "H3"]; // rows 0..3
		const block = new ClickBlock(4); // rows 4..7
		tui.addChild(head);
		tui.addChild(block);
		tui.start();
		await term.waitForRender();
		// total 8 lines, height 4 -> bottom window rows 4..7 (all block)
		term.sendInput(clickAt(0, 2)); // screen row 0 -> fullLine 4 -> block localY 0
		await term.waitForRender();
		assert.deepStrictEqual(block.clicks, [{ localY: 0, x: 2 }]);
		tui.stop();
	});
});

describe("TUI expand anchoring", () => {
	class ExpandableBlock implements Component {
		expanded = false;
		collapsedN: number;
		expandedN: number;
		constructor(collapsedN: number, expandedN: number) {
			this.collapsedN = collapsedN;
			this.expandedN = expandedN;
		}
		render(_width: number): string[] {
			const n = this.expanded ? this.expandedN : this.collapsedN;
			const tag = this.expanded ? "E" : "C";
			return Array.from({ length: n }, (_, i) => `${tag}${i}`);
		}
		handleMouse(): void {
			this.expanded = !this.expanded;
		}
		invalidate(): void {}
	}

	const down = (x: number, y: number) => `\x1b[<0;${x + 1};${y + 1}M`;
	const up = (x: number, y: number) => `\x1b[<0;${x + 1};${y + 1}m`;

	it("keeps the clicked block pinned at its screen row when expanding", async () => {
		const term = new VirtualTerminal(10, 6);
		const tui = new TUI(term, false, { appScroll: true });
		const head = new TestComponent();
		head.lines = ["H0", "H1"]; // rows 0..1
		const block = new ExpandableBlock(2, 6); // starts at full index 2
		tui.addChild(head);
		tui.addChild(block);
		tui.start();
		await term.waitForRender();

		// Click (down+up, no movement) on the block's first line at screen row 2.
		term.sendInput(down(0, 2));
		term.sendInput(up(0, 2));
		await term.waitForRender();

		const view = (await term.flushAndGetViewport()).map((l) => l.trim());
		// Anchored: head still visible at top, block header stays at row 2.
		assert.strictEqual(view[0], "H0");
		assert.strictEqual(view[2], "E0");
		tui.stop();
	});
});

describe("TUI app-managed selection", () => {
	const down = (x: number, y: number) => `\x1b[<0;${x + 1};${y + 1}M`;
	const move = (x: number, y: number) => `\x1b[<32;${x + 1};${y + 1}M`;
	const up = (x: number, y: number) => `\x1b[<0;${x + 1};${y + 1}m`;

	it("copies the dragged text on release", async () => {
		const term = new VirtualTerminal(20, 6);
		const tui = new TUI(term, false, { appScroll: true });
		let copied: string | null = null;
		tui.onSelectionCopy = (t) => {
			copied = t;
		};
		const c = new TestComponent();
		c.lines = ["Hello world", "Second line"];
		tui.addChild(c);
		tui.start();
		await term.waitForRender();

		term.sendInput(down(0, 0));
		term.sendInput(move(5, 0));
		await term.waitForRender();
		term.sendInput(up(5, 0));
		await term.waitForRender();
		assert.strictEqual(copied, "Hello");
		tui.stop();
	});

	it("copies across multiple lines", async () => {
		const term = new VirtualTerminal(20, 6);
		const tui = new TUI(term, false, { appScroll: true });
		let copied: string | null = null;
		tui.onSelectionCopy = (t) => {
			copied = t;
		};
		const c = new TestComponent();
		c.lines = ["Hello world", "Second line"];
		tui.addChild(c);
		tui.start();
		await term.waitForRender();

		term.sendInput(down(6, 0));
		term.sendInput(move(6, 1));
		await term.waitForRender();
		term.sendInput(up(6, 1));
		await term.waitForRender();
		assert.strictEqual(copied, "world\nSecond");
		tui.stop();
	});

	it("offsets content by marginX and keeps selection columns aligned", async () => {
		const term = new VirtualTerminal(20, 4);
		const tui = new TUI(term, false, { appScroll: true, marginX: 2 });
		let copied: string | null = null;
		tui.onSelectionCopy = (t) => {
			copied = t;
		};
		const c = new TestComponent();
		c.lines = ["Hello world"];
		tui.addChild(c);
		tui.start();
		await term.waitForRender();

		// Content is shifted right by marginX (2 blank columns on the left).
		const view = await term.flushAndGetViewport();
		assert.ok(view[0].startsWith("  Hello"), `expected 2-space left margin, got ${JSON.stringify(view[0])}`);

		// A drag at screen columns 2..7 maps to content columns 0..5 -> "Hello".
		term.sendInput(down(2, 0));
		term.sendInput(move(7, 0));
		await term.waitForRender();
		term.sendInput(up(7, 0));
		await term.waitForRender();
		assert.strictEqual(copied, "Hello");
		tui.stop();
	});

	it("treats press+release without movement as a click, not a copy", async () => {
		const term = new VirtualTerminal(20, 6);
		const tui = new TUI(term, false, { appScroll: true });
		let copied: string | null = null;
		tui.onSelectionCopy = (t) => {
			copied = t;
		};
		const c = new TestComponent();
		c.lines = ["Hello world"];
		tui.addChild(c);
		tui.start();
		await term.waitForRender();

		term.sendInput(down(3, 0));
		term.sendInput(up(3, 0));
		await term.waitForRender();
		assert.strictEqual(copied, null);
		tui.stop();
	});
});
