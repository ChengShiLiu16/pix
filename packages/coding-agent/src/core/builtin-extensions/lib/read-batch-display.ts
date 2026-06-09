/**
 * Consecutive read aggregation for compact tool UI.
 *
 * Merges back-to-back read + read_many calls into `Read (N)` blocks (N = unique paths).
 * Dedupes by normalized absolute path. Line ranges live on tree detail lines, not the header.
 * Same-path continuation reads chain ranges: `:1-200 · continued :201-700`.
 */
import { homedir } from "node:os";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { type Container, Text } from "@chengshiliu16/pix-tui";
import {
	bindCategoryContentBreak,
	registerBatchInvalidator,
	resetBatchSettleStore,
	scheduleSettleNotify,
} from "./batch-display-core.ts";
import {
	getBatchGlobalStore,
	type ReadBatchCall,
	type ReadBatchEntry,
	type ReadBatchGroup,
	type ReadRange,
} from "./batch-global-store.ts";
import { displayFullPath, formatToolPath, formatTreeCall, type ThemeLike } from "./format-tree-call.ts";
import { assignReadGroup, getReadGroupId, registerContentBreakListener } from "./tool-batch-sequence.ts";

export type { ReadRange, ReadBatchEntry };

type ReadBatchCallLocal = ReadBatchCall;

export const EMPTY_READ_TEXT = new Text("", 0, 0);

function readStore() {
	return getBatchGlobalStore().read;
}

function getGroup(toolCallId: string): ReadBatchGroup | undefined {
	const groupId = getReadGroupId(toolCallId);
	if (groupId === undefined) return undefined;
	return readStore().readGroups.get(groupId);
}

function ensureGroup(groupId: number): ReadBatchGroup {
	let group = readStore().readGroups.get(groupId);
	if (!group) {
		group = { calls: [], entriesByPath: new Map(), pathOrder: [] };
		readStore().readGroups.set(groupId, group);
	}
	return group;
}

function serializeGroupSnapshot(group: ReadBatchGroup): string {
	const paths = group.pathOrder.map((key) => {
		const entry = group.entriesByPath.get(key)!;
		const ranges = entry.ranges.map((range) => `${range.offset ?? ""}:${range.limit ?? ""}`).join(",");
		return `${key}[${ranges}]${entry.continued ? "c" : ""}${entry.reRead ? "r" : ""}${entry.isError ? "e" : ""}`;
	});
	const calls = group.calls.map((call) => call.toolCallId).join(",");
	return `calls:${calls}|paths:${paths.join(";")}`;
}

function removeReadCallFromOtherGroups(toolCallId: string, targetGroupId: number): void {
	for (const [groupId, group] of readStore().readGroups) {
		if (groupId === targetGroupId) continue;
		const idx = group.calls.findIndex((c) => c.toolCallId === toolCallId);
		if (idx >= 0) group.calls.splice(idx, 1);
	}
}

function purgeOrphanReadEntries(): Set<number> {
	const affected = new Set<number>();
	for (const [groupId, group] of readStore().readGroups) {
		const before = group.calls.length;
		group.calls = group.calls.filter((c) => getReadGroupId(c.toolCallId) === groupId);
		if (group.calls.length < before) {
			affected.add(groupId);
		}
		if (group.calls.length === 0) {
			readStore().readGroups.delete(groupId);
		}
	}
	return affected;
}

function ensureReadSlot(
	toolCallId: string,
	toolName: ReadBatchCallLocal["toolName"],
): { groupId: number; group: ReadBatchGroup } {
	const groupId = assignReadGroup(toolCallId);
	removeReadCallFromOtherGroups(toolCallId, groupId);
	const group = ensureGroup(groupId);
	recordCall(group, toolCallId, toolName);
	return { groupId, group };
}

function groupHasRecordedPaths(group: ReadBatchGroup): boolean {
	return group.pathOrder.length > 0;
}

