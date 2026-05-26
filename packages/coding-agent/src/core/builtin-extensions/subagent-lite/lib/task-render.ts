import { formatDuration, summarizeOutput } from "./spawn.ts";
import { formatWorkerShortcutRange, formatWorkerViewActionHint } from "./worker-shortcuts.ts";
import type { SubResult } from "./worker-stream.ts";

export type WorkerStatus = "running" | "done" | "failed";

export interface TaskDetails {
	workerId: string;
	status: WorkerStatus;
	output?: string;
	stderr?: string;
	exitCode?: number;
	summary?: string;
	description?: string;
	durationMs?: number;
	toolCalls?: number;
	subResults?: SubResult[];
}

export interface ParallelTaskDetails {
	parallel: true;
	results: TaskDetails[];
}

export function isParallelTaskDetails(
	details: TaskDetails | ParallelTaskDetails | undefined,
): details is ParallelTaskDetails {
	return Boolean(details && "parallel" in details && details.parallel && Array.isArray(details.results));
}

type ThemeLike = {
	fg(name: string, text: string): string;
	bold(text: string): string;
};

const PREVIEW_MAX = 120;

/** Prefer live worker state, then persisted completion, then stored tool result details. */
export function resolveTaskDetails(
	stored: TaskDetails | undefined,
	live?: TaskDetails,
	completed?: TaskDetails,
): TaskDetails | undefined {
	if (!stored?.workerId) return stored;
	const workerId = stored.workerId;
	const fromLive = live?.workerId === workerId ? live : undefined;
	const fromCompleted = completed?.workerId === workerId ? completed : undefined;
	if (fromLive && fromLive.status !== "running") return { ...stored, ...fromLive };
	if (fromLive?.status === "running") return { ...stored, ...fromLive };
	if (fromCompleted) return { ...stored, ...fromCompleted };
	return stored;
}

export function formatSubResultsSection(subResults: SubResult[] | undefined, theme: ThemeLike): string {
	if (!subResults?.length) return "";
	const lines = [theme.fg("muted", "Sub-results:")];
	subResults.forEach((sr, i) => {
		const icon = sr.isError ? theme.fg("error", "✗") : theme.fg("success", "·");
		const preview = sr.summary || sr.content?.slice(0, 120) || "";
		const args = sr.argsSummary ? theme.fg("dim", ` (${sr.argsSummary.slice(0, 80)})`) : "";
		lines.push(theme.fg("dim", `  ${i + 1}. ${icon} ${sr.toolName}`) + args + theme.fg("muted", ` — ${preview}`));
		const full = (sr.content ?? "").trim();
		if (full && full !== preview && (full.includes("\n") || full.length > preview.length + 20)) {
			lines.push(theme.fg("dim", full));
		}
	});
	return lines.join("\n");
}

export function formatSubResultsPreview(subResults: SubResult[] | undefined): string {
	if (!subResults?.length) return "";
	const counts = new Map<string, number>();
	for (const sr of subResults) counts.set(sr.toolName, (counts.get(sr.toolName) ?? 0) + 1);
	return [...counts.entries()].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(", ");
}

export function formatWorkerViewHint(
	workerId: string,
	theme: ThemeLike,
	getShortcutIndex?: (workerId: string) => number | undefined,
): string {
	const shortcutIndex = getShortcutIndex?.(workerId);
	return theme.fg("muted", formatWorkerViewActionHint(shortcutIndex, workerId));
}

export function formatParallelViewFooter(theme: ThemeLike): string {
	return theme.fg("muted", `▸ ${formatWorkerShortcutRange()} 或 /view-worker <id> 查看 worker`);
}

export function formatWorkerResultHeader(details: TaskDetails, theme: ThemeLike): string {
	const running = details.status === "running";
	const ok = details.status === "done";
	const failed = details.status === "failed";

	const icon = running ? theme.fg("accent", "●") : ok ? theme.fg("success", "✓") : theme.fg("error", "✗");

	let header = `${theme.fg("toolTitle", "⚡")} ${icon} Worker #${details.workerId}`;
	if (details.description) header += theme.fg("muted", ` · ${details.description.slice(0, 48)}`);

	if (running) {
		header += theme.fg("accent", " · running…");
		return header;
	}

	if (failed && details.exitCode != null) header += theme.fg("error", ` · exit ${details.exitCode}`);
	if (details.durationMs != null) header += theme.fg("muted", ` · ${formatDuration(details.durationMs)}`);
	if (details.toolCalls != null) header += theme.fg("muted", ` · ${details.toolCalls} tools`);
	return header;
}

