import { wrapOscPromptZone } from "./osc-prompt-zone.ts";

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const OSC_PATTERN = /\x1b\][^\x07]*\x07/g;

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

export function formatUserMessageCardLines(lines: string[], theme: UserMessageThemeLike): string[] {
	const content = normalizeOriginalContentLines(lines);
	const border = (text: string): string => theme.fg("borderMuted", text);
	const label = theme.bold(theme.fg("accent", "You"));
	const body = (text: string): string => theme.fg("userMessageText", text);

	return wrapOscPromptZone([
		`${border("╭─")} ${label}`,
		...content.map((line) => `${border("│")} ${body(line)}`),
		border("╰─"),
	]);
}
