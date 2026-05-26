/**
 * Shared tree-style tool call header: emoji + name + todo-style detail lines.
 */

import { homedir } from "node:os";
import { isAbsolute, relative, resolve as resolvePath } from "node:path";
import { Text } from "@earendil-works/pi-tui";

export type ThemeLike = {
	fg(name: string, text: string): string;
	bold(text: string): string;
};

const TOOL_PATH_COLOR = "\u001b[38;2;102;102;102m";
const ANSI_RESET = "\u001b[0m";
const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const OSC_PATTERN = /\u001b\][^\u0007]*\u0007/g;

let sessionCwd = "";

/** Session cwd for relative display paths (P3). */
export function setDisplayCwd(cwd: string): void {
	sessionCwd = cwd;
}

export function formatToolPath(path: string): string {
	return path ? `${TOOL_PATH_COLOR}${path}${ANSI_RESET}` : path;
}

function formatToolDetail(item: string): string {
	const plain = item.replace(OSC_PATTERN, "").replace(ANSI_PATTERN, "");
	return plain ? formatToolPath(plain) : plain;
}

export function formatTreeCall(theme: ThemeLike, header: string, items: string[]): Text {
	let line = theme.fg("toolTitle", theme.bold(header));
	for (let index = 0; index < items.length; index++) {
		const connector = index === items.length - 1 ? "└─" : "├─";
		line += "\n" + theme.fg("dim", ` ${connector} `) + formatToolDetail(items[index] ?? "");
	}
	return new Text(line, 0, 0);
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

/** Absolute path for read/bash batch lines — home shorthand only, never cwd-relative. */
export function displayFullPath(p: string, maxLen = 120): string {
	if (!p) return p;
	const expanded = p === "~" ? homedir() : p.startsWith("~/") ? resolvePath(homedir(), p.slice(2)) : p;
	const abs = isAbsolute(expanded) ? resolvePath(expanded) : sessionCwd ? resolvePath(sessionCwd, expanded) : expanded;
	const shortened = shortenPath(abs);
	if (shortened.length <= maxLen) return shortened;
	const parts = shortened.split("/");
	if (parts.length <= 3) return shortened.slice(0, maxLen - 1) + "…";
	return "..." + "/" + parts.slice(-3).join("/");
}

export function displayPath(p: string, maxLen = 120): string {
	if (!p) return p;
	const shortened = pathForDisplay(p);
	if (shortened.length <= maxLen) return shortened;
	const parts = shortened.split("/");
	if (parts.length <= 3) return shortened.slice(0, maxLen - 1) + "…";
	return "..." + "/" + parts.slice(-3).join("/");
}
