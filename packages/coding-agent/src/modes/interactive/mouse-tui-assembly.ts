/**
 * Pure mapping from the mouseUI setting to InteractiveMode TUI construction options.
 * Keeps assembly rules out of the large InteractiveMode constructor so they stay testable.
 */
export interface MouseTuiAssembly {
	/** ProcessTerminal: enable SGR mouse reporting + alt-screen default. */
	enableMouse: boolean;
	/** TUI: app-managed scroll viewport. */
	appScroll: boolean;
	/** TUI: horizontal page margin when app-scroll is on (Pix default: 2). */
	marginX: number;
	/**
	 * OSC 133 prompt-zone markers are only meaningful on the primary screen.
	 * Mouse UI uses the alternate screen, where they desync differential rendering.
	 */
	oscPromptZonesEnabled: boolean;
	/** Attach TUI onSelectionCopy for app-managed drag selection. */
	attachSelectionCopy: boolean;
}

export function resolveMouseTuiAssembly(mouseUI: boolean): MouseTuiAssembly {
	return {
		enableMouse: mouseUI,
		appScroll: mouseUI,
		marginX: mouseUI ? 2 : 0,
		oscPromptZonesEnabled: !mouseUI,
		attachSelectionCopy: mouseUI,
	};
}
