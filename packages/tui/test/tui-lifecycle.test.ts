import assert from "node:assert";
import { describe, it } from "node:test";
import type { Terminal } from "../src/terminal.ts";
import { TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class CountingTerminal extends VirtualTerminal {
	startCalls = 0;
	stopCalls = 0;

	override start(onInput: (data: string) => void, onResize: () => void): void {
		this.startCalls++;
		super.start(onInput, onResize);
	}

	override stop(): void {
		this.stopCalls++;
		super.stop();
	}
}

describe("TUI lifecycle", () => {
	it("does not start an already running terminal twice", () => {
		const terminal: Terminal & CountingTerminal = new CountingTerminal();
		const tui = new TUI(terminal);

		tui.start();
		tui.start();
		assert.strictEqual(terminal.startCalls, 1);

		tui.stop();
		tui.start();
		assert.strictEqual(terminal.startCalls, 2);
		tui.stop();
	});
});
