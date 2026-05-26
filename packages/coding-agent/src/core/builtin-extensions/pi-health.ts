import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "../../index.ts";
import { collectPiHealth, formatPiHealth } from "./lib/pi-health.ts";

function agentRootFromImportUrl(importUrl: string): string {
	return dirname(dirname(fileURLToPath(importUrl)));
}

export function builtin(pi: ExtensionAPI) {
	const agentRoot = agentRootFromImportUrl(import.meta.url);

	pi.registerCommand("pi-health", {
		description: "检查 Pi agent 扩展健康状态",
		handler: async (_args, ctx) => {
			const text = formatPiHealth(collectPiHealth(agentRoot));
			if (ctx.hasUI) ctx.ui.notify(text, "info");
			else console.info(text);
		},
	});
}
