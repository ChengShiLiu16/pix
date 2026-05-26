const OSC133_ZONE_START = "\u001b]133;A\u0007";
const OSC133_ZONE_END = "\u001b]133;B\u0007";
const OSC133_ZONE_FINAL = "\u001b]133;C\u0007";
const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const OSC_PATTERN = /\u001b\][^\u0007]*\u0007/g;

export type UserMessageThemeLike = {
	fg(name: string, text: string): string;
	bold(text: string): string;
};

function stripTerminalControl(text: string): string {
	return text.replace(OSC_PATTERN, "").replace(ANSI_PATTERN, "");
}

function normalizeOriginalContentLines(lines: string[]): string[] {
	const normalized = lines.map((line) =>
		stripTerminalControl(line)
			.replace(/[ \t]+$/g, "")
			.replace(/^ /, ""),
	);

	while (normalized.length > 0 && !normalized[0]!.trim()) normalized.shift();
	while (normalized.length > 0 && !normalized[normalized.length - 1]!.trim()) normalized.pop();

	return normalized.length > 0 ? normalized : [""];
}

function restoreOscZone(lines: string[]): string[] {
	if (lines.length === 0) return lines;
	const restored = [...lines];
	restored[0] = `${OSC133_ZONE_START}${restored[0]}`;
	restored[restored.length - 1] = `${OSC133_ZONE_END}${OSC133_ZONE_FINAL}${restored[restored.length - 1]}`;
	return restored;
}

export function formatUserMessageCardLines(lines: string[], theme: UserMessageThemeLike): string[] {
	const content = normalizeOriginalContentLines(lines);
	const border = (text: string): string => theme.fg("borderMuted", text);
	const label = theme.bold(theme.fg("accent", "You"));
	const body = (text: string): string => theme.fg("userMessageText", text);

	return restoreOscZone([
		`${border("╭─")} ${label}`,
		...content.map((line) => `${border("│")} ${body(line)}`),
		border("╰─"),
	]);
}
