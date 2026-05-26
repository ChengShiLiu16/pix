export const INPUT_HISTORY_LIMIT = 100;

export type InputHistoryFile = {
	version: 1;
	limit: number;
	updatedAt: string;
	entries: string[];
};

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeInputHistoryEntries(entries: readonly unknown[], limit = INPUT_HISTORY_LIMIT): string[] {
	const normalized: string[] = [];
	const seen = new Set<string>();

	for (const entry of entries) {
		if (typeof entry !== "string") continue;
		const trimmed = entry.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		normalized.push(trimmed);
		seen.add(trimmed);
		if (normalized.length >= limit) break;
	}

	return normalized;
}

export function parseInputHistoryFile(value: unknown, limit = INPUT_HISTORY_LIMIT): string[] {
	if (Array.isArray(value)) {
		return normalizeInputHistoryEntries(value, limit);
	}

	if (isObject(value) && Array.isArray(value.entries)) {
		return normalizeInputHistoryEntries(value.entries, limit);
	}

	return [];
}

export function mergeInputHistoryEntries(
	primaryEntries: readonly unknown[],
	fallbackEntries: readonly unknown[],
	limit = INPUT_HISTORY_LIMIT,
): string[] {
	return normalizeInputHistoryEntries([...primaryEntries, ...fallbackEntries], limit);
}

export function recordInputHistoryEntry(
	entries: readonly unknown[],
	text: string,
	limit = INPUT_HISTORY_LIMIT,
): string[] {
	const trimmed = text.trim();
	if (!trimmed) {
		return normalizeInputHistoryEntries(entries, limit);
	}

	return normalizeInputHistoryEntries([trimmed, ...entries], limit);
}

export function createInputHistoryFile(entries: readonly string[], limit = INPUT_HISTORY_LIMIT): InputHistoryFile {
	return {
		version: 1,
		limit,
		updatedAt: new Date().toISOString(),
		entries: normalizeInputHistoryEntries(entries, limit),
	};
}
