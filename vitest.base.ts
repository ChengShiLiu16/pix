import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export const workspaceSourcePaths = {
	aiIndex: fileURLToPath(new URL("./packages/ai/src/index.ts", import.meta.url)),
	aiCompat: fileURLToPath(new URL("./packages/ai/src/compat.ts", import.meta.url)),
	aiOAuth: fileURLToPath(new URL("./packages/ai/src/oauth.ts", import.meta.url)),
	aiProviders: fileURLToPath(new URL("./packages/ai/src/providers", import.meta.url)),
	agentIndex: fileURLToPath(new URL("./packages/agent/src/index.ts", import.meta.url)),
	codingAgentIndex: fileURLToPath(new URL("./packages/coding-agent/src/index.ts", import.meta.url)),
	tuiIndex: fileURLToPath(new URL("./packages/tui/src/index.ts", import.meta.url)),
} as const;

export default defineConfig({
	resolve: {
		alias: [
			{ find: /^@chengshiliu16\/pix-ai$/, replacement: workspaceSourcePaths.aiIndex },
			{ find: /^@chengshiliu16\/pix-ai\/compat$/, replacement: workspaceSourcePaths.aiCompat },
			{ find: /^@chengshiliu16\/pix-ai\/oauth$/, replacement: workspaceSourcePaths.aiOAuth },
			{
				find: /^@chengshiliu16\/pix-ai\/providers\/(.+)$/,
				replacement: `${workspaceSourcePaths.aiProviders}/$1.ts`,
			},
			{ find: /^@chengshiliu16\/pix-agent-core$/, replacement: workspaceSourcePaths.agentIndex },
			{ find: /^@chengshiliu16\/pix-tui$/, replacement: workspaceSourcePaths.tuiIndex },
		],
	},
});
