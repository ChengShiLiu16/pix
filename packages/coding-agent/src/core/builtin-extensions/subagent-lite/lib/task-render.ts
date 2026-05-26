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
