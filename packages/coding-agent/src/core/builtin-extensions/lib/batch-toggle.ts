/**
 * Custom batch/compact tool folding (bash/read/todo merge + visibility patch).
 * Always ON globally — no toggle.
 */
export const SETTINGS_KEY = "customBatchDisplay";

/** Custom batch folding is always enabled. */
export function isCustomBatchEnabled(): boolean {
	return true;
}

/** @deprecated Batch folding is always on; kept for extension init compatibility. */
export function syncCustomBatchFromSettings(): boolean {
	return true;
}
