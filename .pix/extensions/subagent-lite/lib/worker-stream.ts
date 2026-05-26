import type { Message } from "@earendil-works/pi-ai";
import { summarizeOutput } from "./spawn.ts";

export interface SubResult {
  toolName: string;
  /** Short one-line preview for collapsed chat / widget. */
  summary: string;
  /** Full tool result text for worker view. */
  content: string;
  argsSummary?: string;
  toolCallId?: string;
  isError?: boolean;
}

export interface WorkerStreamSnapshot {
  messages: Message[];
  toolCalls: number;
  subResults: SubResult[];
}

const SUB_RESULT_PREVIEW_MAX = 240;

type JsonEvent = {
  type?: string;
  message?: Message;
  messages?: Message[];
  toolName?: string;
  toolCallId?: string;
  args?: unknown;
  result?: unknown;
  partialResult?: unknown;
  isError?: boolean;
};

interface PendingTool {
  toolName: string;
  argsSummary: string;
}

function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const p = part as { type?: string; text?: string };
    if (p.type === "text" && p.text?.trim()) parts.push(p.text.trim());
  }
  return parts.join("\n");
}

export function summarizeArgs(args: unknown): string {
  if (args == null) return "";
  if (typeof args === "string") return args.trim();
  try {
    const json = JSON.stringify(args);
    return json.length <= 320 ? json : `${json.slice(0, 319)}…`;
  } catch {
    return String(args);
  }
}

export function extractToolResultText(result: unknown): string {
  if (result == null) return "";
  if (typeof result === "string") return result.trim();
  if (Array.isArray(result)) {
    const parts = result.map((item) => extractToolResultText(item)).filter(Boolean);
    return parts.join("\n\n");
  }
  if (typeof result !== "object") return String(result);

  const obj = result as {
    content?: unknown;
    text?: string;
    output?: string;
    stdout?: string;
    stderr?: string;
    files?: unknown;
    results?: unknown;
  };

  const fromContent = textFromContent(obj.content);
  if (fromContent) return fromContent;
  if (obj.text?.trim()) return obj.text.trim();
  if (obj.output?.trim()) return obj.output.trim();
  if (obj.stdout?.trim()) return obj.stdout.trim();
  if (obj.stderr?.trim()) return obj.stderr.trim();

  if (Array.isArray(obj.files)) {
    const parts = obj.files.map((f) => extractToolResultText(f)).filter(Boolean);
    if (parts.length) return parts.join("\n\n");
  }
  if (Array.isArray(obj.results)) {
    const parts = obj.results.map((r) => extractToolResultText(r)).filter(Boolean);
    if (parts.length) return parts.join("\n\n");
  }

  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

export function buildSubResult(
  toolName: string,
  result: unknown,
  options: { argsSummary?: string; toolCallId?: string; isError?: boolean } = {},
): SubResult {
  const content = extractToolResultText(result);
  const summary = content ? summarizeOutput(content, SUB_RESULT_PREVIEW_MAX) : "(empty result)";
  return {
    toolName,
    summary,
    content: content || "(empty result)",
    argsSummary: options.argsSummary || undefined,
    toolCallId: options.toolCallId,
    isError: options.isError || undefined,
  };
}

/** @deprecated use buildSubResult */
export function summarizeSubResult(toolName: string, result: unknown, isError = false): SubResult {
  return buildSubResult(toolName, result, { isError });
}

function isToolResultMessage(message: Message): boolean {
  return message.role === "toolResult" || message.role === "tool";
}

function subResultFromMessage(message: Message): SubResult | undefined {
  const toolName = (message as { toolName?: string }).toolName ?? "tool";
  const toolCallId = (message as { toolCallId?: string }).toolCallId;
  const isError = Boolean((message as { isError?: boolean }).isError);
  const content = extractToolResultText(message.content);
  if (!content && !isError) return undefined;
  return buildSubResult(toolName, message.content ?? content, { toolCallId, isError });
}

export function createWorkerStreamParser() {
  const messages: Message[] = [];
  let toolCalls = 0;
  const subResults: SubResult[] = [];
  const pending = new Map<string, PendingTool>();
  const partialByCall = new Map<string, string>();
  const seenCallIds = new Set<string>();
  const countedCallIds = new Set<string>();
  const seenResultKeys = new Set<string>();

  const countToolCall = (toolCallId?: string) => {
    if (toolCallId) {
      if (countedCallIds.has(toolCallId)) return;
      countedCallIds.add(toolCallId);
    }
    toolCalls++;
  };

  const pushSubResult = (sr: SubResult) => {
    if (sr.toolCallId) {
      if (seenCallIds.has(sr.toolCallId)) return;
      seenCallIds.add(sr.toolCallId);
    } else {
      const key = [sr.toolName, sr.argsSummary ?? "", sr.summary, sr.content, sr.isError ? "1" : "0"].join("\0");
      if (seenResultKeys.has(key)) return;
      seenResultKeys.add(key);
    }
    subResults.push(sr);
  };

  const finalizeTool = (
    toolCallId: string | undefined,
    toolName: string,
    result: unknown,
    isError = false,
  ) => {
    const pendingMeta = toolCallId ? pending.get(toolCallId) : undefined;
    const argsSummary = pendingMeta?.argsSummary;
    const name = pendingMeta?.toolName ?? toolName;
    if (toolCallId) pending.delete(toolCallId);

    let content = extractToolResultText(result);
    if (!content && toolCallId) content = partialByCall.get(toolCallId) ?? "";
    if (toolCallId) partialByCall.delete(toolCallId);

    pushSubResult(buildSubResult(name, content || result, { argsSummary, toolCallId, isError }));
  };

  const ingestMessage = (message: Message) => {
    messages.push(message);
    if (!isToolResultMessage(message)) return;
    const sr = subResultFromMessage(message);
    if (sr) pushSubResult(sr);
  };

  const onLine = (line: string) => {
    if (!line.trim()) return;
    try {
      const ev = JSON.parse(line) as JsonEvent;

      if (ev.type === "tool_execution_start") {
        countToolCall(ev.toolCallId);
        if (ev.toolCallId && ev.toolName) {
          pending.set(ev.toolCallId, {
            toolName: ev.toolName,
            argsSummary: summarizeArgs(ev.args),
          });
        }
      }

      if (ev.type === "tool_execution_update" && ev.toolCallId) {
        const partial = extractToolResultText(ev.partialResult);
        if (partial) partialByCall.set(ev.toolCallId, partial);
      }

      if (ev.type === "tool_execution_end" && ev.toolName) {
        countToolCall(ev.toolCallId);
        finalizeTool(ev.toolCallId, ev.toolName, ev.result, Boolean(ev.isError));
      }

      if (ev.type === "message_end" && ev.message) {
        ingestMessage(ev.message);
      }

      if (ev.type === "message" && ev.message) {
        ingestMessage(ev.message);
      }

      if (ev.type === "agent_end" && Array.isArray(ev.messages)) {
        messages.push(...ev.messages);
        for (const message of ev.messages) {
          if (!isToolResultMessage(message)) continue;
          const sr = subResultFromMessage(message);
          if (sr) pushSubResult(sr);
        }
      }
    } catch {
      /* ignore malformed JSON lines */
    }
  };

  const snapshot = (): WorkerStreamSnapshot => ({ messages, toolCalls: Math.max(toolCalls, subResults.length), subResults });

  return { onLine, snapshot };
}

export function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    for (const part of msg.content) if (part.type === "text" && part.text.trim()) return part.text;
  }
  return "";
}
