import { applyScopedStyle, probeAnsiStyle, wrapWithScopedStyle } from "@earendil-works/pix-tui";
import { describe, expect, it } from "vitest";
import { formatMarkdownForTerminalText } from "../src/core/builtin-extensions/lib/markdown-render.ts";

// Fake narrative theme: each color name maps to a distinct 256-color fg so we
// can assert specific open/close sequences in the output. `bold` uses SGR 1/22
// like chalk does. Any color not in the table falls through unstyled, which
// also exercises the no-op probe path.
const FG_CODES: Record<string, string> = {
	mdHeading: "\x1b[38;5;110m",
	mdCode: "\x1b[38;5;180m",
	mdLink: "\x1b[38;5;75m",
	mdLinkUrl: "\x1b[38;5;240m",
	mdHr: "\x1b[38;5;240m",
	mdListBullet: "\x1b[38;5;240m",
	mdCodeBlockBorder: "\x1b[38;5;240m",
	mdQuoteBorder: "\x1b[38;5;240m",
	text: "\x1b[38;5;255m",
	muted: "\x1b[38;5;245m",
	dim: "\x1b[38;5;240m",
	success: "\x1b[38;5;82m",
	warning: "\x1b[38;5;220m",
	error: "\x1b[38;5;196m",
};
const FG_CLOSE = "\x1b[39m";
const BOLD_OPEN = "\x1b[1m";
const BOLD_CLOSE = "\x1b[22m";

const fakeTheme = {
	fg(name: string, text: string): string {
		const open = FG_CODES[name];
		return open ? `${open}${text}${FG_CLOSE}` : text;
	},
	bold(text: string): string {
		return `${BOLD_OPEN}${text}${BOLD_CLOSE}`;
	},
};

