/**
 * Minimal TUI implementation with differential rendering
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { isKeyRelease, type MouseEvent, matchesKey, parseMouse } from "./keys.ts";
import type { Terminal } from "./terminal.ts";
import {
	isOsc11BackgroundColorResponse,
	parseOsc11BackgroundColor,
	parseTerminalColorSchemeReport,
	type RgbColor,
	type TerminalColorScheme,
} from "./terminal-colors.ts";
import { deleteKittyImage, getCapabilities, isImageLine, setCellDimensions } from "./terminal-image.ts";
import {
	applyScopedStyle,
	dimLineToScrim,
	extractSegments,
	normalizeTerminalOutput,
	type ScrimOptions,
	sliceByColumn,
	sliceWithWidth,
	visibleWidth,
} from "./utils.ts";

/** Strip SGR color codes and OSC 8 hyperlink wrappers for plain-text extraction. */
function stripAnsiCodes(text: string): string {
	return text.replace(/\x1b\[[0-9;:]*m/g, "").replace(/\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
}

const KITTY_SEQUENCE_PREFIX = "\x1b_G";

interface KittyImageHeader {
	ids: number[];
	rows: number;
}

function parseKittyImageHeader(line: string): KittyImageHeader | undefined {
	const sequenceStart = line.indexOf(KITTY_SEQUENCE_PREFIX);
	if (sequenceStart === -1) return undefined;

	const paramsStart = sequenceStart + KITTY_SEQUENCE_PREFIX.length;
	const paramsEnd = line.indexOf(";", paramsStart);
	if (paramsEnd === -1) return undefined;

	const ids: number[] = [];
	let rows = 1;
	const params = line.slice(paramsStart, paramsEnd);
	for (const param of params.split(",")) {
		const [key, value] = param.split("=", 2);
		if (value === undefined) continue;
		const numberValue = Number(value);
		if (!Number.isInteger(numberValue) || numberValue <= 0 || numberValue > 0xffffffff) continue;
		if (key === "i") {
			ids.push(numberValue);
		} else if (key === "r") {
			rows = numberValue;
		}
	}
	return { ids, rows };
}

function extractKittyImageIds(line: string): number[] {
	return parseKittyImageHeader(line)?.ids ?? [];
}

function extractKittyImageRows(line: string): number {
	return parseKittyImageHeader(line)?.rows ?? 1;
}

/**
 * Component interface - all components must implement this
 */
export interface Component {
	/**
	 * Render the component to lines for the given viewport width
	 * @param width - Current viewport width
	 * @returns Array of strings, each representing a line
	 */
	render(width: number): string[];

	/**
	 * Optional handler for keyboard input when component has focus
	 */
	handleInput?(data: string): void;

	/**
	 * If true, component receives key release events (Kitty protocol).
	 * Default is false - release events are filtered out.
	 */
	wantsKeyRelease?: boolean;

	/**
	 * Optional handler for a mouse event whose target resolved to this component
	 * (app-managed scroll mode only). `localY` is the 0-based row within this
	 * component's own rendered output; `evt.x` is the 0-based column.
	 *
	 * Return `false` from a hover (move) event to signal "nothing changed, no
	 * repaint needed" — this keeps any-motion tracking from flooding renders.
	 */
	// biome-ignore lint/suspicious/noConfusingVoidType: most handlers return void; hover-aware ones return boolean to gate repaints
	handleMouse?(evt: MouseEvent, localY: number): void | boolean;

	/**
	 * Invalidate any cached rendering state.
	 * Called when theme changes or when component needs to re-render from scratch.
	 */
	invalidate(): void;
}

/** A component's line range within the full rendered content, for hit-testing. */
interface MouseHit {
	component: Component;
	start: number; // inclusive full-content line index
	end: number; // exclusive
}

interface OverlayMouseHit {
	component: Component;
	startRow: number;
	endRow: number;
	col: number;
	width: number;
}

function isMouseAware(c: Component | null): c is Component & { handleMouse: NonNullable<Component["handleMouse"]> } {
	return c !== null && typeof c.handleMouse === "function";
}

type InputListenerResult = { consume?: boolean; data?: string } | undefined;
type InputListener = (data: string) => InputListenerResult;
type PendingOsc11BackgroundQuery = {
	settled: boolean;
	resolve: ((rgb: RgbColor | undefined) => void) | undefined;
	timer: NodeJS.Timeout | undefined;
};

/**
 * Interface for components that can receive focus and display a hardware cursor.
 * When focused, the component should emit CURSOR_MARKER at the cursor position
 * in its render output. TUI will find this marker and position the hardware
 * cursor there for proper IME candidate window positioning.
 */
export interface Focusable {
	/** Set by TUI when focus changes. Component should emit CURSOR_MARKER when true. */
	focused: boolean;
}

/** Type guard to check if a component implements Focusable */
export function isFocusable(component: Component | null): component is Component & Focusable {
	return component !== null && "focused" in component;
}

/**
 * Cursor position marker - APC (Application Program Command) sequence.
 * This is a zero-width escape sequence that terminals ignore.
 * Components emit this at the cursor position when focused.
 * TUI finds and strips this marker, then positions the hardware cursor there.
 */
export const CURSOR_MARKER = "\x1b_pi:c\x07";

export { visibleWidth };

// Backdrop scrim: blends the screen toward black at opencode's RGBA(0,0,0,150)
// strength (factor = 1 - 150/255). Default-fg cells fade to a recessed gray;
// default-bg cells go to black so explicit background blocks stay faintly visible.
const BACKDROP_SCRIM: ScrimOptions = {
	factor: 1 - 150 / 255,
	defaultFg: [205, 205, 205],
	defaultBg: [0, 0, 0],
};

/**
 * Anchor position for overlays
 */
export type OverlayAnchor =
	| "center"
	| "top-left"
	| "top-right"
	| "bottom-left"
	| "bottom-right"
	| "top-center"
	| "bottom-center"
	| "left-center"
	| "right-center";

/**
 * Margin configuration for overlays
 */
export interface OverlayMargin {
	top?: number;
	right?: number;
	bottom?: number;
	left?: number;
}

/** Value that can be absolute (number) or percentage (string like "50%") */
export type SizeValue = number | `${number}%`;

/** Parse a SizeValue into absolute value given a reference size */
function parseSizeValue(value: SizeValue | undefined, referenceSize: number): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "number") return value;
	// Parse percentage string like "50%"
	const match = value.match(/^(\d+(?:\.\d+)?)%$/);
	if (match) {
		return Math.floor((referenceSize * parseFloat(match[1])) / 100);
	}
	return undefined;
}

function isTermuxSession(): boolean {
	return Boolean(process.env.TERMUX_VERSION);
}

/**
 * Options for overlay positioning and sizing.
 * Values can be absolute numbers or percentage strings (e.g., "50%").
 */
export interface OverlayOptions {
	// === Sizing ===
	/** Width in columns, or percentage of terminal width (e.g., "50%") */
	width?: SizeValue;
	/** Minimum width in columns */
	minWidth?: number;
	/** Maximum height in rows, or percentage of terminal height (e.g., "50%") */
	maxHeight?: SizeValue;

	// === Positioning - anchor-based ===
	/** Anchor point for positioning (default: 'center') */
	anchor?: OverlayAnchor;
	/** Horizontal offset from anchor position (positive = right) */
	offsetX?: number;
	/** Vertical offset from anchor position (positive = down) */
	offsetY?: number;

	// === Positioning - percentage or absolute ===
	/** Row position: absolute number, or percentage (e.g., "25%" = 25% from top) */
	row?: SizeValue;
	/** Column position: absolute number, or percentage (e.g., "50%" = centered horizontally) */
	col?: SizeValue;

	// === Margin from terminal edges ===
	/** Margin from terminal edges. Number applies to all sides. */
	margin?: OverlayMargin | number;

	// === Visibility ===
	/**
	 * Control overlay visibility based on terminal dimensions.
	 * If provided, overlay is only rendered when this returns true.
	 * Called each render cycle with current terminal dimensions.
	 */
	visible?: (termWidth: number, termHeight: number) => boolean;
	/** If true, don't capture keyboard focus when shown */
	nonCapturing?: boolean;
	/** If true, dim the screen behind the overlay (semi-transparent scrim). */
	backdrop?: boolean;
	/** If true, enable any-motion mouse tracking so the overlay receives hover (move) events. */
	trackMotion?: boolean;
}

/** Options for {@link OverlayHandle.unfocus}. */
export interface OverlayUnfocusOptions {
	/** Explicit target to focus after releasing this overlay. */
	target: Component | null;
}

/**
 * Handle returned by showOverlay for controlling the overlay
 */
export interface OverlayHandle {
	/** Permanently remove the overlay (cannot be shown again) */
	hide(): void;
	/** Temporarily hide or show the overlay */
	setHidden(hidden: boolean): void;
	/** Check if overlay is temporarily hidden */
	isHidden(): boolean;
	/** Focus this overlay and bring it to the visual front */
	focus(): void;
	/** Release focus to the next visible capturing overlay or previous target, or to an explicit target when provided */
	unfocus(options?: OverlayUnfocusOptions): void;
	/** Check if this overlay currently has focus */
	isFocused(): boolean;
}

type OverlayStackEntry = {
	component: Component;
	options?: OverlayOptions;
	preFocus: Component | null;
	hidden: boolean;
	focusOrder: number;
};

type OverlayBlockedFocusResume = { status: "restore-overlay" } | { status: "focus-target"; target: Component | null };
type EligibleOverlayFocusRestoreState = { status: "eligible"; overlay: OverlayStackEntry };
type BlockedOverlayFocusRestoreState = {
	status: "blocked";
	overlay: OverlayStackEntry;
	blockedBy: Component;
	resume: OverlayBlockedFocusResume;
};
type ActiveOverlayFocusRestoreState = EligibleOverlayFocusRestoreState | BlockedOverlayFocusRestoreState;
type OverlayFocusRestoreState = { status: "inactive" } | ActiveOverlayFocusRestoreState;
type OverlayFocusRestorePolicy = "clear" | "preserve";

/**
 * Container - a component that contains other components
 */
export class Container implements Component {
	children: Component[] = [];

