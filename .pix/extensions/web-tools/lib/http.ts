export function createTimeoutSignal(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cleanup(): void } {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);

	const abortFromParent = () => controller.abort(parent?.reason);
	if (parent?.aborted) {
		abortFromParent();
	} else {
		parent?.addEventListener("abort", abortFromParent, { once: true });
	}

	return {
		signal: controller.signal,
		cleanup() {
			clearTimeout(timer);
			parent?.removeEventListener("abort", abortFromParent);
		},
	};
}

export function defaultFetch(): typeof fetch {
	return fetch;
}
