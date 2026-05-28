import type { AssistantMessage } from "@earendil-works/pix-ai";
import {
	type AnsiStyleSegment,
	probeAnsiStyle,
	Text,
	visibleWidth,
	wrapTextWithAnsi,
	wrapWithScopedStyle,
} from "@earendil-works/pix-tui";

export type MarkdownTheme = unknown;

export type MarkdownStyle = {
	color?: (text: string) => string;
	italic?: boolean;
};

export type NarrativeThemeLike = {
	fg(name: string, text: string): string;
	bold(text: string): string;
};

export type RenderNarrativeOptions = {
	isPartial?: boolean;
	message?: AssistantMessage;
	markdownTheme?: MarkdownTheme;
	terminalTheme?: NarrativeThemeLike;
	paddingX?: number;
	paddingY?: number;
	markdownStyle?: MarkdownStyle;
};

const STREAMING_TIMESTAMPS = new Set<number>();
const FINALIZED_TIMESTAMPS = new Set<number>();

const UNICODE_HR_PATTERN = /^[ \t]*[\u2500\u2501─━]{3,}[ \t]*$/gm;
const UNICODE_BLOCKQUOTE_PATTERN = /^[ \t]*[\u2502│](?!.*\|[ \t]*$)\s?(.*)$/gm;
const TABLE_SEPARATOR_CELL_PATTERN = /^:?-{3,}:?$/;
const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;

function assistantTimestamp(message: AssistantMessage): number | undefined {
	const timestamp = (message as { timestamp?: unknown }).timestamp;
	return typeof timestamp === "number" ? timestamp : undefined;
}

export function resetAssistantMarkdownStreamingState(): void {
	STREAMING_TIMESTAMPS.clear();
	FINALIZED_TIMESTAMPS.clear();
}

export function markAssistantMessageStreaming(message: AssistantMessage): void {
	const timestamp = assistantTimestamp(message);
	if (timestamp === undefined) return;
	STREAMING_TIMESTAMPS.add(timestamp);
	FINALIZED_TIMESTAMPS.delete(timestamp);
}

export function markAssistantMessageFinalized(message: AssistantMessage): void {
	const timestamp = assistantTimestamp(message);
	if (timestamp === undefined) return;
	STREAMING_TIMESTAMPS.delete(timestamp);
	FINALIZED_TIMESTAMPS.add(timestamp);
}

export function clearAssistantMarkdownStreamingState(): void {
	STREAMING_TIMESTAMPS.clear();
}

/** Keep timestamp tracking aligned with the message currently being rendered. */
export function syncAssistantMarkdownStreamingState(message: AssistantMessage): void {
	if (message.stopReason !== undefined) {
		markAssistantMessageFinalized(message);
	}
}

/**
 * Assistant messages stream until message_end. stopReason is the primary signal,
 * but shallow message copies during message_update can omit it until the UI event
 * runs. Timestamp-based streaming/finalized tracking keeps partial vs complete reliable.
 */
export function isAssistantMessagePartial(message: AssistantMessage): boolean {
	if (message.stopReason !== undefined) return false;
	const timestamp = assistantTimestamp(message);
	if (timestamp !== undefined) {
		if (FINALIZED_TIMESTAMPS.has(timestamp)) return false;
		if (STREAMING_TIMESTAMPS.has(timestamp)) return true;
	}
	// Historical / rehydrated messages (session reload, compaction rebuild) are complete.
	return false;
}

function normalizeMarkdownVariants(text: string): string {
	let prepared = text.replace(/\r\n/g, "\n").replace(/\t/g, "   ");

	prepared = prepared.replace(/^([^\n]+)\n(=|-){3,}\s*$/gm, (_match, title: string, marker: string) => {
		const level = marker === "=" ? 1 : 2;
		return `${"#".repeat(level)} ${title.trim()}`;
	});

	prepared = prepared.replace(UNICODE_HR_PATTERN, "---");
	prepared = prepared.replace(UNICODE_BLOCKQUOTE_PATTERN, (_match, body: string) => `> ${body.trimStart()}`);
	prepared = prepared.replace(/^([ \t]*)([•◦▪‣])\s+/gm, "$1- ");

	return prepared;
}