describe("probeAnsiStyle / wrapWithScopedStyle", () => {
	it("extracts open/close and reset codes from a chalk-style wrapper", () => {
		const seg = probeAnsiStyle((t) => `\x1b[31m${t}\x1b[39m`);
		expect(seg.open).toBe("\x1b[31m");
		expect(seg.close).toBe("\x1b[39m");
		// resetCodes always contains 0 plus whatever the close sequence carries.
		expect(seg.resetCodes.has(0)).toBe(true);
		expect(seg.resetCodes.has(39)).toBe(true);
	});

	it("returns empty open/close for a no-op styler", () => {
		const seg = probeAnsiStyle((t) => t);
		expect(seg.open).toBe("");
		expect(seg.close).toBe("");
		expect(wrapWithScopedStyle(seg, "abc")).toBe("abc");
	});

	it("re-opens base style after every matching inner reset", () => {
		const seg = probeAnsiStyle((t) => `\x1b[35m${t}\x1b[39m`);
		const body = `outer-${`\x1b[36minner\x1b[39m`}-tail`;
		const result = wrapWithScopedStyle(seg, body);
		// After the inner \e[39m there must be an immediate re-open of the outer fg.
		expect(result).toContain("\x1b[39m\x1b[35m");
		// And the whole thing is wrapped with the outer pair.
		expect(result.startsWith("\x1b[35m")).toBe(true);
		expect(result.endsWith("\x1b[39m")).toBe(true);
	});

	it("treats SGR 0 (full reset) as a closing code", () => {
		const seg = probeAnsiStyle((t) => `\x1b[1m${t}\x1b[22m`);
		const result = wrapWithScopedStyle(seg, `keep-\x1b[0m-tail`);
		expect(result).toContain("\x1b[0m\x1b[1m");
	});

	it("leaves unrelated SGR sequences untouched", () => {
		const seg = probeAnsiStyle((t) => `\x1b[35m${t}\x1b[39m`); // fg, resetCodes ~ {0, 39}
		const result = wrapWithScopedStyle(seg, `a\x1b[22mb`); // \e[22m closes bold, not fg
		expect(result).not.toContain("\x1b[22m\x1b[35m");
		expect(result).toContain("\x1b[22m");
	});

	it("handles multi-parameter SGR (e.g. 0;31) where any param is a reset", () => {
		const seg = probeAnsiStyle((t) => `\x1b[35m${t}\x1b[39m`);
		const result = wrapWithScopedStyle(seg, `a\x1b[0;31mb`);
		expect(result).toContain("\x1b[0;31m\x1b[35m");
	});

	it("applyScopedStyle composes probe + wrap", () => {
		const result = applyScopedStyle((t) => `\x1b[35m${t}\x1b[39m`, `a\x1b[36mb\x1b[39mc`);
		expect(result).toBe("\x1b[35ma\x1b[36mb\x1b[39m\x1b[35mc\x1b[39m");
	});
});

describe("formatMarkdownForTerminalText sustained color", () => {
	function lastIndexOf(haystack: string, needle: string): number {
		return haystack.lastIndexOf(needle);
	}

	it("keeps mdHeading color across inline code inside an H2", () => {
		const out = formatMarkdownForTerminalText("## intro `code` tail", fakeTheme);
		const headingFg = FG_CODES.mdHeading!;
		const codeFg = FG_CODES.mdCode!;
		// Sanity: both colors appear.
		expect(out).toContain(headingFg);
		expect(out).toContain(codeFg);
		// The inline-code's closing \e[39m must be followed by a re-open of the
		// heading fg, otherwise " tail" would render in terminal default fg.
		const codeClose = out.indexOf(`${FG_CLOSE}`, out.indexOf(codeFg));
		expect(codeClose).toBeGreaterThan(-1);
		expect(out.slice(codeClose, codeClose + FG_CLOSE.length + headingFg.length)).toBe(`${FG_CLOSE}${headingFg}`);
		// Tail text appears after that re-open.
		const tailIndex = out.indexOf("tail");
		expect(tailIndex).toBeGreaterThan(codeClose);
	});

	it("keeps mdHeading color across inline code inside an H1", () => {
		const out = formatMarkdownForTerminalText("# title `x` end", fakeTheme);
		const headingFg = FG_CODES.mdHeading!;
		// At least one re-open of heading fg after a \e[39m must exist.
		expect(out).toContain(`${FG_CLOSE}${headingFg}`);
	});

	it("keeps bold active across an inner \\e[22m emitted by nested **bold**", () => {
		// Inside an H1, the outer styler.title() opens bold; an inline **x** would
		// emit \e[22m mid-line. Use a paragraph with inline bold inside a heading.
		const out = formatMarkdownForTerminalText("## a **b** c", fakeTheme);
		// At least one \e[22m must be followed by \e[1m re-open to maintain bold.
		const boldCloseIdx = out.indexOf(BOLD_CLOSE);
		expect(boldCloseIdx).toBeGreaterThan(-1);
		expect(out.slice(boldCloseIdx, boldCloseIdx + BOLD_CLOSE.length + BOLD_OPEN.length)).toBe(
			`${BOLD_CLOSE}${BOLD_OPEN}`,
		);
	});

	it("keeps dim (mdQuoteBorder is its own thing — verify quote body via styler.dim)", () => {
		// blockquote body uses styler.dim(styleInlineMarkdown(...)). styler.dim is
		// fg("dim", ...), so an inner inline-code reset should be followed by the
		// dim fg re-open.
		const out = formatMarkdownForTerminalText("> quoted `code` tail", fakeTheme);
		const dimFg = FG_CODES.dim!;
		expect(out).toContain(dimFg);
		expect(out).toContain(`${FG_CLOSE}${dimFg}`);
		// "tail" should appear after a dim re-open.
		const lastDimOpen = lastIndexOf(out, dimFg);
		expect(out.indexOf("tail")).toBeGreaterThan(lastDimOpen);
	});

	it("emits no ANSI when theme is omitted", () => {
		const out = formatMarkdownForTerminalText("## intro `code` tail", undefined);
		expect(out).not.toContain("\x1b[");
	});

	it("handles multiple inline spans (code + link + code) without dropping heading fg", () => {
		const out = formatMarkdownForTerminalText("## a `x` [l](u) `y` z", fakeTheme);
		const headingFg = FG_CODES.mdHeading!;
		// Every \e[39m inside the heading line should re-open heading fg.
		const headingLineEnd = out.indexOf("\n") === -1 ? out.length : out.indexOf("\n");
		const headingLine = out.slice(0, headingLineEnd);
		const resets = [...headingLine.matchAll(/\x1b\[39m/g)];
		// The very last \e[39m closes the heading itself; every earlier one must
		// be immediately followed by a heading re-open.
		for (let i = 0; i < resets.length - 1; i++) {
			const at = resets[i].index ?? 0;
			expect(headingLine.slice(at, at + FG_CLOSE.length + headingFg.length)).toBe(`${FG_CLOSE}${headingFg}`);
		}
	});
});
