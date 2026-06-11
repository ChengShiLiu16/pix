/**
 * Optional batch / visibility debug logging.
 * Enable with PIX_BATCH_DEBUG=1 or `/batch-debug on`.
 */
let runtimeDebugEnabled = process.env.PIX_BATCH_DEBUG === "1";

export function setBatchDebugEnabled(enabled: boolean): void {
	runtimeDebugEnabled = enabled;
}

export function isBatchDebugEnabled(): boolean {
	return runtimeDebugEnabled || process.env.PIX_BATCH_DEBUG === "1";
}

export function logBatchDebug(message: string, detail?: Record<string, unknown>): void {
	if (!isBatchDebugEnabled()) return;
	if (detail) {
		console.info(`[batch-debug] ${message}`, detail);
		return;
	}
	console.info(`[batch-debug] ${message}`);
}