/** Insert blank lines before block elements when models omit them (marked requirement). */
export function prepareMarkdownForRender(text: string): string {
	if (!text) return text;

	const prepared = normalizeMarkdownVariants(text);

	const blockPatterns = [
		/^(#{1,6}\s+\S)/,
		/^(\|[^\n]+\|)\s*$/,
		/^(\|[-:\s|]+\|)\s*$/,
		/^([-*+]\s+\S)/,
		/^(\d+\.\s+\S)/,
		/^([-*+]\s+\[[ xX]\]\s+\S)/,
		/^(```)/,
		/^(>{1,}\s+\S)/,
		/^(-{3,}|\*{3,}|_{3,})\s*$/,
	];

	const lines = prepared.split("\n");
	const output: string[] = [];

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!;
		const previous = output[output.length - 1];
		const needsBlankLine =
			previous !== undefined && previous.trim() !== "" && blockPatterns.some((pattern) => pattern.test(line));

		if (needsBlankLine && output[output.length - 1] !== "") {
			output.push("");
		}
		output.push(line);
	}

	return output.join("\n");
}

function createTerminalMarkdownStyler(theme?: NarrativeThemeLike) {
	// Wrap theme.fg / theme.bold so a styled span sustains its color across any
	// inner ANSI reset emitted by nested inline spans (code, link, bold). Without
	// this, an inner `\e[39m` would drop the outer fg color mid-line — the visible
	// symptom was H1/H2 text after an inline code segment falling back to default fg.
	//
	// Segments are probed once per styler instance and cached because the theme
	// reference is stable for the lifetime of a single render.
	const fgSegments = new Map<string, AnsiStyleSegment>();
	const fgSegmentOf = (name: string): AnsiStyleSegment => {
		let seg = fgSegments.get(name);
		if (seg === undefined) {
			seg = probeAnsiStyle((t) => theme?.fg(name, t) ?? t);
			fgSegments.set(name, seg);
		}
		return seg;
	};
	let boldSegment: AnsiStyleSegment | undefined;
	const boldSegmentOf = (): AnsiStyleSegment => {
		if (boldSegment === undefined) {
			boldSegment = probeAnsiStyle((t) => theme?.bold(t) ?? t);
		}
		return boldSegment;
	};
	const fg = (name: string, text: string): string => wrapWithScopedStyle(fgSegmentOf(name), text);
	const bold = (text: string): string => wrapWithScopedStyle(boldSegmentOf(), text);
	return {
		plain: (text: string): string => text,
		text: (text: string): string => fg("text", text),
		muted: (text: string): string => fg("muted", text),
		dim: (text: string): string => fg("dim", text),
		success: (text: string): string => fg("success", text),
		warning: (text: string): string => fg("warning", text),
		mdHeading: (text: string): string => fg("mdHeading", text),
		mdLink: (text: string): string => fg("mdLink", text),
		mdLinkUrl: (text: string): string => fg("mdLinkUrl", text),
		mdCode: (text: string): string => fg("mdCode", text),
		mdCodeBlockBorder: (text: string): string => fg("mdCodeBlockBorder", text),
		mdQuoteBorder: (text: string): string => fg("mdQuoteBorder", text),
		mdHr: (text: string): string => fg("mdHr", text),
		mdListBullet: (text: string): string => fg("mdListBullet", text),
		title: (text: string): string => bold(fg("mdHeading", text)),
		bold,
	};
}

type TerminalMarkdownStyler = ReturnType<typeof createTerminalMarkdownStyler>;

function stripInlineMarkdown(text: string): string {
	return text
		.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
		.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
		.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
		.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/(?<![\w/.-])\*(?!\*)(?=\S)([\s\S]*?\S)(?<!\*)\*(?![\w/.-])/g, "$1")
		.replace(/(?<![\w/.-])_(?!_)(?=\S)([\s\S]*?\S)(?<!_)_(?![\w/.-])/g, "$1")
		.replace(/\\([\\`*_[\]{}()#+\-.!|>])/g, "$1");
}

function styleInlineMarkdown(text: string, styler: TerminalMarkdownStyler): string {
	return text
		.replace(/!\[([^\]]*)\]\([^)]+\)/g, (_match, label: string) => styler.dim(label))
		.replace(
			/\[([^\]]+)\]\(([^)]+)\)/g,
			(_match, label: string, url: string) => `${styler.mdLink(label)} ${styler.mdLinkUrl(`(${url})`)}`,
		)
		.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, (_match, _marker: string, body: string) => styler.bold(body))
		.replace(/~~(?=\S)([\s\S]*?\S)~~/g, (_match, body: string) => styler.dim(body))
		.replace(/`([^`]+)`/g, (_match, body: string) => styler.bold(styler.mdCode(body)))
		.replace(/(?<![\w/.-])\*(?!\*)(?=\S)([\s\S]*?\S)(?<!\*)\*(?![\w/.-])/g, (_match, body: string) => body)
		.replace(/(?<![\w/.-])_(?!_)(?=\S)([\s\S]*?\S)(?<!_)_(?![\w/.-])/g, (_match, body: string) => body)
		.replace(/\\([\\`*_[\]{}()#+\-.!|>])/g, "$1");
}

