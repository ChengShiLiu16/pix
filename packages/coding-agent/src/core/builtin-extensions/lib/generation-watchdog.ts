export const WATCHDOG_DELAY_MS = 8000;

export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds % 60;
	return `${minutes}m${remainder.toString().padStart(2, "0")}s`;
}

export function shouldShowGenerationWatchdog(elapsedMs: number, delayMs = WATCHDOG_DELAY_MS): boolean {
	return elapsedMs >= delayMs;
}

export function generationWatchdogStatus(elapsedMs: number, idleMs: number): string {
	return `generating ${formatDuration(elapsedMs)} · last update ${formatDuration(idleMs)} ago`;
}
