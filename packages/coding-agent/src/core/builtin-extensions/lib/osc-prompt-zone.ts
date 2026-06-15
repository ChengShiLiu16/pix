// OSC 133 "semantic prompt" zone markers. These let a real terminal's shell
// integration recognize prompt/output regions (jump-to-prompt, copy-last-command,
// scrollback marks). They are only meaningful on the PRIMARY screen.
//
// When the TUI owns the ALTERNATE screen (mouse UI / app-managed scrolling), the
// terminal still acts on these markers — drawing prompt-gutter decorations and/or
// nudging the cursor on the marked rows. Because the app drives the screen with
// relative cursor moves, that desyncs row positioning: bordered rows visually
// misalign (the `╭─`/`╰─` rows drift relative to the `│` rows) and repeated
// redraws during selection accumulate stale cells. So we suppress them on the
// alternate screen and keep them only for inline (primary-screen) rendering.

export const OSC133_ZONE_START = "\x1b]133;A\x07";
export const OSC133_ZONE_END = "\x1b]133;B\x07";
export const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

let zonesEnabled = true;

/** Enable/disable embedding OSC 133 prompt-zone markers in message output. */
export function setOscPromptZonesEnabled(enabled: boolean): void {
	zonesEnabled = enabled;
}

/** Whether OSC 133 prompt-zone markers are currently emitted. */
export function oscPromptZonesEnabled(): boolean {
	return zonesEnabled;
}

/**
 * Prepend the prompt-start marker to the first line and the prompt-end +
 * output-start markers to the last line. No-op when disabled or empty.
 */
export function wrapOscPromptZone(lines: string[]): string[] {
	if (!zonesEnabled || lines.length === 0) return lines;
	const out = [...lines];
	out[0] = `${OSC133_ZONE_START}${out[0]}`;
	out[out.length - 1] = `${OSC133_ZONE_END}${OSC133_ZONE_FINAL}${out[out.length - 1]}`;
	return out;
}
