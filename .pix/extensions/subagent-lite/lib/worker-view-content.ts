import {
  isParallelTaskDetails,
  type ParallelTaskDetails,
  type TaskDetails,
} from "./task-render.ts";
import type { SubResult } from "./worker-stream.ts";

export type WorkerViewDetails = TaskDetails | ParallelTaskDetails;

export function buildWorkerViewMarkdown(details: WorkerViewDetails): string {
  if (isParallelTaskDetails(details)) return buildParallelWorkerViewMarkdown(details);
  return buildSingleWorkerViewMarkdown(details);
}

function buildSingleWorkerViewMarkdown(details: TaskDetails): string {
  const sections: string[] = [];
  if (details.description) sections.push(`**${details.description}**`);
  if (details.status === "running") {
    sections.push("_Worker still running — check widget for live progress._");
    return sections.join("\n\n");
  }
  if (details.status === "failed" && details.stderr?.trim()) {
    const output = (details.output ?? "").trim();
    if (details.stderr.trim() !== output) sections.push(`\`\`\`\n${details.stderr.trim()}\n\`\`\``);
  }
  const subSection = formatSubResultsSectionPlain(details.subResults);
  if (subSection) sections.push(subSection);
  const output = (details.output ?? "").trim();
  if (output) sections.push(output);
  else if (!subSection) sections.push("_(no output)_");
  return sections.join("\n\n");
}

function buildParallelWorkerViewMarkdown(details: ParallelTaskDetails): string {
  const sections: string[] = [`**${details.results.length} parallel workers**`];
  details.results.forEach((worker, i) => {
    sections.push(formatParallelWorkerSection(i + 1, worker));
  });
  return sections.join("\n\n---\n\n");
}

function formatParallelWorkerSection(index: number, details: TaskDetails): string {
  const header = `### ${index}. Worker #${details.workerId}`;
  const meta: string[] = [];
  if (details.description) meta.push(details.description);
  if (details.status === "running") meta.push("running…");
  else {
    if (details.durationMs != null) meta.push(`${(details.durationMs / 1000).toFixed(1)}s`);
    if (details.toolCalls != null) meta.push(`${details.toolCalls} tools`);
    if (details.status === "failed" && details.exitCode != null) meta.push(`exit ${details.exitCode}`);
  }
  const lines = [header];
  if (meta.length) lines.push(`_${meta.join(" · ")}_`);
  if (details.status === "running") {
    lines.push("_Worker still running — check widget for live progress._");
    return lines.join("\n");
  }
  const subSection = formatSubResultsSectionPlain(details.subResults);
  if (subSection) lines.push(subSection);
  const output = (details.output ?? "").trim();
  if (output) lines.push(output);
  else if (!subSection) lines.push("_(no output)_");
  return lines.join("\n\n");
}

function formatSubResultBlock(sr: SubResult, index: number): string {
  const icon = sr.isError ? "✗" : "·";
  const lines = [`${index}. ${icon} **\`${sr.toolName}\`**`];
  if (sr.argsSummary?.trim()) lines.push(`   _args:_ \`${sr.argsSummary.trim()}\``);
  const body = (sr.content ?? sr.summary).trim();
  if (body.includes("\n") || body.length > 120) {
    lines.push(`\n\`\`\`\n${body}\n\`\`\``);
  } else if (body) {
    lines.push(`   ${body}`);
  }
  return lines.join("\n");
}

function formatSubResultsSectionPlain(subResults: SubResult[] | undefined): string {
  if (!subResults?.length) return "";
  const lines = ["**Sub-results:**"];
  subResults.forEach((sr, i) => lines.push(formatSubResultBlock(sr, i + 1)));
  return lines.join("\n");
}

/** Plain header line for worker view chrome (no theme). */
export function formatWorkerViewTitle(details: WorkerViewDetails): string {
  if (isParallelTaskDetails(details)) {
    const done = details.results.filter((r) => r.status === "done").length;
    const failed = details.results.filter((r) => r.status === "failed").length;
    return `${details.results.length} parallel workers · ${done} done${failed ? ` · ${failed} failed` : ""}`;
  }
  const title = `#${details.workerId}`;
  const desc = details.description?.trim();
  return desc ? `Worker ${title} · ${desc}` : `Worker ${title}`;
}

export function formatWorkerViewStatusLine(details: WorkerViewDetails): string {
  if (isParallelTaskDetails(details)) {
    const running = details.results.filter((r) => r.status === "running").length;
    return running ? "running…" : "complete";
  }
  if (details.status === "running") return "running…";
  const parts: string[] = [];
  if (details.durationMs != null) parts.push(`${(details.durationMs / 1000).toFixed(1)}s`);
  if (details.toolCalls != null) parts.push(`${details.toolCalls} tools`);
  if (details.status === "failed" && details.exitCode != null) parts.push(`exit ${details.exitCode}`);
  return parts.join(" · ");
}