function maybeNotifyIfGroupChanged(groupId: number, group: ReadBatchGroup): void {
	scheduleSettleNotify(readStore(), groupId, group.calls, serializeGroupSnapshot(group), {
		hasVisibleContent: () => groupHasRecordedPaths(group),
		isGroupValid: () => {
			const current = readStore().readGroups.get(groupId);
			return Boolean(current && current.calls.length > 0);
		},
	});
}

export function setReadBatchCwd(cwd: string): void {
	readStore().sessionCwd = cwd;
}

export function resetReadBatch(): void {
	const r = readStore();
	r.readGroups.clear();
	r.recordedToolCallIds.clear();
	r.seenPathsAcrossGroups.clear();
	resetBatchSettleStore(r);
}

export function registerReadInvalidator(toolCallId: string, invalidate: () => void): void {
	registerBatchInvalidator(readStore(), toolCallId, getReadGroupId(toolCallId), invalidate);
}

function expandPath(filePath: string): string {
	if (filePath === "~") return homedir();
	if (filePath.startsWith("~/")) return resolvePath(homedir(), filePath.slice(2));
	return filePath;
}

export function normalizeReadPath(filePath: string, cwd = readStore().sessionCwd): string {
	const expanded = expandPath(filePath);
	if (isAbsolute(expanded)) return resolvePath(expanded);
	return resolvePath(cwd || process.cwd(), expanded);
}

function hasReadRangeParams(offset?: number, limit?: number): boolean {
	return typeof offset === "number" || typeof limit === "number";
}

function makeReadRange(offset?: number, limit?: number): ReadRange {
	return {
		offset: typeof offset === "number" ? offset : undefined,
		limit: typeof limit === "number" ? limit : undefined,
	};
}

/** Ranges for one read_many path — offset only when requested and the read succeeded. */
function resolveReadManyPathRanges(offset?: number, limit?: number, file?: { isError?: boolean }): ReadRange[] {
	if (!hasReadRangeParams(offset, limit)) return [];
	if (file?.isError) return [];
	if (file) return [makeReadRange(offset, limit)];
	// Before per-file results arrive, don't paint the global offset on every path.
	return [];
}

function upsertPath(
	group: ReadBatchGroup,
	path: string,
	offset?: number,
	limit?: number,
	continued?: boolean,
	replaceRanges = false,
): boolean {
	const normalizedPath = normalizeReadPath(path);
	const newRanges = hasReadRangeParams(offset, limit) ? [makeReadRange(offset, limit)] : [];

	const existing = group.entriesByPath.get(normalizedPath);
	if (existing) {
		if (replaceRanges || !hasReadRangeParams(offset, limit)) {
			const unchanged =
				existing.ranges.length === newRanges.length &&
				existing.ranges.every(
					(range, index) => range.offset === newRanges[index]?.offset && range.limit === newRanges[index]?.limit,
				);
			if (unchanged && !continued) return false;
			existing.ranges = newRanges;
			if (continued) existing.continued = true;
			return true;
		}

		const newRange = newRanges[0]!;
		const lastRange = existing.ranges[existing.ranges.length - 1];
		const sameRange =
			lastRange !== undefined && lastRange.offset === newRange.offset && lastRange.limit === newRange.limit;
		if (sameRange && !continued) return false;

		existing.ranges.push(newRange);
		if (continued) existing.continued = true;
		return true;
	}

	const reRead = readStore().seenPathsAcrossGroups.has(normalizedPath);
	group.entriesByPath.set(normalizedPath, {
		path,
		normalizedPath,
		ranges: newRanges,
		continued,
		reRead,
	});
	group.pathOrder.push(normalizedPath);
	// Track path across groups so later groups can mark it as · re-read
	readStore().seenPathsAcrossGroups.add(normalizedPath);
	return true;
}

