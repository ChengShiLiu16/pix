import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "../../index.ts";
import { collectPixHealth, formatPixHealth } from "./lib/pix-health.ts";

function agentRootFromImportUrl(importUrl: string): string {
	return dirname(dirname(fileURLToPath(importUrl)));
}

export function builtin(pix: ExtensionAPI) {
	const agentRoot = agentRootFromImportUrl(import.meta.url);

	pix.registerCommand("pix-health", {
		description: "检查 Pix agent 扩展健康状态",
		handler: async (_args, ctx) => {
			const text = formatPixHealth(collectPixHealth(agentRoot));
			if (ctx.hasUI) ctx.ui.notify(text, "info");
			else console.info(text);
		},
	});
}
