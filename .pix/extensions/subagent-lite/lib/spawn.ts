import type { AgentConfig } from "./agents.ts";

export const DEFAULT_TOOLS = "read,grep,find,ls,bash,edit,write";
export const CHAT_OUTPUT_MAX = 3000;
export const WIDGET_SUMMARY_MAX = 80;
/** Workers finishing faster with no tool calls likely never ran the agent loop. */
export const FAST_FAIL_MS = 2000;
/** Minimum assistant output length when no tools were used. */
export const MIN_MEANINGFUL_OUTPUT = 80;

export interface WorkerRunMetrics {
  durationMs: number;
  toolCalls: number;
}

export interface WorkerAssessment {
  ok: boolean;
  reason?: string;
}

export interface SpawnOptions {
  systemPromptFile?: string;
  /** Parent session model (preferred over agent frontmatter model). */
  sessionModel?: string;
}

/** Format ctx.model for `--model provider/id`. */
export function formatSessionModel(model: { provider?: string; id?: string } | undefined): string | undefined {
  if (!model?.id) return undefined;
  return model.provider ? `${model.provider}/${model.id}` : model.id;
}

export function buildSpawnArgs(
  agent: AgentConfig | undefined,
  prompt: string,
  options: SpawnOptions = {},
): string[] {
  const args = [
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--no-extensions",
    "--tools",
    agent?.tools?.join(",") ?? DEFAULT_TOOLS,
  ];
  const model = options.sessionModel ?? agent?.model;
  if (model) args.push("--model", model);
  if (options.systemPromptFile) args.push("--append-system-prompt", options.systemPromptFile);
  args.push(`Task: ${prompt}`);
  return args;
}

export function summarizeOutput(text: string, maxLen = 200): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (!oneLine) return "(no output)";
  return oneLine.length <= maxLen ? oneLine : `${oneLine.slice(0, maxLen - 1)}…`;
}

export function truncateForChat(text: string, maxLen = CHAT_OUTPUT_MAX): string {
  const trimmed = text.trim();
  if (!trimmed) return "(no output)";
  if (trimmed.length <= maxLen) return trimmed;
  return `${trimmed.slice(0, maxLen)}\n\n…[truncated ${trimmed.length - maxLen} chars; expand task result for full output]`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function isLikelyErrorOutput(text: string): boolean {
  return /no api key found|authentication failed|invalid api key|unauthorized|rate limit|context_length_exceeded|spawn failed/i.test(
    text,
  );
}

/** Reject fast no-op exits even when exit code is 0. */
export function assessWorkerSuccess(exitCode: number, output: string, metrics: WorkerRunMetrics): WorkerAssessment {
  const body = output.trim();
  if (exitCode !== 0) return { ok: false, reason: `exit code ${exitCode}` };
  if (isLikelyErrorOutput(body)) return { ok: false, reason: "worker output indicates an error" };
  if (metrics.durationMs < FAST_FAIL_MS && metrics.toolCalls === 0) {
    return { ok: false, reason: `no tool activity in ${formatDuration(metrics.durationMs)} — worker likely did not run` };
  }
  if (body.length < MIN_MEANINGFUL_OUTPUT && metrics.toolCalls === 0) {
    return { ok: false, reason: "output too short with no tool calls" };
  }
  return { ok: true };
}

export function formatWorkerFailure(exitCode: number, stderr: string, output: string): string {
  const detail = (stderr || output || "(no output)").trim();
  let msg = `exit code ${exitCode}`;
  if (detail) msg += `\n\n${detail}`;
  if (/no api key found/i.test(detail)) {
    msg +=
      "\n\nHint: worker inherited a model without credentials. Session model is preferred; check agent frontmatter `model:` or run `/login`.";
  }
  return msg;
}