	addChild(component: Component): void {
		this.children.push(component);
	}

	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index !== -1) {
			this.children.splice(index, 1);
		}
	}

	clear(): void {
		this.children = [];
	}

	invalidate(): void {
		for (const child of this.children) {
			child.invalidate?.();
		}
	}

	render(width: number): string[] {
		const lines: string[] = [];
		for (const child of this.children) {
			const childLines = child.render(width);
			for (const line of childLines) {
				lines.push(line);
			}
		}
		return lines;
	}

	/** True when this node renders by plain child concatenation (descendable for hit-testing). */
	private usesDefaultRender(): boolean {
		return this.render === Container.prototype.render;
	}

	/**
	 * Render while recording the line range of every mouse-aware component, for
	 * click hit-testing. Lines are identical to {@link render}. Components that
	 * override render() are treated as opaque leaves (their internal layout is
	 * their own concern, exposed via handleMouse's localY).
	 */
	renderWithHits(width: number, offset: number): { lines: string[]; hits: MouseHit[] } {
		// Opaque node (custom render): emit its lines as-is, record it as one hit.
		if (!this.usesDefaultRender()) {
			const lines = this.render(width);
			const hits: MouseHit[] = isMouseAware(this)
				? [{ component: this, start: offset, end: offset + lines.length }]
				: [];
			return { lines, hits };
		}

		const lines: string[] = [];
		const hits: MouseHit[] = [];
		let cur = offset;
		for (const child of this.children) {
			const r = renderNodeWithHits(child, width, cur);
			for (const line of r.lines) lines.push(line);
			for (const hit of r.hits) hits.push(hit);
			cur += r.lines.length;
		}
		if (isMouseAware(this)) hits.push({ component: this, start: offset, end: cur });
		return { lines, hits };
	}
}

/** Render any component with hit ranges: descend into plain Containers, treat others as leaves. */
function renderNodeWithHits(node: Component, width: number, offset: number): { lines: string[]; hits: MouseHit[] } {
	if (node instanceof Container) {
		return node.renderWithHits(width, offset);
	}
	const lines = node.render(width);
	const hits: MouseHit[] = isMouseAware(node) ? [{ component: node, start: offset, end: offset + lines.length }] : [];
	return { lines, hits };
}

/**
 * TUI - Main class for managing terminal UI with differential rendering
 */
export class TUI extends Container {
	public terminal: Terminal;
	private previousLines: string[] = [];
	private previousKittyImageIds = new Set<number>();
	private previousWidth = 0;
	private previousHeight = 0;
	private focusedComponent: Component | null = null;
	private inputListeners = new Set<InputListener>();

	/** Global callback for debug key (Shift+Ctrl+D). Called before input is forwarded to focused component. */
	public onDebug?: () => void;
	private renderRequested = false;
	private renderTimer: NodeJS.Timeout | undefined;
	private priorityRenderScheduled = false;
	private scrollPrefersViewportShift = false;
	private lastAcceptedWheelAt = Number.NEGATIVE_INFINITY;
	private lastRenderAt = 0;
	private static readonly MIN_RENDER_INTERVAL_MS = 16;
	private cursorRow = 0; // Logical cursor row (end of rendered content)
	private hardwareCursorRow = 0; // Actual terminal cursor row (may differ due to IME positioning)
	private showHardwareCursor = process.env.PIX_HARDWARE_CURSOR === "1";
	private clearOnShrink = process.env.PIX_CLEAR_ON_SHRINK === "1"; // Clear empty rows when content shrinks (default: off)
	private maxLinesRendered = 0; // Track terminal's working area (max lines ever rendered)
	private previousViewportTop = 0; // Track previous viewport top for resize-aware cursor moves
	private fullRedrawCount = 0;
	private stopped = false;
	private pendingOsc11BackgroundReplies = 0;
	private pendingOsc11BackgroundQueries: PendingOsc11BackgroundQuery[] = [];
	private terminalColorSchemeListeners = new Set<(scheme: TerminalColorScheme) => void>();
	private terminalColorSchemeNotificationsEnabled = false;

	// App-managed scrolling (alternate-screen mode). When enabled, the TUI renders
	// only a height-sized window of the full content and owns scroll position,
	// instead of letting content flow into the terminal's native scrollback.
	private appScroll = false;
	/** Horizontal page margin (blank columns on each side) in app-scroll/alt-screen mode. */
	private marginX = 0;
	/**
	 * Absolute top line index (into the full line array) the view is anchored to
	 * while reading history. Anchoring by an ABSOLUTE top — not by distance from
	 * the bottom — keeps the visible content stable when new lines append below;
	 * a distance-from-bottom anchor would slide the view toward the new content
	 * and scroll the user's history off the top. Ignored while {@link stickToBottom}.
	 */
	private scrollTop = 0;
	/** When true, new content keeps the view pinned to the bottom. */
	private stickToBottom = true;
	/** Top index (into the full line array) of the last rendered window. For hit-testing. */
	private lastWindowTop = 0;
	/**
	 * Pending scroll anchor consumed on the next windowing pass: keep full-content
	 * line `fullIndex` pinned at screen row `screenRow`. Set when a block is
	 * clicked to expand/collapse so the block stays put and content flows down,
	 * instead of the view snapping to the bottom.
	 */
	private pendingAnchor: { fullIndex: number; screenRow: number } | null = null;
	/** Mouse-aware component line ranges from the last render (full-content indices). */
	private lastHits: MouseHit[] = [];
	/** Mouse-aware overlay ranges from the last render, in screen coordinates. */
	private lastOverlayHits: OverlayMouseHit[] = [];
	/** Full (pre-window) rendered lines from the last render, for selection text extraction. */
	private lastFullLines: string[] = [];
	private removeMouseListener?: () => void;

	// App-managed text selection (mouse mode). Coordinates are in full-content
	// space: `line` is an index into lastFullLines, `col` is a visible column.
	private selAnchor: { line: number; col: number } | null = null;
	private selEnd: { line: number; col: number } | null = null;
	private selecting = false; // a drag is in progress
	private hasSelection = false; // a finished/active selection should be highlighted
	private mouseMoved = false; // motion seen since the last mousedown (click vs drag)
	/** Invoked with the selected text when a drag-selection completes (app wires clipboard). */
	public onSelectionCopy?: (text: string) => void;

	// Overlay stack for modal components rendered on top of base content
	private focusOrderCounter = 0;
	private overlayStack: OverlayStackEntry[] = [];
	private overlayFocusRestore: OverlayFocusRestoreState = { status: "inactive" };

	constructor(
		terminal: Terminal,
		showHardwareCursor?: boolean,
		options: { appScroll?: boolean; marginX?: number } = {},
	) {
		super();
		this.terminal = terminal;
		if (showHardwareCursor !== undefined) {
			this.showHardwareCursor = showHardwareCursor;
		}
		this.appScroll = options.appScroll ?? false;
		this.marginX = Math.max(0, Math.floor(options.marginX ?? 0));
	}

	/** Whether app-managed scrolling (alternate-screen window rendering) is active. */
	get appScrollEnabled(): boolean {
		return this.appScroll;
	}

	/** Number of lines to scroll per wheel notch. */
	private static readonly WHEEL_STEP = 4;
	/** Trackpads can emit many SGR wheel events per gesture; cap accepted events to roughly one per frame. */
	private static readonly MIN_WHEEL_INTERVAL_MS = 16;

	/**
	 * Collapse full content into a height-sized window based on the current
	 * scroll position, re-pinning to the bottom when stuck and clamping the
	 * saved offset to the latest content size.
	 */
	private applyScrollWindow(lines: string[], height: number): string[] {
		if (height <= 0) {
			this.lastWindowTop = 0;
			return [];
		}
		const maxTop = Math.max(0, lines.length - height);
		if (this.pendingAnchor) {
			// Keep the clicked block pinned at its screen row; content flows down.
			const { fullIndex, screenRow } = this.pendingAnchor;
			this.pendingAnchor = null;
			this.scrollTop = Math.max(0, Math.min(fullIndex - Math.max(0, screenRow), maxTop));
			this.stickToBottom = this.scrollTop >= maxTop;
		} else if (this.stickToBottom) {
			this.scrollTop = maxTop;
		} else {
			// Reading history: hold the ABSOLUTE top fixed so appended content below
			// does not slide the view. Re-stick only once we reach the live bottom.
			this.scrollTop = Math.min(Math.max(0, this.scrollTop), maxTop);
			if (this.scrollTop >= maxTop) this.stickToBottom = true;
		}
		const top = this.scrollTop;
		this.lastWindowTop = top;
		const windowLines = lines.slice(top, top + height);
		// Pad to a full screen so stale rows below short content are cleared.
		while (windowLines.length < height) windowLines.push("");
		return windowLines;
	}

	/** Scroll by N lines: positive reveals older content, negative reveals newer. */
	scrollBy(lines: number): void {
		if (!this.appScroll || lines === 0) return;
		const maxTop = Math.max(0, this.lastFullLines.length - this.terminal.rows);
		// Positive reveals older content -> the top moves up (smaller index).
		const curTop = this.stickToBottom ? maxTop : this.scrollTop;
		const nextTop = Math.max(0, Math.min(curTop - lines, maxTop));
		const nextStick = nextTop >= maxTop;
		if (nextTop === curTop && this.stickToBottom === nextStick) return;
		this.scrollTop = nextTop;
		this.stickToBottom = nextStick;
		this.scrollPrefersViewportShift = this.renderRequested || this.renderTimer !== undefined;
		this.requestRender(false, true);
	}

	/** Re-pin the view to the latest content. */
	scrollToBottom(): void {
		if (!this.appScroll) return;
		if (this.stickToBottom) return;
		this.stickToBottom = true;
		this.scrollPrefersViewportShift = this.renderRequested || this.renderTimer !== undefined;
		this.requestRender(false, true);
	}

	/**
	 * Paint dim ▲/▼ "more content" markers into the reserved left margin of the
	 * top/bottom rows. Touches only the displayed lines (not lastFullLines or
	 * lastHits), so text selection and click hit-testing are unaffected. No-op
	 * when there is no margin or nothing is scrolled out of view.
	 */
	private addScrollIndicators(lines: string[]): string[] {
		if (this.marginX < 1 || lines.length === 0) return lines;
		const maxTop = Math.max(0, this.lastFullLines.length - lines.length);
		const moreAbove = this.lastWindowTop > 0;
		// Hide the lower indicator on the first step away from the bottom so a tiny
		// scroll does not make the gutter twitch. Once the user moves farther into
		// history, show it again.
		const moreBelow = !this.stickToBottom && this.scrollTop < Math.max(0, maxTop - 1);
		if (!moreAbove && !moreBelow) return lines;
		const out = lines.slice();
		const mark = (idx: number, glyph: string): void => {
			const line = out[idx] ?? "";
			// The line starts with marginX blank cells; replace the first one.
			out[idx] = `\x1b[2m${glyph}\x1b[22m${line.slice(1)}`;
		};
		if (moreAbove) mark(0, "▲");
		if (moreBelow) mark(out.length - 1, "▼");
		return out;
	}

