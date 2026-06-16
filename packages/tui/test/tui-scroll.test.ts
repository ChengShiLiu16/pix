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

class RecordingTerminal extends VirtualTerminal {
	writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}

	takeWrites(): string[] {
		const writes = this.writes;
		this.writes = [];
		return writes;
	}
}

function makeLines(n: number): string[] {
	return Array.from({ length: n }, (_, i) => `L${i}`);
}

// SGR wheel sequences (coords irrelevant for scrolling).
const WHEEL_UP = "\x1b[<64;1;1M";
const WHEEL_DOWN = "\x1b[<65;1;1M";
// Horizontal wheel — emitted by trackpads during diagonal gestures. Must NOT scroll vertically.
const WHEEL_LEFT = "\x1b[<66;1;1M";
const WHEEL_RIGHT = "\x1b[<67;1;1M";

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

		term.sendInput(WHEEL_UP); // step 4 -> top = 1 -> L1..L5
		await term.waitForRender();
		let view = (await term.flushAndGetViewport()).map((l) => l.trim());
		assert.deepStrictEqual(view, ["L1", "L2", "L3", "L4", "L5"]);

		for (let i = 0; i < 4; i++) {
			term.sendInput(WHEEL_UP);
			await term.waitForRender();
		}
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
		term.sendInput(WHEEL_DOWN); // -4 -> top 4 -> L4..L8
		await term.waitForRender();
		let view = (await term.flushAndGetViewport()).map((l) => l.trim());
		assert.deepStrictEqual(view, ["L4", "L5", "L6", "L7", "L8"]);

		for (let i = 0; i < 4; i++) {
			term.sendInput(WHEEL_DOWN);
			await term.waitForRender();
		}
		view = (await term.flushAndGetViewport()).map((l) => l.trim());
		assert.deepStrictEqual(view, ["L5", "L6", "L7", "L8", "L9"]);
		tui.stop();
	});

	it("renders wheel scrolling immediately when an output render is already queued", async () => {
		const term = new RecordingTerminal(10, 5);
		const tui = new TUI(term, false, { appScroll: true });
		const c = new TestComponent();
		c.lines = makeLines(10);
		tui.addChild(c);
		tui.start();
		await term.waitForRender();

		c.lines = makeLines(11);
		tui.requestRender();
		term.sendInput(WHEEL_UP);
		await new Promise<void>((resolve) => process.nextTick(resolve));
		await term.flush();

		const view = term.getViewport().map((l) => l.trim());
		assert.deepStrictEqual(view, ["L1", "L2", "L3", "L4", "L5"]);
		tui.stop();
	});

	it("ignores horizontal wheel events (no vertical jitter on diagonal scroll)", async () => {
		const term = new VirtualTerminal(10, 5);
		const tui = new TUI(term, false, { appScroll: true });
		const c = new TestComponent();
		c.lines = makeLines(10);
		tui.addChild(c);
		tui.start();
		await term.waitForRender();

		// Scroll up into history so any spurious vertical movement would be visible.
		tui.scrollBy(2);
		await term.waitForRender();
		let view = (await term.flushAndGetViewport()).map((l) => l.trim());
		assert.deepStrictEqual(view, ["L3", "L4", "L5", "L6", "L7"]);

		// The trackpad's lateral component (SGR 66/67) must not move the view up or down.
		for (const seq of [WHEEL_LEFT, WHEEL_RIGHT, WHEEL_LEFT, WHEEL_LEFT, WHEEL_RIGHT]) {
			term.sendInput(seq);
			await term.waitForRender();
		}
		view = (await term.flushAndGetViewport()).map((l) => l.trim());
		assert.deepStrictEqual(view, ["L3", "L4", "L5", "L6", "L7"], "horizontal wheel must not scroll vertically");
		tui.stop();
	});

	it("rate-limits same-frame wheel bursts from touchpads", async () => {
		const term = new VirtualTerminal(10, 5);
		const tui = new TUI(term, false, { appScroll: true });
		const c = new TestComponent();
		c.lines = makeLines(10);
		tui.addChild(c);
		tui.start();
		await term.waitForRender();

		term.sendInput(WHEEL_UP);
		term.sendInput(WHEEL_UP);
		await term.waitForRender();
		const view = (await term.flushAndGetViewport()).map((l) => l.trim());
		assert.deepStrictEqual(view, ["L1", "L2", "L3", "L4", "L5"]);
		tui.stop();
	});

	it("still scrolls every wheel event when spaced beyond the frame interval", async () => {
		const term = new VirtualTerminal(10, 5);
		const tui = new TUI(term, false, { appScroll: true });
		const c = new TestComponent();
		c.lines = makeLines(20);
		tui.addChild(c);
		tui.start();
		await term.waitForRender();

		// A sustained gesture (events spaced past the rate-limit window) must move
		// one wheel step per event — the throttle collapses same-frame bursts only, it
		// must not drop legitimate sustained scrolling.
		const gap = () => new Promise<void>((resolve) => setTimeout(resolve, 25));
		for (let i = 0; i < 3; i++) {
			term.sendInput(WHEEL_UP);
			await gap();
		}
		await term.waitForRender();
		const view = (await term.flushAndGetViewport()).map((l) => l.trim());
		assert.deepStrictEqual(view, ["L3", "L4", "L5", "L6", "L7"]);
		tui.stop();
	});

	it("uses a normal redraw for idle wheel scrolling at the bottom", async () => {
		const term = new RecordingTerminal(10, 5);
		const tui = new TUI(term, false, { appScroll: true, marginX: 1 });
		const c = new TestComponent();
		c.lines = makeLines(10);
		tui.addChild(c);
		tui.start();
		await term.waitForRender();
		term.takeWrites();

		term.sendInput(WHEEL_UP);
		await term.waitForRender();
		const data = term.takeWrites().join("");
		assert.ok(!data.includes("\x1b[1L") && !data.includes("\x1b[1M"), "expected no viewport shift when idle");
		const view = await term.flushAndGetViewport();
		assert.ok(view[0].includes("▲"), "expected upper indicator when older content remains above");
		assert.ok(view[4].includes("▼"), "expected lower indicator after a multi-line wheel step");
		tui.stop();
	});

	it("uses a viewport-shift fast path for queued output renders", async () => {
		const term = new RecordingTerminal(10, 5);
		const tui = new TUI(term, false, { appScroll: true });
		const c = new TestComponent();
		c.lines = makeLines(10);
		tui.addChild(c);
		tui.start();
		await term.waitForRender();
		term.takeWrites();

		tui.requestRender();
		term.sendInput(WHEEL_UP);
		await term.waitForRender();
		const upData = term.takeWrites().join("");
		const upClearLineCount = (upData.match(/\x1b\[2K/g) ?? []).length;
		assert.ok(upData.includes("\x1b[4L"), "expected insert-line viewport shift when revealing older content");
		assert.ok(upClearLineCount < term.rows, "expected not to repaint the whole viewport");
		const view = (await term.flushAndGetViewport()).map((l) => l.trim());
		assert.deepStrictEqual(view, ["L1", "L2", "L3", "L4", "L5"]);
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

	it("holds the scrolled-up view steady as new content appends below", async () => {
		const term = new VirtualTerminal(10, 8);
		const tui = new TUI(term, false, { appScroll: true });
		const c = new TestComponent();
		c.lines = makeLines(20);
		tui.addChild(c);
		tui.start();
		await term.waitForRender();

		// Scroll up to read history: top = maxTop(12) - 3 = 9 -> L9..L16.
		tui.scrollBy(3);
		await term.waitForRender();
		let view = (await term.flushAndGetViewport()).map((l) => l.trim()).filter(Boolean);
		assert.deepStrictEqual(view, ["L9", "L10", "L11", "L12", "L13", "L14", "L15", "L16"]);

		// Stream content below. The visible window must NOT drift upward.
		c.lines = makeLines(25);
		tui.requestRender();
		await term.waitForRender();
		view = (await term.flushAndGetViewport()).map((l) => l.trim()).filter(Boolean);
		assert.deepStrictEqual(view, ["L9", "L10", "L11", "L12", "L13", "L14", "L15", "L16"]);

		// And again — still anchored to the same absolute lines.
		c.lines = makeLines(40);
		tui.requestRender();
		await term.waitForRender();
		view = (await term.flushAndGetViewport()).map((l) => l.trim()).filter(Boolean);
		assert.deepStrictEqual(view, ["L9", "L10", "L11", "L12", "L13", "L14", "L15", "L16"]);
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

	it("reverts to normal redraw if a line contains a Kitty image", async () => {
		const term = new RecordingTerminal(10, 5);
		const tui = new TUI(term, false, { appScroll: true });
		const c = new TestComponent();
		// \x1b_G is the Kitty graphics protocol prefix. Put it at index 5 so it is visible in the viewport [5..9] initially.
		c.lines = ["L0", "L1", "L2", "L3", "L4", "\x1b_Gf=100;a=T;s=10;v=10;...\x1b\\", "L6", "L7", "L8", "L9"];
		tui.addChild(c);
		tui.start();
		await term.waitForRender();
		term.takeWrites();

		tui.requestRender();
		term.sendInput(WHEEL_UP);
		await term.waitForRender();
		const data = term.takeWrites().join("");
		assert.ok(
			!data.includes("\x1b[1L") && !data.includes("\x1b[1M"),
			"expected no viewport shift when Kitty image is present",
		);
		tui.stop();
	});

	it("reverts to normal redraw if scroll delta is greater than or equal to viewport height", async () => {
		const term = new RecordingTerminal(10, 5);
		const tui = new TUI(term, false, { appScroll: true });
		const c = new TestComponent();
		c.lines = makeLines(10);
		tui.addChild(c);
		tui.start();
		await term.waitForRender();
		term.takeWrites();

		// Scroll by 5 lines (which equals viewport height 5)
		tui.requestRender();
		tui.scrollBy(5);
		await term.waitForRender();
		const data = term.takeWrites().join("");
		assert.ok(
			!data.includes("\x1b[1L") && !data.includes("\x1b[1M"),
			"expected no viewport shift when delta >= height",
		);
		tui.stop();
	});

	it("reverts to normal redraw if an overlay is present", async () => {
		const term = new RecordingTerminal(10, 5);
		const tui = new TUI(term, false, { appScroll: true });
		const c = new TestComponent();
		c.lines = makeLines(10);
		tui.addChild(c);
		tui.start();
		await term.waitForRender();
		term.takeWrites();

		// Show an overlay
		const overlayComponent = new TestComponent();
		overlayComponent.lines = ["Overlay"];
		tui.showOverlay(overlayComponent);
		await term.waitForRender();
		term.takeWrites();

		tui.requestRender();
		term.sendInput(WHEEL_UP);
		await term.waitForRender();
		const data = term.takeWrites().join("");
		assert.ok(
			!data.includes("\x1b[1L") && !data.includes("\x1b[1M"),
			"expected no viewport shift when overlay is present",
		);
		tui.stop();
	});

	it("reverts to normal redraw if a selection is active", async () => {
		const term = new RecordingTerminal(20, 5);
		const tui = new TUI(term, false, { appScroll: true });
		const c = new TestComponent();
		c.lines = makeLines(10);
		tui.addChild(c);
		tui.start();
		await term.waitForRender();
		term.takeWrites();

		// Set selection active
		(tui as any).hasSelection = true;

		tui.requestRender();
		term.sendInput(WHEEL_UP);
		await term.waitForRender();
		const data = term.takeWrites().join("");
		assert.ok(
			!data.includes("\x1b[1L") && !data.includes("\x1b[1M"),
			"expected no viewport shift when selection is active",
		);
		tui.stop();
	});

	it("reverts to normal redraw if contents change significantly along with scroll", async () => {
		const term = new RecordingTerminal(10, 8); // height = 8
		const tui = new TUI(term, false, { appScroll: true });
		const c = new TestComponent();
		c.lines = makeLines(12);
		tui.addChild(c);
		tui.start();
		await term.waitForRender();
		term.takeWrites();

		// Scroll up AND simultaneously change almost all lines to something new
		tui.requestRender();
		c.lines = ["N0", "N1", "N2", "N3", "N4", "N5", "N6", "N7", "N8", "N9", "N10", "N11"];
		term.sendInput(WHEEL_UP);
		await term.waitForRender();
		const data = term.takeWrites().join("");
		assert.ok(
			!data.includes("\x1b[1L") && !data.includes("\x1b[1M"),
			"expected no viewport shift when content changed significantly",
		);
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

	it("routes clicks to mouse-aware overlays without routing through to the transcript", async () => {
		const term = new VirtualTerminal(20, 8);
		const tui = new TUI(term, false, { appScroll: true });
		const block = new ClickBlock(3);
		const overlay = new ClickBlock(2);
		tui.addChild(block);
		tui.start();
		tui.showOverlay(overlay, { width: 6, row: 2, col: 5 });
		await term.waitForRender();

		term.sendInput(clickAt(3, 7));
		await term.waitForRender();
		assert.deepStrictEqual(overlay.clicks, [{ localY: 1, x: 2 }]);
		assert.deepStrictEqual(block.clicks, []);

		term.sendInput(clickAt(0, 0));
		await term.waitForRender();
		assert.deepStrictEqual(block.clicks, []);
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

	it("keeps following the live bottom when expanding while pinned to bottom", async () => {
		const term = new VirtualTerminal(10, 6);
		const tui = new TUI(term, false, { appScroll: true });
		const head = new TestComponent();
		head.lines = ["H0", "H1"]; // rows 0..1
		const block = new ExpandableBlock(2, 6); // expands to 6 lines -> overflows 6-row viewport
		tui.addChild(head);
		tui.addChild(block);
		tui.start();
		await term.waitForRender();

		// Pinned to the live bottom: click expands the block. Because the user was
		// following the bottom, the view should keep following it (not anchor),
		// so the newest line of the expanded block stays visible.
		term.sendInput(down(0, 2));
		term.sendInput(up(0, 2));
		await term.waitForRender();

		const view = (await term.flushAndGetViewport()).map((l) => l.trim());
		// 8 lines total (H0,H1,E0..E5), height 6 -> bottom window is E0..E5.
		assert.strictEqual(view[view.length - 1], "E5", "expected newest expanded line pinned to bottom");
		assert.ok(view.includes("E5") && view.includes("E0"), "expected full expanded block visible at bottom");
		tui.stop();
	});

	it("anchors the clicked block at its screen row when scrolled up reading history", async () => {
		const term = new VirtualTerminal(10, 6);
		const tui = new TUI(term, false, { appScroll: true });
		const head = new TestComponent();
		head.lines = ["H0", "H1", "H2", "H3"]; // rows 0..3
		const block = new ExpandableBlock(2, 6); // collapsed at full index 4..5 (+nothing)
		const tail = new TestComponent();
		tail.lines = ["F0", "F1", "F2", "F3"]; // trailing content so we can scroll up off-bottom
		tui.addChild(head);
		tui.addChild(block);
		tui.addChild(tail);
		tui.start();
		await term.waitForRender();

		// Scroll up so we are NOT pinned to the bottom (reading history). Total
		// lines: 4 + 2 + 4 = 10, height 6 -> maxOffset 4. Scroll to the top.
		tui.scrollBy(4);
		await term.waitForRender();
		let view = (await term.flushAndGetViewport()).map((l) => l.trim());
		// Window top = 0: rows H0,H1,H2,H3,C0,C1. Block (collapsed) header C0 at row 4.
		assert.strictEqual(view[4], "C0");

		// Click the block's first line at screen row 4 -> expands; anchored at row 4.
		term.sendInput(down(0, 4));
		term.sendInput(up(0, 4));
		await term.waitForRender();
		view = (await term.flushAndGetViewport()).map((l) => l.trim());
		// Anchored: the block's top stays at screen row 4 (history above unchanged).
		assert.strictEqual(view[0], "H0");
		assert.strictEqual(view[4], "E0");
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