function parseAnsiSgrParams(sequence: string): number[] {
	const body = sequence.slice(2, -1);
	if (!body) return [0];

	return body.split(";").map((value) => {
		const parsed = Number.parseInt(value || "0", 10);
		return Number.isFinite(parsed) ? parsed : 0;
	});
}

function updateAnsiForegroundActive(sequence: string, active: boolean): boolean {
	if (!sequence.endsWith("m")) return active;

	const params = parseAnsiSgrParams(sequence);
	let nextActive = active;
	for (let index = 0; index < params.length; index++) {
		const code = params[index] ?? 0;
		if (code === 0 || code === 39) {
			nextActive = false;
			continue;
		}
		if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
			nextActive = true;
			continue;
		}
		if (code === 38) {
			nextActive = true;
			const mode = params[index + 1];
			if (mode === 5) index += 2;
			else if (mode === 2) index += 4;
			continue;
		}
		if (code === 48) {
			const mode = params[index + 1];
			if (mode === 5) index += 2;
			else if (mode === 2) index += 4;
		}
	}
	return nextActive;
}

function stylePlainTextChunk(text: string, styler: TerminalMarkdownStyler): string {
	return text ? styler.text(text) : "";
}

function styleBodyText(text: string, styler: TerminalMarkdownStyler): string {
	let output = "";
	let lastIndex = 0;
	let foregroundActive = false;

	for (const match of text.matchAll(ANSI_PATTERN)) {
		const index = match.index ?? 0;
		const chunk = text.slice(lastIndex, index);
		output += foregroundActive ? chunk : stylePlainTextChunk(chunk, styler);

		const sequence = match[0] ?? "";
		output += sequence;
		foregroundActive = updateAnsiForegroundActive(sequence, foregroundActive);
		lastIndex = index + sequence.length;
	}

	const tail = text.slice(lastIndex);
	output += foregroundActive ? tail : stylePlainTextChunk(tail, styler);
	return output;
}