function recordCall(group: ReadBatchGroup, toolCallId: string, toolName: ReadBatchCallLocal["toolName"]): boolean {
	if (group.calls.some((c) => c.toolCallId === toolCallId)) return false;
	group.calls.push({ toolCallId, toolName });
	return true;
}

export function getReadBatch(toolCallId: string): readonly ReadBatchEntry[] {
	const group = getGroup(toolCallId);
	if (!group) return [];
	return group.pathOrder.map((key) => group.entriesByPath.get(key)!);
}

/** Multiple tool calls in one consecutive run. */
export function isReadBatchAggregated(toolCallId: string): boolean {
	const group = getGroup(toolCallId);
	return (group?.calls.length ?? 0) > 1;
}

/** Assigned to a consecutive read/read_many group. */
export function isInReadBatch(toolCallId: string): boolean {
	const group = getGroup(toolCallId);
	return (group?.calls.length ?? 0) > 0;
}

/** Anchor = first recorded tool call in the group (sole visible read block). */
export function getReadAnchorToolCallId(toolCallId: string): string | undefined {
	const group = getGroup(toolCallId);
	if (!group || group.calls.length === 0) return undefined;
	return group.calls[0]!.toolCallId;
}

export function isReadAnchor(toolCallId: string): boolean {
	return getReadAnchorToolCallId(toolCallId) === toolCallId;
}

export function isFirstReadInBatch(toolCallId: string): boolean {
	return isReadAnchor(toolCallId);
}

/** True when path looks like a stable absolute/relative file path (not streaming prefix). */
function isPlausibleReadPath(path: string): boolean {
	if (!path || path === "/" || path === "/Users") return false;
	const base = path.split("/").pop() ?? "";
	return base.length > 0 && (base.includes(".") || base.length >= 3);
}

function isPlausibleReadManyPaths(paths: string[]): boolean {
	return paths.length > 0 && paths.every(isPlausibleReadPath);
}

/** True when the batch has at least one recorded path. */
export function readBatchHasContent(toolCallId: string): boolean {
	return getReadBatch(toolCallId).length > 0;
}

export type ReadManyFileArg = { path: string; offset?: number; limit?: number };

export type ReadVisibilityContext = {
	path?: string;
	paths?: string[];
	files?: ReadManyFileArg[];
	argsComplete?: boolean;
};

/** Batch store paths, or args.path/paths once argsComplete (tool_call may arrive empty). */
export function readHasVisiblePath(toolCallId: string, context: ReadVisibilityContext = {}): boolean {
	if (readBatchHasContent(toolCallId)) return true;
	if (!context.argsComplete) return false;
	if (Array.isArray(context.paths) && context.paths.some((p) => typeof p === "string" && p.length > 0)) {
		return true;
	}
	if (Array.isArray(context.files) && context.files.some((f) => typeof f?.path === "string" && f.path.length > 0)) {
		return true;
	}
	return typeof context.path === "string" && context.path.length > 0;
}

/** Hide the tool row until solo or aggregated read content is ready (avoids empty slots). */
export function readCallShouldHideUntilReady(toolCallId: string, context: ReadVisibilityContext = {}): boolean {
	if (!isInReadBatch(toolCallId)) return false;
	const hasContent = readHasVisiblePath(toolCallId, context);
	if (isReadBatchAggregated(toolCallId)) {
		return !isReadAnchor(toolCallId) || !hasContent;
	}
	return !hasContent;
}