	/**
	 * Intercept mouse sequences before they reach the focused component.
	 * Wheel scrolls; press+drag selects text; press+release without movement is
	 * a click dispatched to the target component. Everything is consumed so raw
	 * sequences never leak to the focused component as text.
	 */
	private handleMouseInput(data: string): InputListenerResult {
		const evt = parseMouse(data);
		if (!evt) {
			// Swallow anything that begins like a mouse report but didn't fully parse
			// (e.g. a partial SGR sequence flushed mid-stream by the stdin buffer under
			// a motion flood). Letting it fall through would feed raw bytes to the
			// focused editor as stray keystrokes — e.g. spurious history navigation.
			if (data.startsWith("\x1b[<") || data.startsWith("\x1b[M")) return { consume: true };
			return undefined;
		}
		if (evt.shift) return { consume: true };
		if (evt.wheel) {
			// 有 modal overlay 显示时禁止滚动其下方内容（与点击时不开始选择一致）
			if (!this.getTopmostVisibleOverlay()) {
				// Only vertical wheel scrolls. Horizontal wheel (left/right) is consumed but
				// ignored: pix has no horizontal scroll, and treating it as vertical turned
				// diagonal trackpad gestures into up/down jitter.
				if (evt.wheel === "up" || evt.wheel === "down") {
					const now = performance.now();
					if (now - this.lastAcceptedWheelAt >= TUI.MIN_WHEEL_INTERVAL_MS) {
						this.lastAcceptedWheelAt = now;
						this.scrollBy(evt.wheel === "up" ? TUI.WHEEL_STEP : -TUI.WHEEL_STEP);
					}
				}
			}
			return { consume: true };
		}

		const line = this.lastWindowTop + evt.y;
		// Screen column -> content column: content starts marginX cells from the left.
		const col = Math.max(0, evt.x - this.marginX);

		if (evt.action === "down" && evt.button !== "right") {
			// While a modal overlay is up the dimmed background isn't selectable. Skip
			// starting a text selection so a slightly-dragged press still resolves to a
			// click on the overlay (and never starts a selection-drag render flood).
			if (!this.getTopmostVisibleOverlay()) this.beginSelection(line, col);
			return { consume: true };
		}
		if (evt.action === "move") {
			if (this.selecting) {
				this.updateSelection(line, col);
			} else if (this.routeHoverToOverlay(evt)) {
				// Free hover (any-motion tracking) over an overlay drives its highlight.
				this.requestRender();
			}
			return { consume: true };
		}
		if (evt.action === "up" && evt.button !== "right") {
			this.endSelection(line, col, evt);
			return { consume: true };
		}
		return { consume: true };
	}

	private beginSelection(line: number, col: number): void {
		this.selecting = true;
		this.mouseMoved = false;
		this.selAnchor = { line, col };
		this.selEnd = { line, col };
		if (this.hasSelection) {
			// Clear a previous highlight on a fresh press.
			this.hasSelection = false;
			this.requestRender();
		}
	}

	private updateSelection(line: number, col: number): void {
		if (!this.selAnchor) return;
		this.selEnd = { line, col };
		if (line !== this.selAnchor.line || col !== this.selAnchor.col) {
			this.mouseMoved = true;
			this.hasSelection = true;
		}
		this.requestRender();
	}

	private endSelection(line: number, col: number, evt: MouseEvent): void {
		this.selecting = false;
		if (!this.mouseMoved) {
			// No drag: treat as a click on the target component.
			this.clearSelection();
			this.dispatchClick(evt);
			return;
		}
		this.selEnd = { line, col };
		const text = this.getSelectedText();
		if (text) this.onSelectionCopy?.(text);
		this.requestRender(); // keep the highlight until the next interaction
	}

	/** Clear any active text selection and request a redraw if needed. */
	clearSelection(): void {
		this.selAnchor = null;
		this.selEnd = null;
		this.selecting = false;
		this.mouseMoved = false;
		if (this.hasSelection) {
			this.hasSelection = false;
			this.requestRender();
		}
	}

	/** Normalized [start, end] of the current selection in (line, col) order. */
	private orderedSelection(): { start: { line: number; col: number }; end: { line: number; col: number } } | null {
		if (!this.selAnchor || !this.selEnd) return null;
		let a = this.selAnchor;
		let b = this.selEnd;
		if (a.line > b.line || (a.line === b.line && a.col > b.col)) [a, b] = [b, a];
		return { start: a, end: b };
	}

	/** Extract the selected text (plain, ANSI stripped) from the full content lines. */
	private getSelectedText(): string {
		const sel = this.orderedSelection();
		if (!sel) return "";
		const out: string[] = [];
		for (let ln = sel.start.line; ln <= sel.end.line && ln < this.lastFullLines.length; ln++) {
			const lineStr = this.lastFullLines[ln] ?? "";
			const lineWidth = visibleWidth(lineStr);
			const fromCol = ln === sel.start.line ? sel.start.col : 0;
			const toCol = ln === sel.end.line ? Math.min(sel.end.col, lineWidth) : lineWidth;
			const slice = sliceByColumn(lineStr, fromCol, Math.max(0, toCol - fromCol));
			out.push(stripAnsiCodes(slice));
		}
		return out.join("\n");
	}

	/** Paint the active selection over the visible window (window-row aligned). */
	private applySelectionHighlight(windowLines: string[]): string[] {
		const sel = this.orderedSelection();
		if (!sel) return windowLines;
		const result = windowLines.slice();
		for (let row = 0; row < result.length; row++) {
			const ln = this.lastWindowTop + row;
			if (ln < sel.start.line || ln > sel.end.line) continue;
			const lineStr = result[row] ?? "";
			const lineWidth = visibleWidth(lineStr);
			const fromCol = ln === sel.start.line ? sel.start.col : 0;
			const toCol = ln === sel.end.line ? Math.min(sel.end.col, lineWidth) : lineWidth;
			if (toCol <= fromCol) continue;
			const before = sliceByColumn(lineStr, 0, fromCol);
			const mid = sliceByColumn(lineStr, fromCol, toCol - fromCol);
			const after = sliceByColumn(lineStr, toCol, Math.max(0, lineWidth - toCol));
			const hl = applyScopedStyle((t) => `\x1b[7m${t}\x1b[27m`, mid);
			result[row] = before + hl + after;
		}
		return result;
	}

	/**
	 * Route a hover (move) event to the overlay under the cursor. Returns true only
	 * when a repaint is needed — a component that returns `false` (e.g. the cursor
	 * moved but the highlighted row is unchanged) suppresses the render so any-motion
	 * tracking can't flood the event loop with full-screen re-renders.
	 */
	private routeHoverToOverlay(evt: MouseEvent): boolean {
		if (!this.getTopmostVisibleOverlay()) return false;
		for (let i = this.lastOverlayHits.length - 1; i >= 0; i--) {
			const hit = this.lastOverlayHits[i];
			if (evt.y >= hit.startRow && evt.y < hit.endRow && evt.x >= hit.col && evt.x < hit.col + hit.width) {
				return hit.component.handleMouse?.({ ...evt, x: evt.x - hit.col }, evt.y - hit.startRow) !== false;
			}
		}
		return false;
	}

	/** Map a click's screen row to the owning mouse-aware component and notify it. */
	private dispatchClick(evt: MouseEvent): void {
		// While an overlay is up, the transcript underneath is not interactive.
		if (this.getTopmostVisibleOverlay()) {
			for (let i = this.lastOverlayHits.length - 1; i >= 0; i--) {
				const hit = this.lastOverlayHits[i];
				if (evt.y >= hit.startRow && evt.y < hit.endRow && evt.x >= hit.col && evt.x < hit.col + hit.width) {
					hit.component.handleMouse?.({ ...evt, x: evt.x - hit.col }, evt.y - hit.startRow);
					this.requestRender();
					return;
				}
			}
			return;
		}
		const fullLineIndex = this.lastWindowTop + evt.y;
		for (const hit of this.lastHits) {
			if (fullLineIndex >= hit.start && fullLineIndex < hit.end) {
				const screenRow = Math.max(0, hit.start - this.lastWindowTop);
				// Hand the component a content-space column (margin removed), matching
				// the coordinate space its render output lives in.
				const contentEvt = { ...evt, x: Math.max(0, evt.x - this.marginX) };
				hit.component.handleMouse?.(contentEvt, fullLineIndex - hit.start);
				// Anchor the clicked block's top to its current screen row so an
				// expand/collapse keeps it visually in place — but ONLY when the user
				// has scrolled up to read history. While pinned to the live bottom
				// (following streaming output), keep following the bottom instead, so
				// expanding/collapsing doesn't freeze the view with fresh output piling
				// up off-screen below the fold.
				if (!this.stickToBottom) {
					this.pendingAnchor = { fullIndex: hit.start, screenRow };
				}
				this.requestRender();
				return;
			}
		}
	}

	get fullRedraws(): number {
		return this.fullRedrawCount;
	}

	getShowHardwareCursor(): boolean {
		return this.showHardwareCursor;
	}

	setShowHardwareCursor(enabled: boolean): void {
		if (this.showHardwareCursor === enabled) return;
		this.showHardwareCursor = enabled;
		if (!enabled) {
			this.terminal.hideCursor();
		}
		this.requestRender();
	}

	getClearOnShrink(): boolean {
		return this.clearOnShrink;
	}

	/**
	 * Set whether to trigger full re-render when content shrinks.
	 * When true (default), empty rows are cleared when content shrinks.
	 * When false, empty rows remain (reduces redraws on slower terminals).
	 */
	setClearOnShrink(enabled: boolean): void {
		this.clearOnShrink = enabled;
	}

	setFocus(component: Component | null): void {
		this.setFocusInternal({ component, overlayFocusRestore: "clear" });
	}

	private setFocusInternal({
		component,
		overlayFocusRestore,
	}: {
		component: Component | null;
		overlayFocusRestore: OverlayFocusRestorePolicy;
	}): void {
		const previousFocus = this.focusedComponent;
		let nextFocus = component;
		const previousFocusedOverlay = previousFocus
			? this.overlayStack.find((entry) => entry.component === previousFocus && this.isOverlayVisible(entry))
			: undefined;
		const nextFocusIsOverlay = nextFocus ? this.overlayStack.some((entry) => entry.component === nextFocus) : false;
		const restoreState = this.getVisibleOverlayFocusRestore();
		if (nextFocus && !nextFocusIsOverlay) {
			if (restoreState.status === "blocked" && restoreState.blockedBy === previousFocus) {
				if (restoreState.resume.status === "focus-target" || !this.isComponentMounted(restoreState.blockedBy)) {
					nextFocus = this.resolveBlockedOverlayFocusResume(restoreState);
				} else {
					this.overlayFocusRestore = {
						status: "blocked",
						overlay: restoreState.overlay,
						blockedBy: nextFocus,
						resume: restoreState.resume,
					};
				}
			} else if (
				previousFocusedOverlay &&
				restoreState.status !== "inactive" &&
				restoreState.overlay === previousFocusedOverlay &&
				!this.isOverlayFocusAncestor(previousFocusedOverlay, nextFocus)
			) {
				this.overlayFocusRestore = {
					status: "blocked",
					overlay: previousFocusedOverlay,
					blockedBy: nextFocus,
					resume: { status: "restore-overlay" },
				};
			}
		} else if (nextFocus === null) {
			if (restoreState.status === "blocked" && restoreState.blockedBy === previousFocus) {
				nextFocus = this.resolveBlockedOverlayFocusResume(restoreState);
			} else if (overlayFocusRestore === "clear") {
				this.clearOverlayFocusRestore();
			}
		}

		if (isFocusable(this.focusedComponent)) {
			this.focusedComponent.focused = false;
		}

		this.focusedComponent = nextFocus;

		if (isFocusable(nextFocus)) {
			nextFocus.focused = true;
		}

		const focusedOverlay = nextFocus
			? this.overlayStack.find((entry) => entry.component === nextFocus && this.isOverlayVisible(entry))
			: undefined;
		if (focusedOverlay) {
			this.overlayFocusRestore = { status: "eligible", overlay: focusedOverlay };
		}
	}

