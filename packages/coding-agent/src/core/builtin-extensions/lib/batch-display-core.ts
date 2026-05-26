/**
 * Shared batch invalidation, settle-notify, and content-break wiring for
 * bash/read/todo batch-display modules.
 */

export type BatchInvalidatorEntry = {
	invalidate: () => void;
	groupId: number;
};

export type BatchInvalidationStore = {
	invalidators: Map<string, BatchInvalidatorEntry>;
	pendingInvalidation: boolean;
	/** Microtask coalescing key — only one deferred flush per group at a time. */
	pendingGroupIds?: Set<number>;
};

export type BatchSettleStore = BatchInvalidationStore & {
	groupSnapshots: Map<number, string>;
	settleGeneration: Map<number, number>;
};

/** Test-only flush counters (reset via resetInvalidationMetrics). */
const invalidationMetrics = {
	totalFlushes: 0,
	perToolCallId: new Map<string, number>(),
};

export function resetInvalidationMetrics(): void {
	invalidationMetrics.totalFlushes = 0;
	invalidationMetrics.perToolCallId.clear();
}

export function snapshotInvalidationMetrics(): {
	totalFlushes: number;
	perToolCallId: Record<string, number>;
} {
	return {
		totalFlushes: invalidationMetrics.totalFlushes,
		perToolCallId: Object.fromEntries(invalidationMetrics.perToolCallId),
	};
}

function recordFlush(toolCallId: string): void {
	invalidationMetrics.totalFlushes += 1;
	invalidationMetrics.perToolCallId.set(toolCallId, (invalidationMetrics.perToolCallId.get(toolCallId) ?? 0) + 1);
}

export function registerBatchInvalidator(
	store: BatchInvalidationStore,
	toolCallId: string,
	groupId: number | undefined,
	invalidate: () => void,
): void {
	store.invalidators.set(toolCallId, {
		invalidate,
		groupId: groupId ?? -1,
	});
}

export function flushBatchInvalidators(store: BatchInvalidationStore, groupIds?: ReadonlySet<number>): number {
	let count = 0;
	for (const [toolCallId, entry] of store.invalidators) {
		if (groupIds !== undefined && !groupIds.has(entry.groupId)) continue;
		try {
			entry.invalidate();
			recordFlush(toolCallId);
			count += 1;
		} catch {
			// ignore stale invalidators
		}
	}
	return count;
}

export function notifyBatchInvalidators(
	store: BatchInvalidationStore,
	options: { immediate?: boolean; groupId?: number; groupIds?: ReadonlySet<number> } = {},
): void {
	const { immediate = false, groupId, groupIds } = options;
	const targetGroupIds = groupIds ?? (groupId !== undefined ? new Set([groupId]) : undefined);

	if (immediate) {
		store.pendingInvalidation = false;
		store.pendingGroupIds = undefined;
		flushBatchInvalidators(store, targetGroupIds);
		return;
	}

	if (targetGroupIds !== undefined) {
		if (!store.pendingGroupIds) {
			store.pendingGroupIds = new Set();
		}
		for (const id of targetGroupIds) {
			store.pendingGroupIds.add(id);
		}
		if (store.pendingInvalidation) return;
		store.pendingInvalidation = true;
		queueMicrotask(() => {
			store.pendingInvalidation = false;
			const pending = store.pendingGroupIds;
			store.pendingGroupIds = undefined;
			flushBatchInvalidators(store, pending);
		});
		return;
	}

	if (store.pendingInvalidation) return;
	store.pendingInvalidation = true;
	queueMicrotask(() => {
		store.pendingInvalidation = false;
		flushBatchInvalidators(store);
	});
}

export function resetBatchInvalidationStore(store: BatchInvalidationStore): void {
	store.invalidators.clear();
	store.pendingInvalidation = false;
	store.pendingGroupIds = undefined;
}

export function resetBatchSettleStore(store: BatchSettleStore): void {
	resetBatchInvalidationStore(store);
	store.groupSnapshots.clear();
	store.settleGeneration.clear();
}

/**
 * Notify when group snapshot changes. Immediate when size >= minBatchSize;
 * otherwise defer one microtask unless group already has visible content.
 */
export function scheduleSettleNotify<T>(
	store: BatchSettleStore,
	groupId: number,
	group: T[],
	snapshot: string,
	options: {
		minBatchSize?: number;
		hasVisibleContent?: (group: T[]) => boolean;
		isGroupValid?: () => boolean;
	} = {},
): void {
	const { minBatchSize = 2, hasVisibleContent = () => false, isGroupValid } = options;
	const previous = store.groupSnapshots.get(groupId);
	if (previous === snapshot) return;
	store.groupSnapshots.set(groupId, snapshot);

	const nextGen = (store.settleGeneration.get(groupId) ?? 0) + 1;
	store.settleGeneration.set(groupId, nextGen);

	if (group.length >= minBatchSize) {
		notifyBatchInvalidators(store, { immediate: true, groupId });
		return;
	}

	if (hasVisibleContent(group)) return;

	queueMicrotask(() => {
		if (store.settleGeneration.get(groupId) !== nextGen) return;
		if (isGroupValid && !isGroupValid()) return;
		notifyBatchInvalidators(store, { groupId });
	});
}

/** Wire content-break purge + group-scoped invalidation for one batch category. */
export function bindCategoryContentBreak(
	registerListener: (listener: () => void) => void,
	store: BatchInvalidationStore,
	purge: () => Set<number>,
): void {
	registerListener(() => {
		const affectedGroupIds = purge();
		if (affectedGroupIds.size > 0) {
			notifyBatchInvalidators(store, { immediate: true, groupIds: affectedGroupIds });
		}
	});
}