export function recordReadToolCall(toolCallId: string, toolName: string, input: Record<string, unknown>): void {
	if (toolName === "read") {
		const path = typeof input.path === "string" ? input.path : "";
		const { groupId, group } = ensureReadSlot(toolCallId, "read");
		const hadPaths = groupHasRecordedPaths(group);
		if (path) {
			upsertPath(
				group,
				path,
				typeof input.offset === "number" ? input.offset : undefined,
				typeof input.limit === "number" ? input.limit : undefined,
			);
		}

		if (!readStore().recordedToolCallIds.has(toolCallId)) {
			readStore().recordedToolCallIds.add(toolCallId);
			if (!path && !hadPaths) {
				maybeNotifyIfGroupChanged(groupId, group);
				return;
			}
		}

		if (path) {
			maybeNotifyIfGroupChanged(groupId, group);
		}
		return;
	}

	if (toolName === "read_many") {
		const fileItems = Array.isArray(input.files)
			? input.files.filter(
					(f): f is ReadManyFileArg =>
						typeof f === "object" &&
						f !== null &&
						typeof (f as ReadManyFileArg).path === "string" &&
						(f as ReadManyFileArg).path.length > 0,
				)
			: [];
		const paths = Array.isArray(input.paths)
			? input.paths.filter((p): p is string => typeof p === "string" && p.length > 0)
			: [];
		const { groupId, group } = ensureReadSlot(toolCallId, "read_many");
		const hadPaths = groupHasRecordedPaths(group);
		if (fileItems.length > 0) {
			for (const file of fileItems) {
				upsertPath(
					group,
					file.path,
					typeof file.offset === "number" ? file.offset : undefined,
					typeof file.limit === "number" ? file.limit : undefined,
					false,
					true,
				);
			}
		} else if (paths.length > 0) {
			for (const path of paths) {
				// paths[] + global offset: defer range until execution results (homogeneous batch).
				upsertPath(group, path, undefined, undefined, false, true);
			}
		}

		if (!readStore().recordedToolCallIds.has(toolCallId)) {
			readStore().recordedToolCallIds.add(toolCallId);
			if (fileItems.length === 0 && paths.length === 0 && !hadPaths) {
				maybeNotifyIfGroupChanged(groupId, group);
				return;
			}
		}

		if (fileItems.length > 0 || paths.length > 0) {
			maybeNotifyIfGroupChanged(groupId, group);
		}
	}
}

/** Apply per-file read_many results so offset suffixes match what actually executed. */
export function applyReadManyResultRanges(
	toolCallId: string,
	files: { path: string; isError?: boolean; offset?: number; limit?: number }[],
	fallbackOffset?: number,
	fallbackLimit?: number,
): void {
	const groupId = getReadGroupId(toolCallId);
	if (groupId === undefined) return;
	const group = readStore().readGroups.get(groupId);
	if (!group) return;

	let changed = false;
	for (const file of files) {
		const key = normalizeReadPath(file.path);
		const entry = group.entriesByPath.get(key);
		if (!entry) continue;
		const fileOffset = typeof file.offset === "number" ? file.offset : fallbackOffset;
		const fileLimit = typeof file.limit === "number" ? file.limit : fallbackLimit;
		const nextRanges = resolveReadManyPathRanges(fileOffset, fileLimit, file);
		const unchanged =
			entry.ranges.length === nextRanges.length &&
			entry.ranges.every(
				(range, index) => range.offset === nextRanges[index]?.offset && range.limit === nextRanges[index]?.limit,
			);
		if (unchanged && entry.isError === file.isError) continue;
		entry.ranges = nextRanges;
		if (file.isError !== undefined) {
			entry.isError = file.isError;
		}
		changed = true;
	}

	if (changed) maybeNotifyIfGroupChanged(groupId, group);
}

/** Optional truncation hint from renderCall context (read-many passes result when available). */
export function applyReadTruncationHint(
	toolCallId: string,
	path: string,
	truncation: { outputLines?: number; totalLines?: number } | undefined,
): void {
	if (!truncation?.outputLines || !truncation.totalLines) return;
	if (truncation.outputLines >= truncation.totalLines) return;
	const groupId = getReadGroupId(toolCallId);
	if (groupId === undefined) return;
	const group = readStore().readGroups.get(groupId);
	if (!group) return;
	const key = normalizeReadPath(path);
	const entry = group.entriesByPath.get(key);
	if (!entry || entry.continued) return;
	entry.continued = true;
	maybeNotifyIfGroupChanged(groupId, group);
}