	private clearOverlayFocusRestore(): void {
		this.overlayFocusRestore = { status: "inactive" };
	}

	private clearOverlayFocusRestoreFor(overlay: OverlayStackEntry): void {
		if (this.overlayFocusRestore.status !== "inactive" && this.overlayFocusRestore.overlay === overlay) {
			this.clearOverlayFocusRestore();
		}
	}

	private resolveBlockedOverlayFocusResume(restoreState: BlockedOverlayFocusRestoreState): Component | null {
		if (restoreState.resume.status === "restore-overlay") return restoreState.overlay.component;
		this.clearOverlayFocusRestore();
		return restoreState.resume.target;
	}

	private getVisibleOverlayFocusRestore(): OverlayFocusRestoreState {
		const restoreState = this.overlayFocusRestore;
		if (restoreState.status === "inactive") return restoreState;
		if (!this.overlayStack.includes(restoreState.overlay) || !this.isOverlayVisible(restoreState.overlay)) {
			return { status: "inactive" };
		}
		return restoreState;
	}

	private isOverlayFocusAncestor(entry: OverlayStackEntry, component: Component): boolean {
		const visited = new Set<Component>();
		let current = entry.preFocus;
		while (current && !visited.has(current)) {
			visited.add(current);
			if (current === component) return true;
			current = this.overlayStack.find((overlay) => overlay.component === current)?.preFocus ?? null;
		}
		return false;
	}

	private retargetOverlayPreFocus(removed: OverlayStackEntry): void {
		for (const overlay of this.overlayStack) {
			if (overlay !== removed && overlay.preFocus === removed.component) {
				overlay.preFocus = removed.preFocus;
			}
		}
	}

	private isComponentMounted(component: Component): boolean {
		return this.children.some((child) => this.containsComponent(child, component));
	}

	private containsComponent(root: Component, target: Component): boolean {
		if (root === target) return true;
		if (!(root instanceof Container)) return false;
		return root.children.some((child) => this.containsComponent(child, target));
	}

	/** Enable any-motion mouse tracking when a visible overlay wants hover events. */
	private syncMotionTracking(): void {
		const want = this.overlayStack.some((e) => this.isOverlayVisible(e) && e.options?.trackMotion);
		this.terminal.setMotionTracking(want);
	}

	/**
	 * Show an overlay component with configurable positioning and sizing.
	 * Returns a handle to control the overlay's visibility.
	 */
	showOverlay(component: Component, options?: OverlayOptions): OverlayHandle {
		const entry: OverlayStackEntry = {
			component,
			...(options === undefined ? {} : { options }),
			preFocus: this.focusedComponent,
			hidden: false,
			focusOrder: ++this.focusOrderCounter,
		};
		this.overlayStack.push(entry);
		// Only focus if overlay is actually visible
		if (!options?.nonCapturing && this.isOverlayVisible(entry)) {
			this.setFocus(component);
		}
		this.terminal.hideCursor();
		this.syncMotionTracking();
		this.requestRender();

		// Return handle for controlling this overlay
		return {
			hide: () => {
				const index = this.overlayStack.indexOf(entry);
				if (index !== -1) {
					this.clearOverlayFocusRestoreFor(entry);
					this.retargetOverlayPreFocus(entry);
					this.overlayStack.splice(index, 1);
					// Restore focus if this overlay had focus
					if (this.focusedComponent === component) {
						const topVisible = this.getTopmostVisibleOverlay();
						this.setFocus(topVisible?.component ?? entry.preFocus);
					}
					if (this.overlayStack.length === 0) this.terminal.hideCursor();
					this.syncMotionTracking();
					this.requestRender();
				}
			},
			setHidden: (hidden: boolean) => {
				if (entry.hidden === hidden) return;
				entry.hidden = hidden;
				// Update focus when hiding/showing
				if (hidden) {
					this.clearOverlayFocusRestoreFor(entry);
					// If this overlay had focus, move focus to next visible or preFocus
					if (this.focusedComponent === component) {
						const topVisible = this.getTopmostVisibleOverlay();
						this.setFocus(topVisible?.component ?? entry.preFocus);
					}
				} else {
					// Restore focus to this overlay when showing (if it's actually visible)
					if (!options?.nonCapturing && this.isOverlayVisible(entry)) {
						entry.focusOrder = ++this.focusOrderCounter;
						this.setFocus(component);
					}
				}
				this.syncMotionTracking();
				this.requestRender();
			},
			isHidden: () => entry.hidden,
			focus: () => {
				if (!this.overlayStack.includes(entry) || !this.isOverlayVisible(entry)) return;
				entry.focusOrder = ++this.focusOrderCounter;
				this.setFocus(component);
				this.requestRender();
			},
			unfocus: (unfocusOptions) => {
				const isFocused = this.focusedComponent === component;
				const restoreState = this.overlayFocusRestore;
				const hasPendingRestore = restoreState.status !== "inactive" && restoreState.overlay === entry;
				if (!isFocused && !hasPendingRestore) return;
				if (
					restoreState.status === "blocked" &&
					restoreState.overlay === entry &&
					this.focusedComponent === restoreState.blockedBy
				) {
					if (unfocusOptions) {
						this.overlayFocusRestore = {
							status: "blocked",
							overlay: entry,
							blockedBy: restoreState.blockedBy,
							resume: { status: "focus-target", target: unfocusOptions.target },
						};
					} else {
						this.clearOverlayFocusRestore();
					}
					this.requestRender();
					return;
				}
				this.clearOverlayFocusRestoreFor(entry);
				if (isFocused || unfocusOptions) {
					const topVisible = this.getTopmostVisibleOverlay();
					const fallbackTarget = topVisible && topVisible !== entry ? topVisible.component : entry.preFocus;
					this.setFocus(unfocusOptions ? unfocusOptions.target : fallbackTarget);
				}
				this.requestRender();
			},
			isFocused: () => this.focusedComponent === component,
		};
	}

	/** Hide the topmost overlay and restore previous focus. */
	hideOverlay(): void {
		const overlay = this.overlayStack[this.overlayStack.length - 1];
		if (!overlay) return;
		this.clearOverlayFocusRestoreFor(overlay);
		this.retargetOverlayPreFocus(overlay);
		this.overlayStack.pop();
		if (this.focusedComponent === overlay.component) {
			// Find topmost visible overlay, or fall back to preFocus
			const topVisible = this.getTopmostVisibleOverlay();
			this.setFocus(topVisible?.component ?? overlay.preFocus);
		}
		if (this.overlayStack.length === 0) this.terminal.hideCursor();
		this.requestRender();
	}

	/** Check if there are any visible overlays */
	hasOverlay(): boolean {
		return this.overlayStack.some((o) => this.isOverlayVisible(o));
	}

	/** Check if an overlay entry is currently visible */
	private isOverlayVisible(entry: OverlayStackEntry): boolean {
		if (entry.hidden) return false;
		if (entry.options?.visible) {
			return entry.options.visible(this.terminal.columns, this.terminal.rows);
		}
		return true;
	}

	/** Find the visual-frontmost visible capturing overlay, if any */
	private getTopmostVisibleOverlay(): OverlayStackEntry | undefined {
		let topmost: OverlayStackEntry | undefined;
		for (const overlay of this.overlayStack) {
			if (overlay.options?.nonCapturing || !this.isOverlayVisible(overlay)) continue;
			if (!topmost || overlay.focusOrder > topmost.focusOrder) {
				topmost = overlay;
			}
		}
		return topmost;
	}

	override invalidate(): void {
		super.invalidate();
		for (const overlay of this.overlayStack) overlay.component.invalidate?.();
	}

	start(): void {
		this.stopped = false;
		this.terminal.start(
			(data) => this.handleInput(data),
			() => this.requestRender(),
		);
		this.terminal.hideCursor();
		if (this.appScroll) {
			this.removeMouseListener = this.addInputListener((data) => this.handleMouseInput(data));
		}
		if (this.terminalColorSchemeNotificationsEnabled) {
			this.terminal.write("\x1b[?2031h");
		}
		this.queryCellSize();
		this.requestRender();
	}

	addInputListener(listener: InputListener): () => void {
		this.inputListeners.add(listener);
		return () => {
			this.inputListeners.delete(listener);
		};
	}

	removeInputListener(listener: InputListener): void {
		this.inputListeners.delete(listener);
	}

	onTerminalColorSchemeChange(listener: (scheme: TerminalColorScheme) => void): () => void {
		this.terminalColorSchemeListeners.add(listener);
		return () => {
			this.terminalColorSchemeListeners.delete(listener);
		};
	}

	setTerminalColorSchemeNotifications(enabled: boolean): void {
		if (this.terminalColorSchemeNotificationsEnabled === enabled) {
			return;
		}
		this.terminalColorSchemeNotificationsEnabled = enabled;
		if (!this.stopped) {
			this.terminal.write(enabled ? "\x1b[?2031h" : "\x1b[?2031l");
		}
	}

	private queryCellSize(): void {
		// Only query if terminal supports images (cell size is only used for image rendering)
		if (!getCapabilities().images) {
			return;
		}
		// Query terminal for cell size in pixels: CSI 16 t
		// Response format: CSI 6 ; height ; width t
		this.terminal.write("\x1b[16t");
	}

	stop(): void {
		this.stopped = true;
		if (this.removeMouseListener) {
			this.removeMouseListener();
			this.removeMouseListener = undefined;
		}
		if (this.renderTimer) {
			clearTimeout(this.renderTimer);
			this.renderTimer = undefined;
		}
		if (this.terminalColorSchemeNotificationsEnabled) {
			this.terminal.write("\x1b[?2031l");
		}
		// Move cursor to the end of the content to prevent overwriting/artifacts on exit
		if (this.previousLines.length > 0) {
			const targetRow = this.previousLines.length; // Line after the last content
			const lineDiff = targetRow - this.hardwareCursorRow;
			if (lineDiff > 0) {
				this.terminal.write(`\x1b[${lineDiff}B`);
			} else if (lineDiff < 0) {
				this.terminal.write(`\x1b[${-lineDiff}A`);
			}
			this.terminal.write("\r\n");
		}

		this.terminal.showCursor();
		this.terminal.stop();
	}

