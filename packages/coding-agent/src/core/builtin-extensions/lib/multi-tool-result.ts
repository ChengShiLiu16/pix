import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "../../tools/truncate.ts";

export { truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize };

export function contentHasMarkedErrors(text: string): boolean {
	return /(?:^|\n)ERROR: /m.test(text);
}

export function formatMultiToolSection(label: string, body: string): string {
	return `===== ${label} =====\n${body}`;
}

export function formatMultiToolBody(isError: boolean | undefined, text: string): string {
	return isError ? `ERROR: ${text}` : text;
}

/** Count per-item failures from execution details; 0 when details absent (e.g. validation-only failure). */
export function countMultiToolFailed<T extends { isError: boolean }>(items: T[] | undefined): number {
	return items?.filter((item) => item.isError).length ?? 0;
}

export function buildResultText(
	sections: string[],
	toolName: string,
): {
	text: string;
	sectionLineCounts: number[];
	truncated: boolean;
	outputLines: number;
} {
	const sectionLineCounts = sections.map((section) => section.split("\n").length);
	const joined = sections.join("\n\n");
	const truncation = truncateHead(joined, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});
	if (!truncation.truncated) {
		return {
			text: truncation.content,
			sectionLineCounts,
			truncated: false,
			outputLines: truncation.outputLines,
		};
	}
	const limit = truncation.truncatedBy === "lines" ? `${truncation.maxLines} lines` : formatSize(truncation.maxBytes);
	const text = `${truncation.content}\n\n[${toolName} output truncated: showing ${truncation.outputLines}/${truncation.totalLines} lines, limit ${limit}]`;
	return {
		text,
		sectionLineCounts,
		truncated: true,
		outputLines: truncation.outputLines,
	};
}