function formatRangeSuffix(range: ReadRange): string {
	if (typeof range.offset === "number") {
		if (typeof range.limit === "number") {
			const end = range.offset + range.limit - 1;
			return `:${range.offset}-${end}`;
		}
		return `:${range.offset}+`;
	}
	return "";
}

function formatReadDetailLine(entry: ReadBatchEntry, theme: ThemeLike): string {
	const path = displayFullPath(entry.normalizedPath || entry.path);
	if (entry.ranges.length === 0) {
		const suffixes: string[] = [];
		if (entry.reRead) suffixes.push(theme.fg("dim", "· re-read"));
		if (entry.continued) suffixes.push(theme.fg("warning", "· continued"));
		return suffixes.length > 0 ? `${formatToolPath(path)} ${suffixes.join(" ")}` : formatToolPath(path);
	}

	let line = path;
	for (let i = 0; i < entry.ranges.length; i++) {
		const suffix = formatRangeSuffix(entry.ranges[i]!);
		if (i === 0) {
			line += suffix;
		} else {
			line += ` · continued${suffix}`;
		}
	}
	line = formatToolPath(line);
	if (entry.reRead) {
		line += ` ${theme.fg("dim", "· re-read")}`;
	}
	if (entry.continued) {
		line += ` ${theme.fg("warning", "· continued")}`;
	}
	return line;
}

export function formatAggregatedReadCall(theme: ThemeLike, toolCallId: string, failed?: number): Container | Text {
	const entries = getReadBatch(toolCallId);
	if (entries.length === 0) return EMPTY_READ_TEXT;
	const n = entries.length;
	const failedCount = failed ?? entries.filter((e) => e.isError).length;
	let header = n > 1 ? `Read (${n})` : "Read";
	if (failedCount > 0) header += ` ${theme.fg("error", `· ${failedCount} failed`)}`;
	const items = entries.map((e) => formatReadDetailLine(e, theme));
	return formatTreeCall(theme, header, items);
}

export function formatReadCallWithBatch(
	args: { path?: string; offset?: number; limit?: number },
	theme: ThemeLike,
	toolCallId?: string,
	invalidate?: () => void,
	truncation?: { outputLines?: number; totalLines?: number },
	argsComplete = false,
): Container | Text {
	if (toolCallId && invalidate) {
		registerReadInvalidator(toolCallId, invalidate);
	}

	const path = typeof args?.path === "string" ? args.path : "";
	if (toolCallId && path && truncation && getReadGroupId(toolCallId) !== undefined) {
		applyReadTruncationHint(toolCallId, path, truncation);
	}

	// Batch rendering: always return EMPTY for batch reads (including solo anchors).
	// updateDisplay (buildFallbackCall) paints content and stays fresh when the
	// batch grows — same pattern as bash. renderCall progressive display caused
	// empty Box rows while argsComplete was still false or before aggregation.
	if (toolCallId && isInReadBatch(toolCallId)) {
		return EMPTY_READ_TEXT;
	}

	// Standalone rendering: only show when argsComplete and path is plausible.
	// No progressive display for reads — it causes visual flicker when the
	// batch later takes over (duplicate blocks, sudden re-merging).
	if (!path || !argsComplete || !isPlausibleReadPath(path)) {
		return EMPTY_READ_TEXT;
	}
	const entry: ReadBatchEntry = {
		path,
		normalizedPath: normalizeReadPath(path),
		ranges:
			typeof args.offset === "number" || typeof args.limit === "number"
				? [{ offset: args.offset, limit: args.limit }]
				: [],
		continued: Boolean(
			truncation?.outputLines && truncation?.totalLines && truncation.outputLines < truncation.totalLines,
		),
	};
	return formatTreeCall(theme, "Read", [formatReadDetailLine(entry, theme)]);
}