	requestRender(force = false, priority = false): void {
		if (force) {
			this.previousLines = [];
			this.previousWidth = -1; // -1 triggers widthChanged, forcing a full clear
			this.previousHeight = -1; // -1 triggers heightChanged, forcing a full clear
			this.cursorRow = 0;
			this.hardwareCursorRow = 0;
			this.maxLinesRendered = 0;
			this.previousViewportTop = 0;
			this.lastWindowTop = 0;
			this.scrollPrefersViewportShift = false;
			this.lastAcceptedWheelAt = Number.NEGATIVE_INFINITY;
			if (this.renderTimer) {
				clearTimeout(this.renderTimer);
				this.renderTimer = undefined;
			}
			this.renderRequested = true;
			process.nextTick(() => {
				if (this.stopped || !this.renderRequested) {
					return;
				}
				this.renderRequested = false;
				this.lastRenderAt = performance.now();
				this.doRender();
			});
			return;
		}
		if (priority) {
			this.renderRequested = true;
			if (this.renderTimer) {
				clearTimeout(this.renderTimer);
				this.renderTimer = undefined;
			}
			if (this.priorityRenderScheduled) return;
			this.priorityRenderScheduled = true;
			process.nextTick(() => {
				this.priorityRenderScheduled = false;
				if (this.stopped || !this.renderRequested) {
					return;
				}
				if (this.renderTimer) {
					clearTimeout(this.renderTimer);
					this.renderTimer = undefined;
				}
				this.renderRequested = false;
				this.lastRenderAt = performance.now();
				this.doRender();
				if (this.renderRequested) {
					this.scheduleRender();
				}
			});
			return;
		}
		if (this.renderRequested) return;
		this.renderRequested = true;
		process.nextTick(() => this.scheduleRender());
	}

	private scheduleRender(): void {
		if (this.stopped || this.renderTimer || !this.renderRequested) {
			return;
		}
		const elapsed = performance.now() - this.lastRenderAt;
		const delay = Math.max(0, TUI.MIN_RENDER_INTERVAL_MS - elapsed);
		this.renderTimer = setTimeout(() => {
			this.renderTimer = undefined;
			if (this.stopped || !this.renderRequested) {
				return;
			}
			this.renderRequested = false;
			this.lastRenderAt = performance.now();
			this.doRender();
			if (this.renderRequested) {
				this.scheduleRender();
			}
		}, delay);
	}

	private handleInput(data: string): void {
		if (this.consumeOsc11BackgroundResponse(data)) {
			return;
		}
		if (this.consumeTerminalColorSchemeReport(data)) {
			return;
		}

		if (this.inputListeners.size > 0) {
			let current = data;
			for (const listener of this.inputListeners) {
				const result = listener(current);
				if (result?.consume) {
					return;
				}
				if (result?.data !== undefined) {
					current = result.data;
				}
			}
			if (current.length === 0) {
				return;
			}
			data = current;
		}

		// Consume terminal cell size responses without blocking unrelated input.
		if (this.consumeCellSizeResponse(data)) {
			return;
		}

		// Any keypress dismisses an active text selection highlight. Escape is
		// consumed (its only job here was to clear); other keys still proceed.
		if (this.hasSelection && !isKeyRelease(data)) {
			const wasEscape = matchesKey(data, "escape");
			this.clearSelection();
			if (wasEscape) return;
		}

		// Global debug key handler (Shift+Ctrl+D)
		if (matchesKey(data, "shift+ctrl+d") && this.onDebug) {
			this.onDebug();
			return;
		}

		// If focused component is an overlay, verify it's still visible
		// (visibility can change due to terminal resize or visible() callback)
		const focusedOverlay = this.overlayStack.find((o) => o.component === this.focusedComponent);
		if (focusedOverlay && !this.isOverlayVisible(focusedOverlay)) {
			// Focused overlay is no longer visible, redirect to topmost visible overlay
			const topVisible = this.getTopmostVisibleOverlay();
			if (topVisible) {
				this.setFocus(topVisible.component);
			} else {
				this.setFocusInternal({ component: focusedOverlay.preFocus, overlayFocusRestore: "preserve" });
			}
		}

		const focusIsOverlay = this.overlayStack.some((o) => o.component === this.focusedComponent);

		// App-managed transcript paging (alt-screen mode). Only intercepts when not
		// inside a modal overlay, so overlays keep their own PageUp/PageDown.
		if (this.appScroll && !focusIsOverlay && !isKeyRelease(data)) {
			const page = Math.max(1, this.terminal.rows - 2);
			if (matchesKey(data, "pageUp")) {
				this.scrollBy(page);
				return;
			}
			if (matchesKey(data, "pageDown")) {
				this.scrollBy(-page);
				return;
			}
		}

		if (!focusIsOverlay) {
			const restoreState = this.getVisibleOverlayFocusRestore();
			if (restoreState.status === "eligible") {
				this.setFocus(restoreState.overlay.component);
			} else if (restoreState.status === "blocked" && restoreState.blockedBy !== this.focusedComponent) {
				if (restoreState.resume.status === "restore-overlay") {
					this.setFocus(restoreState.overlay.component);
				} else {
					this.clearOverlayFocusRestore();
					this.setFocus(restoreState.resume.target);
				}
			}
		}

		// Pass input to focused component (including Ctrl+C)
		// The focused component can decide how to handle Ctrl+C
		if (this.focusedComponent?.handleInput) {
			// Filter out key release events unless component opts in
			if (isKeyRelease(data) && !this.focusedComponent.wantsKeyRelease) {
				return;
			}
			this.focusedComponent.handleInput(data);
			this.requestRender();
		}
	}

	private consumeOsc11BackgroundResponse(data: string): boolean {
		if (this.pendingOsc11BackgroundReplies <= 0) {
			return false;
		}

		if (!isOsc11BackgroundColorResponse(data)) {
			return false;
		}

		const rgb = parseOsc11BackgroundColor(data);
		this.pendingOsc11BackgroundReplies -= 1;
		const query = this.pendingOsc11BackgroundQueries.shift();
		if (query && !query.settled) {
			query.settled = true;
			if (query.timer) {
				clearTimeout(query.timer);
				query.timer = undefined;
			}
			query.resolve?.(rgb);
			query.resolve = undefined;
		}
		return true;
	}

	private consumeTerminalColorSchemeReport(data: string): boolean {
		const scheme = parseTerminalColorSchemeReport(data);
		if (!scheme) {
			return false;
		}

		for (const listener of this.terminalColorSchemeListeners) {
			listener(scheme);
		}
		return true;
	}