function splitTableRow(line: string): string[] {
	const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
	const cells: string[] = [];
	let cell = "";
	let escaped = false;

	for (const char of trimmed) {
		if (escaped) {
			cell += char;
			escaped = false;
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (char === "|") {
			cells.push(cell.trim());
			cell = "";
			continue;
		}
		cell += char;
	}

	cells.push(cell.trim());
	return cells;
}

function isTableSeparatorLine(line: string): boolean {
	const cells = splitTableRow(line).map((cell) => stripInlineMarkdown(cell).replace(/\s/g, ""));
	return cells.length > 1 && cells.every((cell) => TABLE_SEPARATOR_CELL_PATTERN.test(cell));
}

function isTableRow(line: string): boolean {
	return splitTableRow(line).length > 1 && line.includes("|");
}

function tableBorder(
	left: string,
	middle: string,
	right: string,
	widths: number[],
	styler: TerminalMarkdownStyler,
): string {
	return styler.mdCodeBlockBorder(`${left}${widths.map((width) => "─".repeat(width + 2)).join(middle)}${right}`);
}

function tableVisibleWidth(widths: number[]): number {
	return widths.reduce((sum, width) => sum + width, 0) + widths.length * 3 + 1;
}

function tableColumnWeight(width: number): number {
	return Math.sqrt(Math.max(1, width));
}

function distributeTableColumnWidth(widths: number[], naturalWidths: number[], remainingWidth: number): void {
	let remaining = remainingWidth;
	while (remaining > 0) {
		const expandable = widths
			.map((width, index) => ({ index, capacity: (naturalWidths[index] ?? 1) - width }))
			.filter((column) => column.capacity > 0);
		if (expandable.length === 0) break;

		const totalWeight = expandable.reduce(
			(sum, column) => sum + tableColumnWeight(naturalWidths[column.index] ?? 1),
			0,
		);
		const additions = expandable.map((column) => {
			const exactShare = (remaining * tableColumnWeight(naturalWidths[column.index] ?? 1)) / totalWeight;
			const width = Math.min(column.capacity, Math.floor(exactShare));
			return { ...column, width, remainder: exactShare - width };
		});

		let used = 0;
		for (const addition of additions) {
			if (addition.width <= 0) continue;
			widths[addition.index] = (widths[addition.index] ?? 1) + addition.width;
			used += addition.width;
		}

		if (used === 0) {
			const next = additions.sort((left, right) => right.remainder - left.remainder)[0];
			if (!next) break;
			widths[next.index] = (widths[next.index] ?? 1) + 1;
			used = 1;
		}

		remaining -= used;
	}
}

function fitTableColumnWidths(naturalWidths: number[], maxWidth?: number): number[] {
	if (maxWidth === undefined || tableVisibleWidth(naturalWidths) <= maxWidth) return naturalWidths;

	const columnCount = naturalWidths.length;
	const availableContentWidth = Math.max(columnCount, maxWidth - (columnCount * 3 + 1));
	const minimumWidth = availableContentWidth >= columnCount * 6 ? 6 : 1;
	const widths = naturalWidths.map((width) => Math.min(width, minimumWidth));
	const remaining = availableContentWidth - widths.reduce((sum, width) => sum + width, 0);
	distributeTableColumnWidth(widths, naturalWidths, remaining);

	return widths;
}

function wrapTableCell(cell: string, width: number): string[] {
	const wrapped = wrapTextWithAnsi(cell, Math.max(1, width));
	return wrapped.length > 0 ? wrapped : [""];
}

function padTableCell(cell: string, width: number): string {
	return `${cell}${" ".repeat(Math.max(0, width - visibleWidth(cell)))}`;
}

function styleTableCell(cell: string, styler: TerminalMarkdownStyler, header: boolean): string {
	const styledCell = styleBodyText(styleInlineMarkdown(cell, styler), styler);
	return header ? styler.bold(styledCell) : styledCell;
}

function tableDataRows(cells: string[], widths: number[], styler: TerminalMarkdownStyler, header = false): string[] {
	const border = styler.mdCodeBlockBorder("│");
	const wrappedCells = widths.map((width, index) =>
		wrapTableCell(styleTableCell(cells[index] ?? "", styler, header), width),
	);
	const rowHeight = Math.max(1, ...wrappedCells.map((cellLines) => cellLines.length));
	return Array.from({ length: rowHeight }, (_value, rowIndex) => {
		const rowCells = widths.map((width, columnIndex) =>
			padTableCell(wrappedCells[columnIndex]?.[rowIndex] ?? "", width),
		);
		return `${border} ${rowCells.join(` ${border} `)} ${border}`;
	});
}

function tableBodyRows(rows: string[][], widths: number[], styler: TerminalMarkdownStyler): string[] {
	return rows.flatMap((row, index) => {
		const rendered = tableDataRows(row, widths, styler);
		if (index === rows.length - 1) return rendered;
		return [...rendered, tableBorder("├", "┼", "┤", widths, styler)];
	});
}

function renderTerminalTable(
	lines: string[],
	startIndex: number,
	styler: TerminalMarkdownStyler,
	maxWidth?: number,
): { lines: string[]; nextIndex: number } | undefined {
	if (!isTableRow(lines[startIndex] ?? "") || !isTableSeparatorLine(lines[startIndex + 1] ?? "")) return undefined;

	const rows: string[][] = [splitTableRow(lines[startIndex] ?? "")];
	let index = startIndex + 2;
	while (index < lines.length && isTableRow(lines[index] ?? "")) {
		rows.push(splitTableRow(lines[index] ?? ""));
		index++;
	}

	const columnCount = Math.max(...rows.map((row) => row.length));
	const naturalWidths = Array.from({ length: columnCount }, (_value, columnIndex) =>
		Math.max(1, ...rows.map((row) => visibleWidth(stripInlineMarkdown(row[columnIndex] ?? "")))),
	);
	const widths = fitTableColumnWidths(naturalWidths, maxWidth);

	const rendered = [
		tableBorder("┌", "┬", "┐", widths, styler),
		...tableDataRows(rows[0] ?? [], widths, styler, true),
		tableBorder("├", "┼", "┤", widths, styler),
		...tableBodyRows(rows.slice(1), widths, styler),
		tableBorder("└", "┴", "┘", widths, styler),
	];

	return { lines: rendered, nextIndex: index };
}

function renderTerminalMarkdownLine(line: string, styler: TerminalMarkdownStyler): string[] {
	const trimmed = line.trim();
	if (!trimmed) return [""];

	const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
	if (heading) {
		const level = heading[1]?.length ?? 1;
		const title = styleInlineMarkdown(heading[2] ?? "", styler);
		if (level <= 2) {
			return [styler.title(title), styler.mdHr("─".repeat(Math.max(3, visibleWidth(title))))];
		}
		return [`${styler.mdListBullet("▸")} ${styler.bold(styleBodyText(title, styler))}`];
	}

	if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(trimmed)) return [styler.mdHr("────────────────")];

	const blockquote = line.match(/^\s*>\s?(.*)$/);
	if (blockquote)
		return [`${styler.mdQuoteBorder("│")} ${styler.dim(styleInlineMarkdown(blockquote[1] ?? "", styler))}`];

	const task = line.match(/^(\s*)[-*+]\s+\[([ xX])\]\s+(.+)$/);
	if (task) {
		const checked = task[2]?.toLowerCase() === "x";
		return [
			`${task[1] ?? ""}${checked ? styler.success("✓") : styler.mdListBullet("□")} ${styleBodyText(styleInlineMarkdown(task[3] ?? "", styler), styler)}`,
		];
	}

	const bullet = line.match(/^(\s*)[-*+]\s+(.+)$/);
	if (bullet)
		return [
			`${bullet[1] ?? ""}${styler.mdListBullet("•")} ${styleBodyText(styleInlineMarkdown(bullet[2] ?? "", styler), styler)}`,
		];

	const ordered = line.match(/^(\s*)(\d+)[.)]\s+(.+)$/);
	if (ordered)
		return [
			`${ordered[1] ?? ""}${styler.mdListBullet(`${ordered[2] ?? "1"}.`)} ${styleBodyText(styleInlineMarkdown(ordered[3] ?? "", styler), styler)}`,
		];

	return [styleBodyText(styleInlineMarkdown(line, styler), styler)];
}