type ReadManyFileResult = {
	path: string;
	isError?: boolean;
	offset?: number;
	limit?: number;
	details?: { truncation?: { outputLines?: number; totalLines?: number } };
};

function resolveReadManyDisplayTargets(args: { files?: ReadManyFileArg[]; paths?: string[] }): ReadManyFileArg[] {
	const fileItems = Array.isArray(args.files)
		? args.files.filter((f) => typeof f?.path === "string" && f.path.length > 0)
		: [];
	if (fileItems.length > 0) return fileItems;
	const paths = Array.isArray(args.paths)
		? args.paths.filter((p): p is string => typeof p === "string" && p.length > 0)
		: [];
	return paths.map((path) => ({ path }));
}

export function formatReadManyCallWithBatch(
	args: { files?: ReadManyFileArg[]; paths?: string[]; offset?: number; limit?: number },
	theme: ThemeLike,
	failed = 0,
	toolCallId?: string,
	invalidate?: () => void,
	fileTruncations?: ReadManyFileResult[],
	argsComplete = false,
	aggregateTruncated?: boolean,
): Container | Text {
	if (toolCallId && invalidate) {
		registerReadInvalidator(toolCallId, invalidate);
	}

	const targets = resolveReadManyDisplayTargets(args);
	const paths = targets.map((t) => t.path);
	if (toolCallId && getReadGroupId(toolCallId) !== undefined) {
		for (const file of fileTruncations ?? []) {
			applyReadTruncationHint(toolCallId, file.path, file.details?.truncation);
		}
	}

	const fallbackOffset = args.offset;
	const fallbackLimit = args.limit;

	// Batch rendering: always return EMPTY for batch reads (including solo anchors).
	// updateDisplay (buildFallbackCall) paints content and stays fresh when the
	// batch grows — same pattern as bash.
	if (toolCallId && isInReadBatch(toolCallId)) {
		if (argsComplete && fileTruncations?.length) {
			applyReadManyResultRanges(toolCallId, fileTruncations, fallbackOffset, fallbackLimit);
		}
		return EMPTY_READ_TEXT;
	}

	// Standalone rendering: only show when argsComplete and all paths are plausible.
	// No progressive display for read_many — it causes visual flicker when
	// the batch later takes over (duplicate blocks, sudden re-merging).
	if (paths.length === 0 || !argsComplete || !isPlausibleReadManyPaths(paths)) {
		return EMPTY_READ_TEXT;
	}

	if (toolCallId && fileTruncations?.length) {
		applyReadManyResultRanges(toolCallId, fileTruncations, fallbackOffset, fallbackLimit);
	}
	let header = `Read (${paths.length})`;
	if (failed > 0) header += ` ${theme.fg("error", `· ${failed} failed`)}`;
	const items = targets.map((target) => {
		const fileInfo = fileTruncations?.find((f) => normalizeReadPath(f.path) === normalizeReadPath(target.path));
		const trunc = fileInfo?.details?.truncation;
		const isTruncated = Boolean(trunc?.outputLines && trunc?.totalLines && trunc.outputLines < trunc.totalLines);
		const fileOffset =
			typeof fileInfo?.offset === "number"
				? fileInfo.offset
				: typeof target.offset === "number"
					? target.offset
					: fallbackOffset;
		const fileLimit =
			typeof fileInfo?.limit === "number"
				? fileInfo.limit
				: typeof target.limit === "number"
					? target.limit
					: fallbackLimit;
		const entry: ReadBatchEntry = {
			path: target.path,
			normalizedPath: normalizeReadPath(target.path),
			ranges: resolveReadManyPathRanges(fileOffset, fileLimit, fileInfo),
			continued: isTruncated || (aggregateTruncated ?? false),
		};
		return formatReadDetailLine(entry, theme);
	});
	return formatTreeCall(theme, header, items);
}

bindCategoryContentBreak(registerContentBreakListener, readStore(), purgeOrphanReadEntries);
