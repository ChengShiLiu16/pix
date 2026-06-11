/**
 * Bash Spawn Hook Example
 *
 * Adjusts command, cwd, and env before execution.
 *
 * Usage:
 *   pix -e ./bash-spawn-hook.ts
 */

import type { ExtensionAPI } from "@chengshiliu16/pix-coding-agent";
import { createBashTool } from "@chengshiliu16/pix-coding-agent";

export default function (pix: ExtensionAPI) {
	const cwd = process.cwd();

	const bashTool = createBashTool(cwd, {
		spawnHook: ({ command, cwd, env }) => ({
			command: `source ~/.profile\n${command}`,
			cwd,
			env: { ...env, PIX_SPAWN_HOOK: "1" },
		}),
	});

	pix.registerTool({
		...bashTool,
		execute: async (id, params, signal, onUpdate, _ctx) => {
			return bashTool.execute(id, params, signal, onUpdate);
		},
	});
}