export function formatWorkerResultCollapsed(
	details: TaskDetails,
	body: string,
	theme: ThemeLike,
	getShortcutIndex?: (workerId: string) => number | undefined,
): string {
	const header = formatWorkerResultHeader(details, theme);
	if (details.status === "running") return header;

	const output = (details.output ?? body).trim();
	const preview = details.summary ?? summarizeOutput(output, PREVIEW_MAX);
	const subPreview = formatSubResultsPreview(details.subResults);
	const hasExpandable = output.length > 0 && preview !== "(no output)";
	const lines = [header];
	if (subPreview) lines.push(theme.fg("dim", `Tools: ${subPreview}`));
	if (preview && preview !== "(no output)") lines.push(theme.fg("dim", preview));
	if (hasExpandable || subPreview) {
		lines.push(formatWorkerViewHint(details.workerId, theme, getShortcutIndex));
	}
	return lines.join("\n");
}

export function formatWorkerExpandHint(
	workerId: string,
	expanded: boolean,
	theme: ThemeLike,
	getShortcutIndex?: (workerId: string) => number | undefined,
): string {
	if (expanded) return theme.fg("muted", "▾ expanded · Esc/Ctrl+↑ 返回");
	return formatWorkerViewHint(workerId, theme, getShortcutIndex);
}

export function formatWorkerResultExpanded(
	details: TaskDetails,
	body: string,
	theme: ThemeLike,
	isError: boolean,
	getShortcutIndex?: (workerId: string) => number | undefined,
): string {
	const header = formatWorkerResultHeader(details, theme);
	const output = (details.output ?? body).trim();
	const subSection = formatSubResultsSection(details.subResults, theme);
	let full = header;

	if (details.status === "running") {
		full += `\n${theme.fg("muted", "Worker still running — check widget for progress.")}`;
		return isError ? theme.fg("error", full) : full;
	}

	if (details.status === "failed" && details.stderr && details.stderr !== output) {
		full += `\n${theme.fg("error", details.stderr)}`;
	}
	if (subSection) full += `\n\n${subSection}`;
	if (output) full += `\n\n${output}`;
	else if (!subSection) full += `\n${theme.fg("muted", "(no output)")}`;
	full += `\n${formatWorkerExpandHint(details.workerId, true, theme, getShortcutIndex)}`;
	return isError ? theme.fg("error", full) : full;
}

export function formatParallelTaskResultCollapsed(
	details: ParallelTaskDetails,
	body: string,
	theme: ThemeLike,
	getShortcutIndex?: (workerId: string) => number | undefined,
): string {
	const n = details.results.length;
	const done = details.results.filter((r) => r.status === "done").length;
	const failed = details.results.filter((r) => r.status === "failed").length;
	const header = `${theme.fg("toolTitle", "⚡")} ${theme.fg("accent", `${n} parallel tasks`)}${theme.fg("muted", ` · ${done} done${failed ? ` · ${failed} failed` : ""}`)}`;
	const lines = [header];
	details.results.forEach((r, i) => {
		const icon =
			r.status === "done"
				? theme.fg("success", "✓")
				: r.status === "failed"
					? theme.fg("error", "✗")
					: theme.fg("accent", "●");
		const label = r.description ?? r.workerId;
		const preview = r.summary ?? summarizeOutput(r.output ?? "", PREVIEW_MAX);
		lines.push(theme.fg("dim", `${i + 1}. ${icon} #${r.workerId} · ${label.slice(0, 40)}`));
		const subPreview = formatSubResultsPreview(r.subResults);
		if (subPreview) lines.push(theme.fg("dim", `   Tools: ${subPreview}`));
		if (preview && preview !== "(no output)") lines.push(theme.fg("dim", `   ${preview}`));
		if (r.status !== "running" && ((r.output ?? "").trim() || r.subResults?.length)) {
			const shortcutIndex = getShortcutIndex?.(r.workerId);
			const hint =
				shortcutIndex != null
					? formatWorkerViewActionHint(shortcutIndex, r.workerId)
					: `▸ /view-worker ${r.workerId}`;
			lines.push(theme.fg("muted", `   ${hint}`));
		}
	});
	lines.push(formatParallelViewFooter(theme));
	if (body.trim()) lines.push(theme.fg("dim", summarizeOutput(body, PREVIEW_MAX)));
	return lines.join("\n");
}

export function formatParallelTaskResultExpanded(
	details: ParallelTaskDetails,
	body: string,
	theme: ThemeLike,
	isError: boolean,
): string {
	const n = details.results.length;
	let full = `${theme.fg("toolTitle", "⚡")} ${theme.bold(`${n} parallel tasks`)}`;
	details.results.forEach((r, i) => {
		full += `\n\n${theme.bold(`${i + 1}.`)} ${formatWorkerResultHeader(r, theme)}`;
		const subSection = formatSubResultsSection(r.subResults, theme);
		if (subSection) full += `\n${subSection}`;
		const output = (r.output ?? "").trim();
		if (output) full += `\n\n${output}`;
		else if (!subSection) full += `\n${theme.fg("muted", "(no output)")}`;
	});
	if (!details.results.length && body.trim()) full += `\n\n${body.trim()}`;
	full += `\n${theme.fg("muted", "▾ expanded")}`;
	return isError ? theme.fg("error", full) : full;
}
