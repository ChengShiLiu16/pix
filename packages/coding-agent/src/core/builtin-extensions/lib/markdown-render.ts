import type { AssistantMessage } from "@chengshiliu16/pix-ai";
import {
	type AnsiStyleSegment,
	probeAnsiStyle,
	Text,
	visibleWidth,
	wrapTextWithAnsi,
	wrapWithScopedStyle,
} from "@chengshiliu16/pix-tui";

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
const MULTI_COLUMN_LIST_MIN_WIDTH = 88;
const MULTI_COLUMN_LIST_GAP = 4;

interface MarkdownFence {
	character: "`" | "~";
	length: number;
	info: string;
}

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

function parseMarkdownFence(line: string): MarkdownFence | undefined {
	const match = line.match(/^\s{0,3}(`{3,}|~{3,})[ \t]*(.*)$/);
	if (!match) return undefined;

	const marker = match[1] ?? "";
	const info = match[2] ?? "";
	if (marker.startsWith("`") && info.includes("`")) return undefined;
	return {
		character: marker[0] as "`" | "~",
		length: marker.length,
		info,
	};
}

function closesMarkdownFence(fence: MarkdownFence, opener: MarkdownFence): boolean {
	return fence.character === opener.character && fence.length >= opener.length && !fence.info.trim();
}

function isStandaloneMarkdownBlock(line: string): boolean {
	if (!line.trim()) return true;
	if (/^(?: {4,}|\t)/.test(line)) return true;
	if (/^\s{0,3}(?:#{1,6}\s+|>|[-*+]\s+|\d+[.)]\s+|`{3,}|~{3,})/.test(line)) return true;
	if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) return true;
	if (/^\s*\|.*\|\s*$/.test(line)) return true;
	return /^\s*</.test(line);
}

/** CommonMark soft line breaks belong to the same paragraph in terminal output. */
function joinMarkdownParagraphLines(text: string): string {
	const lines = text.split("\n");
	const output: string[] = [];
	let paragraph = "";
	let codeFence: MarkdownFence | undefined;

	const flushParagraph = (): void => {
		if (!paragraph) return;
		output.push(paragraph);
		paragraph = "";
	};

	for (const line of lines) {
		const fence = parseMarkdownFence(line);
		if (codeFence) {
			flushParagraph();
			output.push(line);
			if (fence && closesMarkdownFence(fence, codeFence)) codeFence = undefined;
			continue;
		}
		if (fence) {
			flushParagraph();
			output.push(line);
			codeFence = fence;
			continue;
		}

		if (isStandaloneMarkdownBlock(line)) {
			flushParagraph();
			output.push(line);
			continue;
		}

		if (!paragraph) {
			paragraph = line;
			continue;
		}

		if (/(?: {2,}|\\)$/.test(paragraph)) {
			output.push(paragraph);
			paragraph = line;
			continue;
		}

		paragraph = `${paragraph.trimEnd()} ${line.trimStart()}`;
	}

	flushParagraph();
	return output.join("\n");
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
		/^[ \t]*(```)/,
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
	if (maxWidth === undefined) return naturalWidths;
	if (tableVisibleWidth(naturalWidths) < maxWidth) {
		const widths = [...naturalWidths];
		const widestNaturalWidth = Math.max(...naturalWidths);
		const flexibleColumns = naturalWidths
			.map((width, index) => ({ width, index }))
			.filter((column) => column.width === widestNaturalWidth)
			.map((column) => column.index);
		let remaining = maxWidth - tableVisibleWidth(widths);
		for (let index = 0; remaining > 0; index += 1) {
			const columnIndex = flexibleColumns[index % flexibleColumns.length];
			if (columnIndex === undefined) break;
			widths[columnIndex] = (widths[columnIndex] ?? 1) + 1;
			remaining -= 1;
		}
		return widths;
	}
	if (tableVisibleWidth(naturalWidths) === maxWidth) return naturalWidths;

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

function renderTerminalMarkdownLine(line: string, styler: TerminalMarkdownStyler, maxWidth?: number): string[] {
	const trimmed = line.trim();
	if (!trimmed) return [""];

	const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
	if (heading) {
		const level = heading[1]?.length ?? 1;
		const title = styleInlineMarkdown(heading[2] ?? "", styler);
		if (level <= 2) {
			const titleWidth = visibleWidth(title);
			const ruleWidth = Math.max(0, (maxWidth ?? titleWidth) - titleWidth - 1);
			return [ruleWidth > 0 ? `${styler.title(title)} ${styler.mdHr("─".repeat(ruleWidth))}` : styler.title(title)];
		}
		return [`${styler.mdListBullet("▸")} ${styler.bold(styleBodyText(title, styler))}`];
	}

	if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(trimmed)) return [styler.mdHr("─".repeat(Math.max(1, maxWidth ?? 16)))];

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

function isMarkdownHorizontalRule(line: string): boolean {
	return /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line);
}

function nextNonBlankLine(lines: string[], startIndex: number): string | undefined {
	for (let index = startIndex; index < lines.length; index += 1) {
		if (lines[index]?.trim()) return lines[index];
	}
	return undefined;
}

function renderCodeFenceOpening(fence: MarkdownFence, styler: TerminalMarkdownStyler, maxWidth?: number): string {
	const language = fence.info.trim();
	if (maxWidth === undefined || maxWidth < 6) {
		return language ? `${styler.mdCodeBlockBorder("╭─")} ${styler.mdCode(language)}` : styler.mdCodeBlockBorder("╭─");
	}

	const prefix = language
		? `${styler.mdCodeBlockBorder("╭─")} ${styler.mdCode(language)} `
		: styler.mdCodeBlockBorder("╭");
	const ruleWidth = Math.max(0, maxWidth - visibleWidth(prefix) - 1);
	return `${prefix}${styler.mdCodeBlockBorder(`${"─".repeat(ruleWidth)}╮`)}`;
}

function renderCodeFenceBody(line: string, styler: TerminalMarkdownStyler, maxWidth?: number): string[] {
	const styledLine = styleBodyText(line, styler);
	if (maxWidth === undefined || maxWidth < 6) {
		return [`${styler.mdCodeBlockBorder("│")} ${styledLine}`];
	}

	const contentWidth = maxWidth - 4;
	const wrapped = wrapTextWithAnsi(styledLine, contentWidth);
	const bodyLines = wrapped.length > 0 ? wrapped : [""];
	return bodyLines.map(
		(bodyLine) =>
			`${styler.mdCodeBlockBorder("│")} ${padTableCell(bodyLine, contentWidth)} ${styler.mdCodeBlockBorder("│")}`,
	);
}

function renderCodeFenceClosing(styler: TerminalMarkdownStyler, maxWidth?: number): string {
	if (maxWidth === undefined || maxWidth < 6) return styler.mdCodeBlockBorder("╰─");
	return styler.mdCodeBlockBorder(`╰${"─".repeat(maxWidth - 2)}╯`);
}

function renderResponsiveBulletList(
	lines: string[],
	startIndex: number,
	styler: TerminalMarkdownStyler,
	maxWidth?: number,
): { lines: string[]; nextIndex: number } | undefined {
	if (maxWidth === undefined || maxWidth < MULTI_COLUMN_LIST_MIN_WIDTH) return undefined;

	const items: string[] = [];
	let index = startIndex;
	while (index < lines.length) {
		const match = lines[index]?.match(/^[-*+]\s+(?!\[[ xX]\]\s)(.+)$/);
		if (!match) break;
		items.push(match[1] ?? "");
		index += 1;
	}
	if (items.length < 4) return undefined;

	const leftWidth = Math.floor((maxWidth - MULTI_COLUMN_LIST_GAP) / 2);
	const rightWidth = maxWidth - MULTI_COLUMN_LIST_GAP - leftWidth;
	const renderedItems = items.map(
		(item) => `${styler.mdListBullet("•")} ${styleBodyText(styleInlineMarkdown(item, styler), styler)}`,
	);
	if (renderedItems.some((item) => visibleWidth(item) > Math.min(leftWidth, rightWidth))) return undefined;

	const gap = " ".repeat(MULTI_COLUMN_LIST_GAP);
	const rendered: string[] = [];
	for (let itemIndex = 0; itemIndex < renderedItems.length; itemIndex += 2) {
		const left = renderedItems[itemIndex] ?? "";
		const right = renderedItems[itemIndex + 1];
		rendered.push(right === undefined ? left : `${padTableCell(left, leftWidth)}${gap}${right}`);
	}

	return { lines: rendered, nextIndex: index };
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
	const lines = joinMarkdownParagraphLines(normalizeMarkdownVariants(text)).split("\n");
	const output: string[] = [];
	const styler = createTerminalMarkdownStyler(theme);
	let codeFence: MarkdownFence | undefined;

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] ?? "";
		const fence = parseMarkdownFence(line);
		if (codeFence) {
			if (fence && closesMarkdownFence(fence, codeFence)) {
				output.push(renderCodeFenceClosing(styler, maxWidth));
				codeFence = undefined;
			} else {
				output.push(...renderCodeFenceBody(line, styler, maxWidth));
			}
			continue;
		}
		if (fence) {
			output.push(renderCodeFenceOpening(fence, styler, maxWidth));
			codeFence = fence;
			continue;
		}
		if (isMarkdownHorizontalRule(line) && /^\s*#{1,2}\s+/.test(nextNonBlankLine(lines, index + 1) ?? "")) continue;

		const table = renderTerminalTable(lines, index, styler, maxWidth);
		if (table) {
			output.push(...table.lines);
			index = table.nextIndex - 1;
			continue;
		}

		const responsiveList = renderResponsiveBulletList(lines, index, styler, maxWidth);
		if (responsiveList) {
			output.push(...responsiveList.lines);
			index = responsiveList.nextIndex - 1;
			continue;
		}

		output.push(...renderTerminalMarkdownLine(line, styler, maxWidth));
	}

	if (codeFence) output.push(renderCodeFenceClosing(styler, maxWidth));
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
