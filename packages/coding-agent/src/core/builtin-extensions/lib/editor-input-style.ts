const ANSI_SGR_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const TERMINAL_CONTROL_PATTERN =
	/\u001b[\]PX^_][\s\S]*?(?:\u0007|\u001b\\|\u009c)|\u009b[0-?]*[ -/]*[@-~]|\u001b\[[0-?]*[ -/]*[@-~]/g;

export type EditorInputThemeLike = {
	fg(name: string, text: string): string;
};

function stripTerminalControl(text: string): string {
	return text.replace(TERMINAL_CONTROL_PATTERN, "");
}

function isEditorBorderLine(line: string): boolean {
	const plain = stripTerminalControl(line).trimEnd();
	return /^─+$/.test(plain) || /^─── [↑↓] \d+ more ─*$/.test(plain);
}

function colorPlainSegments(line: string, theme: EditorInputThemeLike): string {
	let result = "";
	let lastIndex = 0;
	for (const match of line.matchAll(ANSI_SGR_PATTERN)) {
		const index = match.index ?? 0;
		if (index > lastIndex) {
			result += theme.fg("userMessageText", line.slice(lastIndex, index));
		}
		result += match[0];
		lastIndex = index + match[0].length;
	}
	if (lastIndex < line.length) {
		result += theme.fg("userMessageText", line.slice(lastIndex));
	}
	return result;
}

export function formatEditorInputRenderLines(lines: string[], theme: EditorInputThemeLike): string[] {
	if (lines.length <= 2) return lines;

	const output = [...lines];
	let contentEndIndex = output.length;
	for (let index = 1; index < output.length; index += 1) {
		if (isEditorBorderLine(output[index]!)) {
			contentEndIndex = index;
		}
	}

	for (let index = 1; index < contentEndIndex; index += 1) {
		output[index] = colorPlainSegments(output[index]!, theme);
	}
	return output;
}