	private consumeCellSizeResponse(data: string): boolean {
		// Response format: ESC [ 6 ; height ; width t
		const match = data.match(/^\x1b\[6;(\d+);(\d+)t$/);
		if (!match) {
			return false;
		}

		const heightPx = parseInt(match[1], 10);
		const widthPx = parseInt(match[2], 10);
		if (heightPx <= 0 || widthPx <= 0) {
			return true;
		}

		setCellDimensions({ widthPx, heightPx });
		// Invalidate all components so images re-render with correct dimensions.
		this.invalidate();
		this.requestRender();
		return true;
	}

	/**
	 * Resolve overlay layout from options.
	 * Returns { width, row, col, maxHeight } for rendering.
	 */
	private resolveOverlayLayout(
		options: OverlayOptions | undefined,
		overlayHeight: number,
		termWidth: number,
		termHeight: number,
	): { width: number; row: number; col: number; maxHeight: number | undefined } {
		const opt = options ?? {};

		// Parse margin (clamp to non-negative)
		const margin =
			typeof opt.margin === "number"
				? { top: opt.margin, right: opt.margin, bottom: opt.margin, left: opt.margin }
				: (opt.margin ?? {});
		const marginTop = Math.max(0, margin.top ?? 0);
		const marginRight = Math.max(0, margin.right ?? 0);
		const marginBottom = Math.max(0, margin.bottom ?? 0);
		const marginLeft = Math.max(0, margin.left ?? 0);

		// Available space after margins
		const availWidth = Math.max(1, termWidth - marginLeft - marginRight);
		const availHeight = Math.max(1, termHeight - marginTop - marginBottom);

		// === Resolve width ===
		let width = parseSizeValue(opt.width, termWidth) ?? Math.min(80, availWidth);
		// Apply minWidth
		if (opt.minWidth !== undefined) {
			width = Math.max(width, opt.minWidth);
		}
		// Clamp to available space
		width = Math.max(1, Math.min(width, availWidth));

		// === Resolve maxHeight ===
		let maxHeight = parseSizeValue(opt.maxHeight, termHeight);
		// Clamp to available space
		if (maxHeight !== undefined) {
			maxHeight = Math.max(1, Math.min(maxHeight, availHeight));
		}

		// Effective overlay height (may be clamped by maxHeight)
		const effectiveHeight = maxHeight !== undefined ? Math.min(overlayHeight, maxHeight) : overlayHeight;

		// === Resolve position ===
		let row: number;
		let col: number;

		if (opt.row !== undefined) {
			if (typeof opt.row === "string") {
				// Percentage: 0% = top, 100% = bottom (overlay stays within bounds)
				const match = opt.row.match(/^(\d+(?:\.\d+)?)%$/);
				if (match) {
					const maxRow = Math.max(0, availHeight - effectiveHeight);
					const percent = parseFloat(match[1]) / 100;
					row = marginTop + Math.floor(maxRow * percent);
				} else {
					// Invalid format, fall back to center
					row = this.resolveAnchorRow("center", effectiveHeight, availHeight, marginTop);
				}
			} else {
				// Absolute row position
				row = opt.row;
			}
		} else {
			// Anchor-based (default: center)
			const anchor = opt.anchor ?? "center";
			row = this.resolveAnchorRow(anchor, effectiveHeight, availHeight, marginTop);
		}

		if (opt.col !== undefined) {
			if (typeof opt.col === "string") {
				// Percentage: 0% = left, 100% = right (overlay stays within bounds)
				const match = opt.col.match(/^(\d+(?:\.\d+)?)%$/);
				if (match) {
					const maxCol = Math.max(0, availWidth - width);
					const percent = parseFloat(match[1]) / 100;
					col = marginLeft + Math.floor(maxCol * percent);
				} else {
					// Invalid format, fall back to center
					col = this.resolveAnchorCol("center", width, availWidth, marginLeft);
				}
			} else {
				// Absolute column position
				col = opt.col;
			}
		} else {
			// Anchor-based (default: center)
			const anchor = opt.anchor ?? "center";
			col = this.resolveAnchorCol(anchor, width, availWidth, marginLeft);
		}

		// Apply offsets
		if (opt.offsetY !== undefined) row += opt.offsetY;
		if (opt.offsetX !== undefined) col += opt.offsetX;

		// Clamp to terminal bounds (respecting margins)
		row = Math.max(marginTop, Math.min(row, termHeight - marginBottom - effectiveHeight));
		col = Math.max(marginLeft, Math.min(col, termWidth - marginRight - width));

		return { width, row, col, maxHeight };
	}

	private resolveAnchorRow(anchor: OverlayAnchor, height: number, availHeight: number, marginTop: number): number {
		switch (anchor) {
			case "top-left":
			case "top-center":
			case "top-right":
				return marginTop;
			case "bottom-left":
			case "bottom-center":
			case "bottom-right":
				return marginTop + availHeight - height;
			case "left-center":
			case "center":
			case "right-center":
				return marginTop + Math.floor((availHeight - height) / 2);
		}
	}

	private resolveAnchorCol(anchor: OverlayAnchor, width: number, availWidth: number, marginLeft: number): number {
		switch (anchor) {
			case "top-left":
			case "left-center":
			case "bottom-left":
				return marginLeft;
			case "top-right":
			case "right-center":
			case "bottom-right":
				return marginLeft + availWidth - width;
			case "top-center":
			case "center":
			case "bottom-center":
				return marginLeft + Math.floor((availWidth - width) / 2);
		}
	}

	/** Composite all overlays into content lines (sorted by focusOrder, higher = on top). */
	private compositeOverlays(lines: string[], termWidth: number, termHeight: number): string[] {
		this.lastOverlayHits = [];
		if (this.overlayStack.length === 0) return lines;
		const result = [...lines];

		// Pre-render all visible overlays and calculate positions
		const rendered: { component: Component; overlayLines: string[]; row: number; col: number; w: number }[] = [];
		let minLinesNeeded = result.length;

		const visibleEntries = this.overlayStack.filter((e) => this.isOverlayVisible(e));
		visibleEntries.sort((a, b) => a.focusOrder - b.focusOrder);
		for (const entry of visibleEntries) {
			const { component, options } = entry;

			// Get layout with height=0 first to determine width and maxHeight
			// (width and maxHeight don't depend on overlay height)
			const { width, maxHeight } = this.resolveOverlayLayout(options, 0, termWidth, termHeight);

			// Render component at calculated width
			let overlayLines = component.render(width);

			// Apply maxHeight if specified
			if (maxHeight !== undefined && overlayLines.length > maxHeight) {
				overlayLines = overlayLines.slice(0, maxHeight);
			}

			// Get final row/col with actual overlay height
			const { row, col } = this.resolveOverlayLayout(options, overlayLines.length, termWidth, termHeight);

			rendered.push({ component, overlayLines, row, col, w: width });
			if (isMouseAware(component)) {
				this.lastOverlayHits.push({ component, startRow: row, endRow: row + overlayLines.length, col, width });
			}
			minLinesNeeded = Math.max(minLinesNeeded, row + overlayLines.length);
		}

		// Pad to at least terminal height so overlays have screen-relative positions.
		// Excludes maxLinesRendered: the historical high-water mark caused self-reinforcing
		// inflation that pushed content into scrollback on terminal widen.
		const workingHeight = Math.max(result.length, termHeight, minLinesNeeded);

		// Extend result with empty lines if content is too short for overlay placement or working area
		while (result.length < workingHeight) {
			result.push("");
		}

		const viewportStart = Math.max(0, workingHeight - termHeight);

		// Dim the visible background behind backdrop overlays (semi-transparent scrim).
		// Each cell's fg/bg is resolved to RGB and blended toward black, so foreground
		// text and background color blocks darken together. Applied before compositing:
		// compositeLineAt resets style before the overlay text, so the overlay itself
		// stays at full brightness. Image lines can't be alpha-blended (they're a
		// graphics protocol, not cells), so they are hidden under a blank scrim row.
		if (visibleEntries.some((e) => e.options?.backdrop)) {
			const blank = dimLineToScrim("", termWidth, BACKDROP_SCRIM);
			for (let idx = viewportStart; idx < result.length; idx++) {
				const line = result[idx];
				result[idx] = line && !isImageLine(line) ? dimLineToScrim(line, termWidth, BACKDROP_SCRIM) : blank;
			}
		}

		// Composite each overlay
		for (const { overlayLines, row, col, w } of rendered) {
			for (let i = 0; i < overlayLines.length; i++) {
				const idx = viewportStart + row + i;
				if (idx >= 0 && idx < result.length) {
					// Defensive: truncate overlay line to declared width before compositing
					// (components should already respect width, but this ensures it)
					const truncatedOverlayLine =
						visibleWidth(overlayLines[i]) > w ? sliceByColumn(overlayLines[i], 0, w, true) : overlayLines[i];
					result[idx] = this.compositeLineAt(result[idx], truncatedOverlayLine, col, w, termWidth);
				}
			}
		}

		return result;
	}

	private static readonly SEGMENT_RESET = "\x1b[0m\x1b]8;;\x07";

	private applyLineResets(lines: string[]): string[] {
		const reset = TUI.SEGMENT_RESET;
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (!isImageLine(line)) {
				lines[i] = normalizeTerminalOutput(line) + reset;
			}
		}
		return lines;
	}

	private tryRenderAppScrollShift(
		newLines: string[],
		cursorPos: { row: number; col: number } | null,
		height: number,
		previousWindowTop: number,
		currentWindowTop: number,
	): boolean {
		const preferViewportShift = this.scrollPrefersViewportShift;
		this.scrollPrefersViewportShift = false;
		if (!preferViewportShift || !this.appScroll || this.overlayStack.length > 0 || this.hasSelection) {
			return false;
		}
		if (height <= 0 || this.previousLines.length !== height || newLines.length !== height) {
			return false;
		}
		const windowDelta = currentWindowTop - previousWindowTop;
		if (windowDelta === 0) {
			return false;
		}
		const scrollRows = Math.abs(windowDelta);
		if (scrollRows >= height) {
			return false;
		}
		if (this.previousLines.some(isImageLine) || newLines.some(isImageLine)) {
			return false;
		}

		const shiftedLines =
			windowDelta > 0
				? this.previousLines.slice(scrollRows).concat(Array.from({ length: scrollRows }, () => ""))
				: Array.from({ length: scrollRows }, () => "").concat(this.previousLines.slice(0, height - scrollRows));
		const changedRows: number[] = [];
		for (let row = 0; row < height; row++) {
			if (shiftedLines[row] !== newLines[row]) {
				changedRows.push(row);
			}
		}

		// This path is meant for pure viewport movement. If content changed enough
		// that most rows need repainting, the normal differential renderer is safer.
		if (changedRows.length > Math.max(scrollRows + 4, Math.ceil(height / 2))) {
			return false;
		}

		let buffer = "\x1b[?2026h\x1b[H";
		buffer += windowDelta > 0 ? `\x1b[${scrollRows}M` : `\x1b[${scrollRows}L`;
		let finalCursorRow = 0;
		for (const row of changedRows) {
			buffer += `\x1b[${row + 1};1H\x1b[2K${newLines[row]}`;
			finalCursorRow = row;
		}
		buffer += "\x1b[?2026l";
		this.terminal.write(buffer);

		this.cursorRow = Math.max(0, newLines.length - 1);
		this.hardwareCursorRow = finalCursorRow;
		this.maxLinesRendered = Math.max(this.maxLinesRendered, newLines.length);
		this.previousViewportTop = 0;
		this.positionHardwareCursor(cursorPos, newLines.length);
		this.previousLines = newLines;
		this.previousKittyImageIds = this.collectKittyImageIds(newLines);
		this.previousWidth = this.terminal.columns;
		this.previousHeight = height;
		return true;
	}

	private collectKittyImageIds(lines: string[]): Set<number> {
		const ids = new Set<number>();
		for (const line of lines) {
			for (const id of extractKittyImageIds(line)) {
				ids.add(id);
			}
		}
		return ids;
	}

	private deleteKittyImages(ids: Iterable<number>): string {
		let buffer = "";
		for (const id of ids) {
			buffer += deleteKittyImage(id);
		}
		return buffer;
	}

	private getKittyImageReservedRows(lines: string[], index: number, maxIndex = lines.length - 1): number {
		const rows = extractKittyImageRows(lines[index] ?? "");
		if (rows <= 1) return 1;

		const maxRows = Math.min(rows, maxIndex - index + 1, lines.length - index);
		let reservedRows = 1;
		while (reservedRows < maxRows) {
			const line = lines[index + reservedRows] ?? "";
			if (isImageLine(line) || visibleWidth(line) > 0) break;
			reservedRows++;
		}
		return reservedRows;
	}

	private expandChangedRangeForKittyImages(
		firstChanged: number,
		lastChanged: number,
		newLines: string[],
	): { firstChanged: number; lastChanged: number } {
		let expandedFirstChanged = firstChanged;
		let expandedLastChanged = lastChanged;
		const expandForLines = (lines: string[]): void => {
			for (let i = 0; i < lines.length; i++) {
				if (extractKittyImageIds(lines[i]).length === 0) continue;
				const blockEnd = i + this.getKittyImageReservedRows(lines, i) - 1;
				if (i >= firstChanged || (i <= lastChanged && blockEnd >= firstChanged)) {
					expandedFirstChanged = Math.min(expandedFirstChanged, i);
					expandedLastChanged = Math.max(expandedLastChanged, blockEnd);
				}
			}
		};

		expandForLines(this.previousLines);
		expandForLines(newLines);
		return { firstChanged: expandedFirstChanged, lastChanged: expandedLastChanged };
	}

	private deleteChangedKittyImages(firstChanged: number, lastChanged: number): string {
		if (firstChanged < 0 || lastChanged < firstChanged) return "";

		const ids = new Set<number>();
		const maxLine = Math.min(lastChanged, this.previousLines.length - 1);
		for (let i = firstChanged; i <= maxLine; i++) {
			for (const id of extractKittyImageIds(this.previousLines[i] ?? "")) {
				ids.add(id);
			}
		}

		return this.deleteKittyImages(ids);
	}

