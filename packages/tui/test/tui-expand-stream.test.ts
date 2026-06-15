import assert from "node:assert";
import { describe, it } from "node:test";
import { type Component, CURSOR_MARKER, TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

/**
 * Repro harness for: streaming output below while the user clicks to
 * expand/collapse tool blocks.
 *
 * Oracle: after any interleaving of streaming mutations and expand/collapse
 * clicks, the differentially-rendered screen MUST equal a from-scratch full
 * redraw of the identical current state. We capture the live viewport, force a
 * full redraw (force=true wipes previousLines), capture again, and compare.
 * Any divergence is a tearing / stale-row / cursor-drift bug.
 */

const RED = (s: string) => `\x1b[31m${s}\x1b[39m`;

class TextBlock implements Component {
	lines: string[] = [];
	render(_width: number): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

/** Bottom input box that emits a cursor marker + ANSI, like the real editor. */
class InputBox implements Component {
	text = "› ";
	render(_width: number): string[] {
		return [`${RED(this.text)}${CURSOR_MARKER}`];
	}
	invalidate(): void {}
}

/** Mimics ToolExecutionComponent: collapsed shows N preview lines + a button, with ANSI. */
class Expandable implements Component {
	expanded = false;
	private id: string;
	private collapsedN: number;
	private expandedN: number;
	constructor(id: string, collapsedN: number, expandedN: number) {
		this.id = id;
		this.collapsedN = collapsedN;
		this.expandedN = expandedN;
	}
	render(_width: number): string[] {
		if (this.expanded) {
			const body = Array.from({ length: this.expandedN }, (_, i) => RED(`${this.id}-E${i}`));
			return [...body, RED(`${this.id}-▾collapse`)];
		}
		const body = Array.from({ length: this.collapsedN }, (_, i) => RED(`${this.id}-C${i}`));
		return [...body, RED(`${this.id}-▸expand`)];
	}
	handleMouse(): void {
		this.expanded = !this.expanded;
	}
	invalidate(): void {}
}

const down = (x: number, y: number) => `\x1b[<0;${x + 1};${y + 1}M`;
const up = (x: number, y: number) => `\x1b[<0;${x + 1};${y + 1}m`;
const click = (term: VirtualTerminal, x: number, y: number): void => {
	term.sendInput(down(x, y));
	term.sendInput(up(x, y));
};

/** Capture live viewport, force a full redraw, capture again, assert identical. */
async function assertCoherent(term: VirtualTerminal, tui: TUI, label: string): Promise<void> {
	const live = (await term.flushAndGetViewport()).map((l) => l.trimEnd());
	tui.requestRender(true); // force=true: clears previousLines -> full redraw from scratch
	await term.waitForRender();
	const fresh = (await term.flushAndGetViewport()).map((l) => l.trimEnd());
	assert.deepStrictEqual(live, fresh, `differential vs full-redraw mismatch: ${label}`);
}

describe("TUI expand/collapse during streaming (coherence oracle)", () => {
	it("stays coherent expanding while tail streams (spaced renders)", async () => {
		const term = new VirtualTerminal(30, 10);
		const tui = new TUI(term, false, { appScroll: true });
		const head = new TextBlock();
		head.lines = [RED("H0"), RED("H1")];
		const block = new Expandable("A", 2, 8);
		const tail = new TextBlock();
		tail.lines = [RED("T0")];
		const input = new InputBox();
		tui.addChild(head);
		tui.addChild(block);
		tui.addChild(tail);
		tui.addChild(input);
		tui.setFocus(input as unknown as Component);
		tui.start();
		await term.waitForRender();

		tail.lines = [RED("T0"), RED("T1"), RED("T2")];
		tui.requestRender();
		await term.waitForRender();

		click(term, 0, 4); // expand the block
		await term.waitForRender();
		await assertCoherent(term, tui, "after expand");

		tail.lines = [RED("T0"), RED("T1"), RED("T2"), RED("T3"), RED("T4")];
		tui.requestRender();
		await term.waitForRender();
		await assertCoherent(term, tui, "after more streaming");
	});

	it("stays coherent under COALESCED streaming + click (no wait between)", async () => {
		const term = new VirtualTerminal(30, 10);
		const tui = new TUI(term, false, { appScroll: true });
		const head = new TextBlock();
		head.lines = [RED("H0")];
		const block = new Expandable("A", 3, 9);
		const tail = new TextBlock();
		tail.lines = [RED("T0")];
		const input = new InputBox();
		tui.addChild(head);
		tui.addChild(block);
		tui.addChild(tail);
		tui.addChild(input);
		tui.setFocus(input as unknown as Component);
		tui.start();
		await term.waitForRender();

		// Coalesced: mutate state AND click within the same throttle window,
		// without awaiting a render between them.
		for (let step = 0; step < 8; step++) {
			tail.lines = Array.from({ length: step + 2 }, (_, i) => RED(`T${i}`));
			tui.requestRender(); // schedules, does not run yet
			click(term, 0, 1); // click lands before the pending render fires
			// brief: let microtasks run but stay within throttle so renders coalesce
			await new Promise<void>((r) => process.nextTick(r));
		}
		await term.waitForRender();
		await assertCoherent(term, tui, "after coalesced stream+click loop");
	});

	it("stays coherent when content ABOVE the clicked block grows between renders", async () => {
		const term = new VirtualTerminal(30, 12);
		const tui = new TUI(term, false, { appScroll: true });
		const head = new TextBlock();
		head.lines = [RED("H0"), RED("H1")];
		const block = new Expandable("A", 2, 6);
		const input = new InputBox();
		tui.addChild(head);
		tui.addChild(block);
		tui.addChild(input);
		tui.setFocus(input as unknown as Component);
		tui.start();
		await term.waitForRender();

		// Grow the head (content above the block) and click the block in the same window.
		head.lines = [RED("H0"), RED("H1"), RED("H2"), RED("H3")];
		tui.requestRender();
		click(term, 0, 4); // click using pre-growth coords
		await term.waitForRender();
		await assertCoherent(term, tui, "after head growth + click");
	});

	it("keeps following the live bottom after expanding mid-stream", async () => {
		const term = new VirtualTerminal(20, 8);
		const tui = new TUI(term, false, { appScroll: true });
		const block = new Expandable("A", 2, 6);
		const tail = new TextBlock();
		tail.lines = [RED("T0"), RED("T1")];
		const input = new InputBox();
		tui.addChild(block);
		tui.addChild(tail);
		tui.addChild(input);
		tui.setFocus(input as unknown as Component);
		tui.start();
		await term.waitForRender();

		// Overflow + pinned to bottom: grow the tail so we are actively following.
		tail.lines = Array.from({ length: 12 }, (_, i) => RED(`T${i}`));
		tui.requestRender();
		await term.waitForRender();

		// Click to expand the block while following the live bottom.
		click(term, 0, 0);
		await term.waitForRender();

		// Stream a lot more after expanding.
		tail.lines = Array.from({ length: 30 }, (_, i) => RED(`T${i}`));
		tui.requestRender();
		await term.waitForRender();

		const view = (await term.flushAndGetViewport()).map((l) => l.trim()).filter(Boolean);
		// The newest line must remain visible — the view follows the stream, not frozen.
		assert.ok(view.includes("T29"), `expected newest line visible, got ${JSON.stringify(view)}`);
		await assertCoherent(term, tui, "follow-bottom after mid-stream expand");
		tui.stop();
	});

	it("toggles the block the user actually clicked, even as new blocks stream in", async () => {
		const term = new VirtualTerminal(30, 12);
		const tui = new TUI(term, false, { appScroll: true });
		const blockA = new Expandable("A", 2, 4);
		const tail = new TextBlock();
		tail.lines = [RED("T0")];
		const input = new InputBox();
		tui.addChild(blockA);
		tui.addChild(tail);
		tui.addChild(input);
		tui.setFocus(input as unknown as Component);
		tui.start();
		await term.waitForRender();

		// A new expandable streams in BELOW A (like a second tool call appearing).
		const blockB = new Expandable("B", 2, 4);
		tui.removeChild(tail);
		tui.addChild(blockB);
		tui.addChild(tail);
		tui.requestRender();
		await term.waitForRender();

		// A occupies rows 0..2 (C0,C1,▸expand). Click A's button at screen row 2.
		click(term, 0, 2);
		await term.waitForRender();

		assert.strictEqual(blockA.expanded, true, "clicked block A should expand");
		assert.strictEqual(blockB.expanded, false, "untouched block B must stay collapsed");
		await assertCoherent(term, tui, "after clicking A with B present");

		// Now B sits just below A's expanded body. Recompute and click B.
		const view = (await term.flushAndGetViewport()).map((l) => l.trim());
		const bRow = view.indexOf("B-▸expand");
		assert.ok(bRow >= 0, `expected B's expand button visible, got ${JSON.stringify(view)}`);
		click(term, 0, bRow);
		await term.waitForRender();
		assert.strictEqual(blockB.expanded, true, "clicking B's row should expand B");
		assert.strictEqual(blockA.expanded, true, "A stays expanded");
		tui.stop();
	});

	it("stays coherent through many rapid expand/collapse toggles", async () => {
		const term = new VirtualTerminal(30, 10);
		const tui = new TUI(term, false, { appScroll: true });
		const head = new TextBlock();
		head.lines = [RED("H0")];
		const block = new Expandable("A", 2, 12);
		const input = new InputBox();
		tui.addChild(head);
		tui.addChild(block);
		tui.addChild(input);
		tui.setFocus(input as unknown as Component);
		tui.start();
		await term.waitForRender();

		for (let i = 0; i < 10; i++) {
			click(term, 0, 1);
			await term.waitForRender();
			await assertCoherent(term, tui, `toggle ${i}`);
		}
	});
});