function collapseBlankLines(lines: string[]): string[] {
	const output: string[] = [];
	for (const line of lines) {
		if (line === "" && output[output.length - 1] === "") continue;
		output.push(line);
	}
	while (output[0] === "") output.shift();
	while (output[output.length - 1] === "") output.pop();
	return output;
}

export function formatMarkdownForTerminalText(text: string, theme?: NarrativeThemeLike, maxWidth?: number): string {
	const lines = normalizeMarkdownVariants(text).split("\n");
	const output: string[] = [];
	const styler = createTerminalMarkdownStyler(theme);
	let inCodeFence = false;

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] ?? "";
		const fence = line.match(/^```\s*([^`]*)\s*$/);
		if (fence) {
			if (inCodeFence) {
				output.push(styler.mdCodeBlockBorder("╰─"));
				inCodeFence = false;
			} else {
				const language = fence[1]?.trim();
				output.push(
					language
						? `${styler.mdCodeBlockBorder("╭─")} ${styler.mdCode(language)}`
						: styler.mdCodeBlockBorder("╭─"),
				);
				inCodeFence = true;
			}
			continue;
		}

		if (inCodeFence) {
			output.push(`${styler.mdCodeBlockBorder("│")} ${styleBodyText(line, styler)}`);
			continue;
		}

		const table = renderTerminalTable(lines, index, styler, maxWidth);
		if (table) {
			output.push(...table.lines);
			index = table.nextIndex - 1;
			continue;
		}

		output.push(...renderTerminalMarkdownLine(line, styler));
	}

	if (inCodeFence) output.push(styler.mdCodeBlockBorder("╰─"));
	return collapseBlankLines(output).join("\n");
}