	/** Splice overlay content into a base line at a specific column. Single-pass optimized. */
	private compositeLineAt(
		baseLine: string,
		overlayLine: string,
		startCol: number,
		overlayWidth: number,
		totalWidth: number,
	): string {
		if (isImageLine(baseLine)) return baseLine;

		// Single pass through baseLine extracts both before and after segments
		const afterStart = startCol + overlayWidth;
		const base = extractSegments(baseLine, startCol, afterStart, totalWidth - afterStart, true);

		// Extract overlay with width tracking (strict=true to exclude wide chars at boundary)
		const overlay = sliceWithWidth(overlayLine, 0, overlayWidth, true);

		// Pad segments to target widths
		const beforePad = Math.max(0, startCol - base.beforeWidth);
		const overlayPad = Math.max(0, overlayWidth - overlay.width);
		const actualBeforeWidth = Math.max(startCol, base.beforeWidth);
		const actualOverlayWidth = Math.max(overlayWidth, overlay.width);
		const afterTarget = Math.max(0, totalWidth - actualBeforeWidth - actualOverlayWidth);
		const afterPad = Math.max(0, afterTarget - base.afterWidth);

		// Compose result
		const r = TUI.SEGMENT_RESET;
		const result =
			base.before +
			" ".repeat(beforePad) +
			r +
			overlay.text +
			" ".repeat(overlayPad) +
			r +
			base.after +
			" ".repeat(afterPad);

		// CRITICAL: Always verify and truncate to terminal width.
		// This is the final safeguard against width overflow which would crash the TUI.
		// Width tracking can drift from actual visible width due to:
		// - Complex ANSI/OSC sequences (hyperlinks, colors)
		// - Wide characters at segment boundaries
		// - Edge cases in segment extraction
		const resultWidth = visibleWidth(result);
		if (resultWidth <= totalWidth) {
			return result;
		}
		// Truncate with strict=true to ensure we don't exceed totalWidth
		return sliceByColumn(result, 0, totalWidth, true);
	}

	/**
	 * Find and extract cursor position from rendered lines.
	 * Searches for CURSOR_MARKER, calculates its position, and strips it from the output.
	 * Only scans the bottom terminal height lines (visible viewport).
	 * @param lines - Rendered lines to search
	 * @param height - Terminal height (visible viewport size)
	 * @returns Cursor position { row, col } or null if no marker found
	 */
	private extractCursorPosition(lines: string[], height: number): { row: number; col: number } | null {
		// Only scan the bottom `height` lines (visible viewport)
		const viewportTop = Math.max(0, lines.length - height);
		for (let row = lines.length - 1; row >= viewportTop; row--) {
			const line = lines[row];
			const markerIndex = line.indexOf(CURSOR_MARKER);
			if (markerIndex !== -1) {
				// Calculate visual column (width of text before marker)
				const beforeMarker = line.slice(0, markerIndex);
				const col = visibleWidth(beforeMarker);

				// Strip marker from the line
				lines[row] = line.slice(0, markerIndex) + line.slice(markerIndex + CURSOR_MARKER.length);

				return { row, col };
			}
		}
		return null;
	}

