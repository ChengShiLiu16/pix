import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const aiSrcIndex = fileURLToPath(new URL("../ai/src/index.ts", import.meta.url));
const aiSrcOAuth = fileURLToPath(new URL("../ai/src/oauth.ts", import.meta.url));
const agentSrcIndex = fileURLToPath(new URL("../agent/src/index.ts", import.meta.url));
const tuiSrcIndex = fileURLToPath(new URL("../tui/src/index.ts", import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
		server: {
			deps: {
				external: [/@silvia-odwyer\/photon-node/],
			},
		},
	},
	resolve: {
		alias: [
			{ find: /^@earendil-works\/pix-ai$/, replacement: aiSrcIndex },
			{ find: /^@earendil-works\/pix-ai\/oauth$/, replacement: aiSrcOAuth },
			{ find: /^@earendil-works\/pix-agent-core$/, replacement: agentSrcIndex },
			{ find: /^@earendil-works\/pix-tui$/, replacement: tuiSrcIndex },
			{ find: /^@mariozechner\/pix-ai$/, replacement: aiSrcIndex },
			{ find: /^@mariozechner\/pix-ai\/oauth$/, replacement: aiSrcOAuth },
			{ find: /^@mariozechner\/pix-agent-core$/, replacement: agentSrcIndex },
		],
	},
});
