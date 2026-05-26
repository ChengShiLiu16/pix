/** Keyboard shortcuts for opening worker full-screen view (Alt+1..9 on Linux/Windows, Ctrl+1..9 on macOS). */

import type { KeyId } from "@earendil-works/pi-tui";

export const MAX_WORKER_SHORTCUTS = 9;

/** macOS terminals often swallow Option+number as typed symbols; Ctrl+number is reliable. */
export const IS_DARWIN = process.platform === "darwin";

export function workerShortcutModifierLabel(): "Ctrl" | "Alt" {
  return IS_DARWIN ? "Ctrl" : "Alt";
}

export function workerViewShortcutKey(key: string): KeyId {
  return (IS_DARWIN ? `ctrl+${key}` : `alt+${key}`) as KeyId;
}

export function formatWorkerShortcutKey(index: number): string {
  return `${workerShortcutModifierLabel()}+${index}`;
}

export function formatWorkerShortcutRange(): string {
  return `${workerShortcutModifierLabel()}+1–9`;
}

/** Latest worker: Alt+O elsewhere; on macOS Alt+O is unreliable and Ctrl+O conflicts with Pi expand. */
export function formatWorkerLatestShortcutKey(): string {
  return IS_DARWIN ? "Ctrl+1" : "Alt+O";
}

export const WORKER_VIEW_KEYMAP = IS_DARWIN
  ? [
      "Ctrl+1..9 — 按最近顺序查看 worker（Ctrl+1 = 最新）",
      "/view-worker <id> — 按 id 查看（>9 个 worker 时）",
    ].join("\n· ")
  : [
      "Alt+1..9 — 按最近顺序查看 worker（Alt+1 = 最新）",
      "Alt+O — 查看最新 worker",
      "/view-worker <id> — 按 id 查看（>9 个 worker 时）",
    ].join("\n· ");

export function formatWorkerViewShortcutHint(
  index: number,
  workerId: string,
  kind: "report" | "error" = "report",
): string {
  const suffix = kind === "error" ? " 错误详情" : "";
  return `${formatWorkerShortcutKey(index)} 查看 worker #${workerId}${suffix}`;
}

export function formatWorkerViewActionHint(
  index: number | undefined,
  workerId: string,
  kind: "report" | "error" = "report",
): string {
  if (index != null && index >= 1 && index <= MAX_WORKER_SHORTCUTS) {
    return `▸ ${formatWorkerViewShortcutHint(index, workerId, kind)}`;
  }
  const fallback = kind === "error" ? "查看错误详情" : "查看详情";
  return `▸ /view-worker ${workerId} ${fallback}`;
}

/** Most-recent-first: ids[0] is newest. Input order is oldest-first (spawn/registration). */
export function orderWorkerIdsMostRecentFirst(ids: string[]): string[] {
  return [...ids].reverse();
}

export function resolveWorkerShortcutIndex(
  idsMostRecentFirst: string[],
  workerId: string,
): number | undefined {
  const idx = idsMostRecentFirst.indexOf(workerId);
  if (idx < 0 || idx >= MAX_WORKER_SHORTCUTS) return undefined;
  return idx + 1;
}

export function selectWorkerIdByShortcutIndex(
  idsMostRecentFirst: string[],
  index: number,
): string | undefined {
  if (index < 1 || index > MAX_WORKER_SHORTCUTS) return undefined;
  return idsMostRecentFirst[index - 1];
}