	private doRender(): void {
		if (this.stopped) return;
		const width = this.terminal.columns;
		const height = this.terminal.rows;
		const widthChanged = this.previousWidth !== 0 && this.previousWidth !== width;
		const heightChanged = this.previousHeight !== 0 && this.previousHeight !== height;
		const previousBufferLength = this.previousHeight > 0 ? this.previousViewportTop + this.previousHeight : height;
		let prevViewportTop = heightChanged ? Math.max(0, previousBufferLength - height) : this.previousViewportTop;
		let viewportTop = prevViewportTop;
		let hardwareCursorRow = this.hardwareCursorRow;
		const computeLineDiff = (targetRow: number): number => {
			const currentScreenRow = hardwareCursorRow - prevViewportTop;
			const targetScreenRow = targetRow - viewportTop;
			return targetScreenRow - currentScreenRow;
		};

		// Render all components to get new lines. In app-scroll mode we also collect
		// mouse-hit ranges and collapse the full content to a height-sized window.
		// In the alternate screen this window IS the screen, so the existing
		// differential logic maps window row i directly to terminal row i.
		const previousWindowTop = this.lastWindowTop;
		let newLines: string[];
		if (this.appScroll) {
			// Reserve a blank column margin on each side for a "page" look. Content
			// (and hit/selection columns) live in content space [0, contentWidth);
			// the left margin is prefixed only to the final displayed lines, and
			// mouse x is shifted back by marginX in handleMouseInput.
			const marginX = this.marginX;
			const contentWidth = Math.max(1, width - marginX * 2);
			const r = this.renderWithHits(contentWidth, 0);
			this.lastHits = r.hits;
			this.lastFullLines = r.lines;
			newLines = this.applyScrollWindow(r.lines, height);
			// Paint the active text selection over the visible window.
			if (this.hasSelection) {
				newLines = this.applySelectionHighlight(newLines);
			}
			if (marginX > 0) {
				const pad = " ".repeat(marginX);
				newLines = newLines.map((line) => pad + line);
			}
			newLines = this.addScrollIndicators(newLines);
		} else {
			newLines = this.render(width);
		}

		// Composite overlays into the rendered lines (before differential compare)
		if (this.overlayStack.length > 0) {
			newLines = this.compositeOverlays(newLines, width, height);
		}

		// Extract cursor position before applying line resets (marker must be found first)
		const cursorPos = this.extractCursorPosition(newLines, height);

		newLines = this.applyLineResets(newLines);

		// Helper to clear scrollback and viewport and render all new lines
		const fullRender = (clear: boolean): void => {
			this.fullRedrawCount += 1;
			let buffer = "\x1b[?2026h"; // Begin synchronized output
			if (clear) {
				buffer += this.deleteKittyImages(this.previousKittyImageIds);
				buffer += "\x1b[2J\x1b[H\x1b[3J"; // Clear screen, home, then clear scrollback
			}
			for (let i = 0; i < newLines.length; i++) {
				if (i > 0) buffer += "\r\n";
				const line = newLines[i];
				const isImage = isImageLine(line);
				const imageReservedRows = isImage ? this.getKittyImageReservedRows(newLines, i) : 1;
				if (imageReservedRows > 1 && imageReservedRows <= height) {
					for (let row = 1; row < imageReservedRows; row++) {
						buffer += "\r\n";
					}
					buffer += `\x1b[${imageReservedRows - 1}A`;
					buffer += line;
					buffer += `\x1b[${imageReservedRows - 1}B`;
					i += imageReservedRows - 1;
					continue;
				}
				buffer += line;
			}
			buffer += "\x1b[?2026l"; // End synchronized output
			this.terminal.write(buffer);
			this.cursorRow = Math.max(0, newLines.length - 1);
			this.hardwareCursorRow = this.cursorRow;
			// Reset max lines when clearing, otherwise track growth
			if (clear) {
				this.maxLinesRendered = newLines.length;
			} else {
				this.maxLinesRendered = Math.max(this.maxLinesRendered, newLines.length);
			}
			const bufferLength = Math.max(height, newLines.length);
			this.previousViewportTop = Math.max(0, bufferLength - height);
			this.positionHardwareCursor(cursorPos, newLines.length);
			this.previousLines = newLines;
			this.previousKittyImageIds = this.collectKittyImageIds(newLines);
			this.previousWidth = width;
			this.previousHeight = height;
		};

		const debugRedraw = process.env.PIX_DEBUG_REDRAW === "1";
		const logRedraw = (reason: string): void => {
			if (!debugRedraw) return;
			const logPath = path.join(os.homedir(), ".pix", "agent", "pix-debug.log");
			const msg = `[${new Date().toISOString()}] fullRender: ${reason} (prev=${this.previousLines.length}, new=${newLines.length}, height=${height})\n`;
			fs.appendFileSync(logPath, msg);
		};

		// First render - just output everything without clearing (assumes clean screen)
		if (this.previousLines.length === 0 && !widthChanged && !heightChanged) {
			logRedraw("first render");
			fullRender(false);
			return;
		}

		// Width changes always need a full re-render because wrapping changes.
		if (widthChanged) {
			logRedraw(`terminal width changed (${this.previousWidth} -> ${width})`);
			fullRender(true);
			return;
		}

		// Height changes normally need a full re-render to keep the visible viewport aligned,
		// but Termux changes height when the software keyboard shows or hides.
		// In that environment, a full redraw causes the entire history to replay on every toggle.
		if (heightChanged && !isTermuxSession()) {
			logRedraw(`terminal height changed (${this.previousHeight} -> ${height})`);
			fullRender(true);
			return;
		}

		// Content shrunk below the working area and no overlays - re-render to clear empty rows
		// (overlays need the padding, so only do this when no overlays are active)
		// Configurable via setClearOnShrink() or PIX_CLEAR_ON_SHRINK=0 env var
		if (this.clearOnShrink && newLines.length < this.maxLinesRendered && this.overlayStack.length === 0) {
			logRedraw(`clearOnShrink (maxLinesRendered=${this.maxLinesRendered})`);
			fullRender(true);
			return;
		}

		if (this.tryRenderAppScrollShift(newLines, cursorPos, height, previousWindowTop, this.lastWindowTop)) {
			return;
		}

		// Find first and last changed lines
		let firstChanged = -1;
		let lastChanged = -1;
		const maxLines = Math.max(newLines.length, this.previousLines.length);
		for (let i = 0; i < maxLines; i++) {
			const oldLine = i < this.previousLines.length ? this.previousLines[i] : "";
			const newLine = i < newLines.length ? newLines[i] : "";

			if (oldLine !== newLine) {
				if (firstChanged === -1) {
					firstChanged = i;
				}
				lastChanged = i;
			}
		}
		const appendedLines = newLines.length > this.previousLines.length;
		if (appendedLines) {
			if (firstChanged === -1) {
				firstChanged = this.previousLines.length;
			}
			lastChanged = newLines.length - 1;
		}
		if (firstChanged !== -1) {
			const expandedRange = this.expandChangedRangeForKittyImages(firstChanged, lastChanged, newLines);
			firstChanged = expandedRange.firstChanged;
			lastChanged = expandedRange.lastChanged;
		}
		const appendStart = appendedLines && firstChanged === this.previousLines.length && firstChanged > 0;

		// No changes - but still need to update hardware cursor position if it moved
		if (firstChanged === -1) {
			this.positionHardwareCursor(cursorPos, newLines.length);
			this.previousViewportTop = prevViewportTop;
			this.previousHeight = height;
			return;
		}

		// All changes are in deleted lines (nothing to render, just clear)
		if (firstChanged >= newLines.length) {
			if (this.previousLines.length > newLines.length) {
				let buffer = "\x1b[?2026h";
				buffer += this.deleteChangedKittyImages(firstChanged, lastChanged);
				// Move to end of new content (clamp to 0 for empty content)
				const targetRow = Math.max(0, newLines.length - 1);
				if (targetRow < prevViewportTop) {
					logRedraw(`deleted lines moved viewport up (${targetRow} < ${prevViewportTop})`);
					fullRender(true);
					return;
				}
				const lineDiff = computeLineDiff(targetRow);
				if (lineDiff > 0) buffer += `\x1b[${lineDiff}B`;
				else if (lineDiff < 0) buffer += `\x1b[${-lineDiff}A`;
				buffer += "\r";
				// Clear extra lines without scrolling
				const extraLines = this.previousLines.length - newLines.length;
				if (extraLines > height) {
					logRedraw(`extraLines > height (${extraLines} > ${height})`);
					fullRender(true);
					return;
				}
				const clearStartOffset = newLines.length === 0 ? 0 : 1;
				if (extraLines > 0 && clearStartOffset > 0) {
					buffer += `\x1b[${clearStartOffset}B`;
				}
				for (let i = 0; i < extraLines; i++) {
					buffer += "\r\x1b[2K";
					if (i < extraLines - 1) buffer += "\x1b[1B";
				}
				const moveBack = Math.max(0, extraLines - 1 + clearStartOffset);
				if (moveBack > 0) {
					buffer += `\x1b[${moveBack}A`;
				}
				buffer += "\x1b[?2026l";
				this.terminal.write(buffer);
				this.cursorRow = targetRow;
				this.hardwareCursorRow = targetRow;
			}
			this.positionHardwareCursor(cursorPos, newLines.length);
			this.previousLines = newLines;
			this.previousKittyImageIds = this.collectKittyImageIds(newLines);
			this.previousWidth = width;
			this.previousHeight = height;
			this.previousViewportTop = prevViewportTop;
			return;
		}

		// Differential rendering can only touch what was actually visible.
		// If the first changed line is above the previous viewport, we need a full redraw.
		if (firstChanged < prevViewportTop) {
			logRedraw(`firstChanged < viewportTop (${firstChanged} < ${prevViewportTop})`);
			fullRender(true);
			return;
		}

		// Render from first changed line to end
		// Build buffer with all updates wrapped in synchronized output
		let buffer = "\x1b[?2026h"; // Begin synchronized output
		buffer += this.deleteChangedKittyImages(firstChanged, lastChanged);
		const prevViewportBottom = prevViewportTop + height - 1;
		const moveTargetRow = appendStart ? firstChanged - 1 : firstChanged;
		if (moveTargetRow > prevViewportBottom) {
			const currentScreenRow = Math.max(0, Math.min(height - 1, hardwareCursorRow - prevViewportTop));
			const moveToBottom = height - 1 - currentScreenRow;
			if (moveToBottom > 0) {
				buffer += `\x1b[${moveToBottom}B`;
			}
			const scroll = moveTargetRow - prevViewportBottom;
			buffer += "\r\n".repeat(scroll);
			prevViewportTop += scroll;
			viewportTop += scroll;
			hardwareCursorRow = moveTargetRow;
		}

		// Move cursor to first changed line (use hardwareCursorRow for actual position)
		const lineDiff = computeLineDiff(moveTargetRow);
		if (lineDiff > 0) {
			buffer += `\x1b[${lineDiff}B`; // Move down
		} else if (lineDiff < 0) {
			buffer += `\x1b[${-lineDiff}A`; // Move up
		}

		buffer += appendStart ? "\r\n" : "\r"; // Move to column 0

		// Only render changed lines (firstChanged to lastChanged), not all lines to end
		// This reduces flicker when only a single line changes (e.g., spinner animation)
		const renderEnd = Math.min(lastChanged, newLines.length - 1);
		for (let i = firstChanged; i <= renderEnd; i++) {
			if (i > firstChanged) buffer += "\r\n";
			const line = newLines[i];
			const isImage = isImageLine(line);
			const imageReservedRows = isImage ? this.getKittyImageReservedRows(newLines, i, renderEnd) : 1;
			if (imageReservedRows > 1) {
				const imageStartScreenRow = i - viewportTop;
				if (imageStartScreenRow < 0 || imageStartScreenRow + imageReservedRows > height) {
					logRedraw(
						`kitty image pre-clear would scroll (${imageStartScreenRow} + ${imageReservedRows} > ${height})`,
					);
					fullRender(true);
					return;
				}

				buffer += "\x1b[2K";
				for (let row = 1; row < imageReservedRows; row++) {
					buffer += "\r\n\x1b[2K";
				}
				buffer += `\x1b[${imageReservedRows - 1}A`;
				buffer += line;
				buffer += `\x1b[${imageReservedRows - 1}B`;
				i += imageReservedRows - 1;
				continue;
			}

			buffer += "\x1b[2K"; // Clear current line
			if (!isImage && visibleWidth(line) > width) {
				// Log all lines to crash file for debugging
				const crashLogPath = path.join(os.homedir(), ".pix", "agent", "pix-crash.log");
				const crashData = [
					`Crash at ${new Date().toISOString()}`,
					`Terminal width: ${width}`,
					`Line ${i} visible width: ${visibleWidth(line)}`,
					"",
					"=== All rendered lines ===",
					...newLines.map((l, idx) => `[${idx}] (w=${visibleWidth(l)}) ${l}`),
					"",
				].join("\n");
				fs.mkdirSync(path.dirname(crashLogPath), { recursive: true });
				fs.writeFileSync(crashLogPath, crashData);

				// Clean up terminal state before throwing
				this.stop();

				const errorMsg = [
					`Rendered line ${i} exceeds terminal width (${visibleWidth(line)} > ${width}).`,
					"",
					"This is likely caused by a custom TUI component not truncating its output.",
					"Use visibleWidth() to measure and truncateToWidth() to truncate lines.",
					"",
					`Debug log written to: ${crashLogPath}`,
				].join("\n");
				throw new Error(errorMsg);
			}
			buffer += line;
		}

		// Track where cursor ended up after rendering
		let finalCursorRow = renderEnd;

		// If we had more lines before, clear them and move cursor back
		if (this.previousLines.length > newLines.length) {
			// Move to end of new content first if we stopped before it
			if (renderEnd < newLines.length - 1) {
				const moveDown = newLines.length - 1 - renderEnd;
				buffer += `\x1b[${moveDown}B`;
				finalCursorRow = newLines.length - 1;
			}
			const extraLines = this.previousLines.length - newLines.length;
			for (let i = newLines.length; i < this.previousLines.length; i++) {
				buffer += "\r\n\x1b[2K";
			}
			// Move cursor back to end of new content
			buffer += `\x1b[${extraLines}A`;
		}

		buffer += "\x1b[?2026l"; // End synchronized output

		if (process.env.PIX_TUI_DEBUG === "1") {
			const debugDir = "/tmp/tui";
			fs.mkdirSync(debugDir, { recursive: true });
			const debugPath = path.join(debugDir, `render-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
			const debugData = [
				`firstChanged: ${firstChanged}`,
				`viewportTop: ${viewportTop}`,
				`cursorRow: ${this.cursorRow}`,
				`height: ${height}`,
				`lineDiff: ${lineDiff}`,
				`hardwareCursorRow: ${hardwareCursorRow}`,
				`renderEnd: ${renderEnd}`,
				`finalCursorRow: ${finalCursorRow}`,
				`cursorPos: ${JSON.stringify(cursorPos)}`,
				`newLines.length: ${newLines.length}`,
				`previousLines.length: ${this.previousLines.length}`,
				"",
				"=== newLines ===",
				JSON.stringify(newLines, null, 2),
				"",
				"=== previousLines ===",
				JSON.stringify(this.previousLines, null, 2),
				"",
				"=== buffer ===",
				JSON.stringify(buffer),
			].join("\n");
			fs.writeFileSync(debugPath, debugData);
		}

		// Write entire buffer at once
		this.terminal.write(buffer);

		// Track cursor position for next render
		// cursorRow tracks end of content (for viewport calculation)
		// hardwareCursorRow tracks actual terminal cursor position (for movement)
		this.cursorRow = Math.max(0, newLines.length - 1);
		this.hardwareCursorRow = finalCursorRow;
		// Track terminal's working area (grows but doesn't shrink unless cleared)
		this.maxLinesRendered = Math.max(this.maxLinesRendered, newLines.length);
		this.previousViewportTop = Math.max(prevViewportTop, finalCursorRow - height + 1);

		// Position hardware cursor for IME
		this.positionHardwareCursor(cursorPos, newLines.length);

		this.previousLines = newLines;
		this.previousKittyImageIds = this.collectKittyImageIds(newLines);
		this.previousWidth = width;
		this.previousHeight = height;
	}

	/**
	 * Position the hardware cursor for IME candidate window.
	 * @param cursorPos The cursor position extracted from rendered output, or null
	 * @param totalLines Total number of rendered lines
	 */
	private positionHardwareCursor(cursorPos: { row: number; col: number } | null, totalLines: number): void {
		if (!cursorPos || totalLines <= 0) {
			this.terminal.hideCursor();
			return;
		}

		// Clamp cursor position to valid range
		const targetRow = Math.max(0, Math.min(cursorPos.row, totalLines - 1));
		const targetCol = Math.max(0, cursorPos.col);

		// Move cursor from current position to target
		const rowDelta = targetRow - this.hardwareCursorRow;
		let buffer = "";
		if (rowDelta > 0) {
			buffer += `\x1b[${rowDelta}B`; // Move down
		} else if (rowDelta < 0) {
			buffer += `\x1b[${-rowDelta}A`; // Move up
		}
		// Move to absolute column (1-indexed)
		buffer += `\x1b[${targetCol + 1}G`;

		if (buffer) {
			this.terminal.write(buffer);
		}

		this.hardwareCursorRow = targetRow;
		if (this.showHardwareCursor) {
			this.terminal.showCursor();
		} else {
			this.terminal.hideCursor();
		}
	}

	/**
	 * Query the terminal's default background color with OSC 11 (`ESC ] 11 ; ? BEL`).
	 * @param timeoutMs Query timeout in milliseconds.
	 * @returns Promise containing the parsed RGB color, or undefined if it times out or fails to parse.
	 */
	queryTerminalBackgroundColor({ timeoutMs }: { timeoutMs: number }): Promise<RgbColor | undefined> {
		return new Promise((resolve) => {
			const query: PendingOsc11BackgroundQuery = {
				settled: false,
				resolve,
				timer: undefined,
			};

			query.timer = setTimeout(() => {
				if (query.settled) {
					return;
				}
				query.settled = true;
				query.timer = undefined;
				query.resolve?.(undefined);
				query.resolve = undefined;
			}, timeoutMs);
			this.pendingOsc11BackgroundQueries.push(query);
			this.pendingOsc11BackgroundReplies += 1;
			this.terminal.write("\x1b]11;?\x07");
		});
	}

	/**
	 * Query the terminal's color-scheme preference with DSR (`CSI ? 996 n`).
	 * Terminals that support the color palette notification protocol reply with
	 * `CSI ? 997 ; 1 n` for dark or `CSI ? 997 ; 2 n` for light.
	 */
	queryTerminalColorScheme({ timeoutMs }: { timeoutMs: number }): Promise<TerminalColorScheme | undefined> {
		return new Promise((resolve) => {
			let settled = false;
			let timer: NodeJS.Timeout | undefined;
			let unsubscribe: () => void = () => {};
			const settle = (scheme: TerminalColorScheme | undefined) => {
				if (settled) return;
				settled = true;
				if (timer) {
					clearTimeout(timer);
					timer = undefined;
				}
				unsubscribe();
				resolve(scheme);
			};

			unsubscribe = this.onTerminalColorSchemeChange(settle);
			timer = setTimeout(() => settle(undefined), timeoutMs);
			this.terminal.write("\x1b[?996n");
		});
	}
}
