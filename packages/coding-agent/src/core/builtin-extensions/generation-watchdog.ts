import type { ExtensionAPI, ExtensionContext } from "../../index.ts";
import { generationWatchdogStatus, shouldShowGenerationWatchdog } from "./lib/generation-watchdog.ts";

const STATUS_KEY = "generation-watchdog";
const TICK_MS = 1000;

export function builtin(pi: ExtensionAPI) {
	let activeCtx: ExtensionContext | undefined;
	let assistantActive = false;
	let startedAt = 0;
	let lastUpdateAt = 0;
	let timer: ReturnType<typeof setInterval> | undefined;

	function clearTimer(): void {
		if (!timer) return;
		clearInterval(timer);
		timer = undefined;
	}

	function clearStatus(): void {
		if (activeCtx?.hasUI) {
			activeCtx.ui.setStatus(STATUS_KEY, undefined);
		}
	}

	function tick(): void {
		if (!activeCtx?.hasUI || !assistantActive) return;
		const now = Date.now();
		const elapsedMs = now - startedAt;
		if (!shouldShowGenerationWatchdog(elapsedMs)) return;
		activeCtx.ui.setStatus(STATUS_KEY, generationWatchdogStatus(elapsedMs, now - lastUpdateAt));
	}

	function start(ctx: ExtensionContext): void {
		activeCtx = ctx;
		assistantActive = true;
		startedAt = Date.now();
		lastUpdateAt = startedAt;
		clearTimer();
		timer = setInterval(tick, TICK_MS);
	}

	function markUpdate(): void {
		lastUpdateAt = Date.now();
		tick();
	}

	function stop(): void {
		assistantActive = false;
		clearTimer();
		clearStatus();
	}

	pi.on("message_start", async (event, ctx) => {
		if (event.message.role === "assistant") start(ctx);
	});

	pi.on("message_update", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		if (!assistantActive) start(ctx);
		markUpdate();
	});

	pi.on("message_end", async (event) => {
		if (event.message.role === "assistant") stop();
	});

	pi.on("agent_end", async () => {
		stop();
	});

	pi.on("session_shutdown", async () => {
		stop();
		activeCtx = undefined;
	});
}
