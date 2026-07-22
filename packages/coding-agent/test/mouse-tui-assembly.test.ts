import { describe, expect, it } from "vitest";
import { resolveMouseTuiAssembly } from "../src/modes/interactive/mouse-tui-assembly.ts";

describe("resolveMouseTuiAssembly", () => {
	it("enables full mouse UI assembly when mouseUI is on", () => {
		expect(resolveMouseTuiAssembly(true)).toEqual({
			enableMouse: true,
			appScroll: true,
			marginX: 2,
			oscPromptZonesEnabled: false,
			attachSelectionCopy: true,
		});
	});

	it("matches upstream default construction when mouseUI is off", () => {
		expect(resolveMouseTuiAssembly(false)).toEqual({
			enableMouse: false,
			appScroll: false,
			marginX: 0,
			oscPromptZonesEnabled: true,
			attachSelectionCopy: false,
		});
	});
});
