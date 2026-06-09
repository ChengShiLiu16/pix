/**
 * Shared tree-style tool call header: name + detail lines with tree connectors.
 * Each item is always a single line (truncated with … if too long).
 */

import { homedir } from "node:os";
import { isAbsolute, relative, resolve as resolvePath } from "node:path";
import { type Component, Container, truncateToWidth, visibleWidth } from "@chengshiliu16/pix-tui";

export type ThemeLike = {
	fg(name: string, text: string): string;
	bold(text: string): string;
};

const TOOL_PATH_COLOR = "\u001b[38;2;102;102;102m";
const ANSI_RESET = "\u001b[0m";
const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const OSC_PATTERN = /\u001b\][^\u0007]*\u0007/g;

let sessionCwd = "";

/** Session cwd for relative display paths. */
export function setDisplayCwd(cwd: string): void {
	sessionCwd = cwd;
}

export function formatToolPath(path: string): string {
	return path ? `${TOOL_PATH_COLOR}${path}${ANSI_RESET}` : path;
}

/** Truncate a string (which may contain ANSI codes) to a maximum visible width, appending … if needed. */
function truncateVisible(text: string, maxWidth: number): string {
	if (maxWidth <= 0) return text;
	if (visibleWidth(text) <= maxWidth) return text;
	return `${truncateToWidth(text, maxWidth - 1, "")}${TOOL_PATH_COLOR}…${ANSI_RESET}`;
}

function formatToolDetail(item: string): string {
	const plain = item.replace(OSC_PATTERN, "").replace(ANSI_PATTERN, "");
	return plain ? formatToolPath(plain) : plain;
}

/** Single-line component that truncates at render time instead of wrapping. */
class SingleLineText implements Component {
	private text: string;
	constructor(text: string) {
		this.text = text;
	}
	render(width: number): string[] {
		if (!this.text || this.text.trim() === "") return [""];
		const truncated = truncateVisible(this.text, width);
		const visible = visibleWidth(truncated);
		const padding = Math.max(0, width - visible);
		return [truncated + " ".repeat(padding)];
	}
	invalidate(): void {}
	handleInput?(_data: string): void {}
}

export function formatTreeCall(theme: ThemeLike, header: string, items: string[]): Container {
	const container = new Container();
	container.addChild(new SingleLineText(theme.fg("toolTitle", theme.bold(header))));
	for (let index = 0; index < items.length; index++) {
		const connector = index === items.length - 1 ? "└─" : "├─";
		const prefix = theme.fg("dim", ` ${connector} `);
		const detail = formatToolDetail(items[index] ?? "");
		container.addChild(new SingleLineText(`${prefix}${detail}`));
	}
	return container;
}

export function shortenPath(p: string): string {
	if (!p) return "";
	const home = process.env.HOME || homedir();
	if (home && p.startsWith(home)) return `~${p.slice(home.length)}`;
	return p;
}

function pathForDisplay(p: string): string {
	if (!p) return p;
	const expanded = p === "~" ? homedir() : p.startsWith("~/") ? resolvePath(homedir(), p.slice(2)) : p;
	const abs = isAbsolute(expanded) ? resolvePath(expanded) : sessionCwd ? resolvePath(sessionCwd, expanded) : expanded;
	if (sessionCwd) {
		const rel = relative(sessionCwd, abs);
		if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
			return rel;
		}
	}
	return shortenPath(abs);
}

/** Absolute path for read/bash batch lines — home shorthand only, never cwd-relative.
 *  No length truncation here; SingleLineText.render() handles truncation at display time. */
export function displayFullPath(p: string): string {
	if (!p) return p;
	const expanded = p === "~" ? homedir() : p.startsWith("~/") ? resolvePath(homedir(), p.slice(2)) : p;
	const abs = isAbsolute(expanded) ? resolvePath(expanded) : sessionCwd ? resolvePath(sessionCwd, expanded) : expanded;
	return shortenPath(abs);
}

/** Display path relative to cwd, with ~ shorthand.
 *  No length truncation here; SingleLineText.render() handles truncation at display time. */
export function displayPath(p: string): string {
	if (!p) return p;
	return pathForDisplay(p);
}
