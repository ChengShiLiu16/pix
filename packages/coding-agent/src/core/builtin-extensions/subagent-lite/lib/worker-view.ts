import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TUI } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "../../../../index.ts";
import type { TaskDetails } from "./task-render.ts";
import {
	buildWorkerViewMarkdown,
	formatWorkerViewStatusLine,
	formatWorkerViewTitle,
	type WorkerViewDetails,
} from "./worker-view-content.ts";

export type { WorkerViewDetails } from "./worker-view-content.ts";
export { buildWorkerViewMarkdown } from "./worker-view-content.ts";

let viewOpen = false;

export function isWorkerViewOpen(): boolean {
	return viewOpen;
}

/** No-op while pager owns the terminal (less exits with q). Kept for shortcut compatibility. */
export function closeWorkerView(): boolean {
	return false;
}

/** Unused with pager mode; kept so index.ts imports stay stable. */
export function feedWorkerViewInput(_data: string): boolean {
	return false;
}

/** Plain-text document for full-terminal pager (less/more). */
export function buildWorkerViewPagerContent(details: WorkerViewDetails): string {
	const title = formatWorkerViewTitle(details);
	const status = formatWorkerViewStatusLine(details);
	const body = buildWorkerViewMarkdown(details);
	return [`Worker View`, `${title}`, status, "─".repeat(Math.min(72, Math.max(20, title.length + 8))), "", body].join(
		"\n",
	);
}

function resolvePager(): { command: string; args: (file: string) => string[] } {
	const which = spawnSync("sh", ["-c", "command -v less"], { encoding: "utf-8" });
	if (which.status === 0 && which.stdout.trim()) {
		return {
			command: which.stdout.trim(),
			args: (file) => ["-R", file],
		};
	}
	return {
		command: "more",
		args: (file) => [file],
	};
}

function runFullScreenPager(tui: TUI, content: string): void {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-worker-view-"));
	const file = path.join(dir, "worker-output.md");
	fs.writeFileSync(file, content, { encoding: "utf-8", mode: 0o600 });
	try {
		tui.stop();
		process.stdout.write("\x1b[2J\x1b[H");
		const pager = resolvePager();
		spawnSync(pager.command, pager.args(file), {
			stdio: "inherit",
			env: { ...process.env, LESS: process.env.LESS ?? "-R" },
		});
	} finally {
		try {
			fs.unlinkSync(file);
			fs.rmdirSync(dir);
		} catch {
			/* ignore cleanup errors */
		}
		tui.start();
		tui.requestRender(true);
	}
}

export async function showWorkerView(ctx: ExtensionContext, details: WorkerViewDetails): Promise<boolean> {
	if (!ctx.hasUI) return false;
	if (viewOpen) {
		ctx.ui.notify("Worker view already open", "warning");
		return false;
	}
	viewOpen = true;
	try {
		const content = buildWorkerViewPagerContent(details);
		// Same pattern as pi-mono interactive-shell.ts: stop TUI, run full-terminal
		// program, restart with a forced full redraw. Overlays composite on chat and
		// cannot hide scrollback — only a real pager gives true full-screen.
		await ctx.ui.custom<void>((tui, _theme, _kb, done) => {
			runFullScreenPager(tui, content);
			done(undefined);
			return { render: () => [], invalidate: () => {} };
		});
		return true;
	} finally {
		viewOpen = false;
	}
}

export async function openWorkerViewById(
	ctx: ExtensionContext,
	workerId: string | undefined,
	getDetails: (id: string) => TaskDetails | undefined,
	listIds: () => string[],
): Promise<boolean> {
	const resolvedId =
		workerId?.trim() ||
		(() => {
			const ids = listIds();
			return ids.length ? ids[ids.length - 1] : undefined;
		})();

	if (!resolvedId) {
		if (ctx.hasUI) ctx.ui.notify("No worker task results yet", "warning");
		return false;
	}

	let details: WorkerViewDetails | undefined = getDetails(resolvedId);
	if (!details && workerId) {
		for (const id of listIds()) {
			if (id.startsWith(resolvedId)) {
				details = getDetails(id);
				break;
			}
		}
	}
	if (!details) {
		if (ctx.hasUI) ctx.ui.notify(`Unknown worker #${resolvedId}`, "warning");
		return false;
	}
	await showWorkerView(ctx, details);
	return true;
}

export function clearWorkerViewState(): void {
	viewOpen = false;
}