class ResponsiveMarkdownText extends Text {
	private readonly sourceText: string;
	private readonly terminalTheme: NarrativeThemeLike | undefined;
	private readonly horizontalPadding: number;
	private formattedContentWidth?: number;

	constructor(
		sourceText: string,
		terminalTheme: NarrativeThemeLike | undefined,
		horizontalPadding: number,
		paddingY: number,
	) {
		super(formatMarkdownForTerminalText(sourceText, terminalTheme), horizontalPadding, paddingY);
		this.sourceText = sourceText;
		this.terminalTheme = terminalTheme;
		this.horizontalPadding = horizontalPadding;
	}

	override render(width: number): string[] {
		const contentWidth = Math.max(1, width - this.horizontalPadding * 2);
		if (this.formattedContentWidth !== contentWidth) {
			this.setText(formatMarkdownForTerminalText(this.sourceText, this.terminalTheme, contentWidth));
			this.formattedContentWidth = contentWidth;
		}
		return super.render(width);
	}
}

function resolvePartialRendering(options: RenderNarrativeOptions): boolean {
	if (options.message) {
		syncAssistantMarkdownStreamingState(options.message);
	}
	if (options.message?.stopReason !== undefined) {
		return false;
	}
	if (options.isPartial !== undefined) {
		return options.isPartial;
	}
	if (options.message) {
		return isAssistantMessagePartial(options.message);
	}
	return false;
}

/**
 * Render narrative / analysis text. Uses raw Text while streaming (partial),
 * and terminal-friendly Markdown conversion once the message is complete.
 */
export function renderNarrativeMarkdown(text: string, options: RenderNarrativeOptions = {}): Text {
	const trimmed = text.trim();
	const paddingX = options.paddingX ?? 1;
	const paddingY = options.paddingY ?? 0;

	if (!trimmed) {
		return new Text("", paddingX, paddingY);
	}

	if (resolvePartialRendering(options)) {
		return new Text(trimmed, paddingX, paddingY);
	}

	return new ResponsiveMarkdownText(trimmed, options.terminalTheme, paddingX, paddingY);
}
