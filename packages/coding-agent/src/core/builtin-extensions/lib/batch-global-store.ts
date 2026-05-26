/**
 * Cross-extension batch state. Pi loads each extension via a separate jiti instance
 * (moduleCache: false), so module-level Maps in lib/* are NOT shared between
 * activity-widget (tool_call tracking) and compact-tools (render + visibility patch).
 * All batch modules must read/write through this global singleton.
 */
import type { BatchInvalidatorEntry } from "./batch-display-core.ts";

const STORE_KEY = Symbol.for("pi.extensions.batch-display.v1");

export type ToolCategory = "bash" | "read" | "other";

export type BashBatchEntry = {
	toolCallId: string;
	command: string;
};

export type ReadRange = {
	offset?: number;
	limit?: number;
};

export type ReadBatchEntry = {
	path: string;
	normalizedPath: string;
	ranges: ReadRange[];
	continued?: boolean;
	reRead?: boolean;
	isError?: boolean;
};

export type ReadBatchCall = {
	toolCallId: string;
	toolName: "read" | "read_many";
};

export type ReadBatchGroup = {
	calls: ReadBatchCall[];
	entriesByPath: Map<string, ReadBatchEntry>;
	pathOrder: string[];
};

export type BatchGlobalStore = {
	sequence: {
		lastCategory: ToolCategory | null;
		contentBreakSeq: number;
		toolsSinceLastBreak: boolean;
		toolsInCurrentAssistantMessage: boolean;
		activeTextBlockFollowsToolsInMessage: boolean | null;
		activeBashBreakSeq: number;
		activeReadBreakSeq: number;
		bashGroupSeq: number;
		readGroupSeq: number;
		bashGroupByToolCall: Map<string, number>;
		readGroupByToolCall: Map<string, number>;
		/** tool_call / execution order for chat row placement (see tool-display-order.ts). */
		toolCallOrder: string[];
		contentBreakListeners: Set<() => void>;
	};
	bash: {
		bashGroups: Map<number, BashBatchEntry[]>;
		groupSnapshots: Map<number, string>;
		invalidators: Map<string, BatchInvalidatorEntry>;
		recordedToolCallIds: Set<string>;
		settleGeneration: Map<number, number>;
		pendingInvalidation: boolean;
	};
	read: {
		sessionCwd: string;
		readGroups: Map<number, ReadBatchGroup>;
		groupSnapshots: Map<number, string>;
		invalidators: Map<string, BatchInvalidatorEntry>;
		recordedToolCallIds: Set<string>;
		settleGeneration: Map<number, number>;
		pendingInvalidation: boolean;
		seenPathsAcrossGroups: Set<string>;
	};
};

function createInitialStore(): BatchGlobalStore {
	return {
		sequence: {
			lastCategory: null,
			contentBreakSeq: 0,
			toolsSinceLastBreak: false,
			toolsInCurrentAssistantMessage: false,
			activeTextBlockFollowsToolsInMessage: null,
			activeBashBreakSeq: -1,
			activeReadBreakSeq: -1,
			bashGroupSeq: 0,
			readGroupSeq: 0,
			bashGroupByToolCall: new Map(),
			readGroupByToolCall: new Map(),
			toolCallOrder: [],
			contentBreakListeners: new Set(),
		},
		bash: {
			bashGroups: new Map(),
			groupSnapshots: new Map(),
			invalidators: new Map(),
			recordedToolCallIds: new Set(),
			settleGeneration: new Map(),
			pendingInvalidation: false,
		},
		read: {
			sessionCwd: "",
			readGroups: new Map(),
			groupSnapshots: new Map(),
			invalidators: new Map(),
			recordedToolCallIds: new Set(),
			settleGeneration: new Map(),
			pendingInvalidation: false,
			seenPathsAcrossGroups: new Set(),
		},
	};
}

/** Backfill fields added after first store creation (survives /reload without session restart). */
function migrateBatchGlobalStore(store: BatchGlobalStore): BatchGlobalStore {
	const s = store.sequence;
	if (!Array.isArray(s.toolCallOrder)) {
		s.toolCallOrder = [];
	}
	if (!(s.contentBreakListeners instanceof Set)) {
		s.contentBreakListeners = new Set();
	}
	return store;
}

export function getBatchGlobalStore(): BatchGlobalStore {
	const root = globalThis as Record<symbol, BatchGlobalStore>;
	if (!root[STORE_KEY]) {
		root[STORE_KEY] = createInitialStore();
	} else {
		migrateBatchGlobalStore(root[STORE_KEY]);
	}
	return root[STORE_KEY];
}

/** Reset all batch state (bash/read groups + sequence). Called from activity-widget only. */
export function resetAllBatchState(): void {
	const store = getBatchGlobalStore();

	store.bash.bashGroups.clear();
	store.bash.groupSnapshots.clear();
	store.bash.invalidators.clear();
	store.bash.recordedToolCallIds.clear();
	store.bash.settleGeneration.clear();
	store.bash.pendingInvalidation = false;

	store.read.readGroups.clear();
	store.read.groupSnapshots.clear();
	store.read.invalidators.clear();
	store.read.recordedToolCallIds.clear();
	store.read.settleGeneration.clear();
	store.read.pendingInvalidation = false;
	store.read.seenPathsAcrossGroups.clear();
	store.read.sessionCwd = "";

	const s = store.sequence;
	s.lastCategory = null;
	s.contentBreakSeq = 0;
	s.toolsSinceLastBreak = false;
	s.toolsInCurrentAssistantMessage = false;
	s.activeTextBlockFollowsToolsInMessage = null;
	s.activeBashBreakSeq = -1;
	s.activeReadBreakSeq = -1;
	s.bashGroupSeq = 0;
	s.readGroupSeq = 0;
	s.bashGroupByToolCall.clear();
	s.readGroupByToolCall.clear();
	if (!Array.isArray(s.toolCallOrder)) {
		s.toolCallOrder = [];
	} else {
		s.toolCallOrder.length = 0;
	}
}

/** Snapshot for /batch-debug and tests simulating cross-extension isolation. */
export function snapshotBatchDebugState(): {
	bashGroups: Record<string, string[]>;
	readGroups: Record<string, string[]>;
	bashGroupByToolCall: Record<string, number>;
	readGroupByToolCall: Record<string, number>;
} {
	const store = getBatchGlobalStore();
	const bashGroups: Record<string, string[]> = {};
	for (const [groupId, entries] of store.bash.bashGroups) {
		bashGroups[String(groupId)] = entries.map((e) => e.toolCallId);
	}
	const readGroups: Record<string, string[]> = {};
	for (const [groupId, group] of store.read.readGroups) {
		readGroups[String(groupId)] = group.calls.map((c) => c.toolCallId);
	}
	return {
		bashGroups,
		readGroups,
		bashGroupByToolCall: Object.fromEntries(store.sequence.bashGroupByToolCall),
		readGroupByToolCall: Object.fromEntries(store.sequence.readGroupByToolCall),
	};
}
