import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const aiSrcIndex = fileURLToPath(new URL("../ai/src/index.ts", import.meta.url));
const aiSrcBase = fileURLToPath(new URL("../ai/src/base.ts", import.meta.url));
const aiSrcOAuth = fileURLToPath(new URL("../ai/src/oauth.ts", import.meta.url));
const aiOpenRouterImages = fileURLToPath(new URL("../ai/src/providers/images/openrouter.ts", import.meta.url));
const agentSrcIndex = fileURLToPath(new URL("../agent/src/index.ts", import.meta.url));
const agentSrcBase = fileURLToPath(new URL("../agent/src/base.ts", import.meta.url));
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
			{ find: /^@chengshiliu16\/pix-ai$/, replacement: aiSrcIndex },
			{ find: /^@chengshiliu16\/pix-ai\/base$/, replacement: aiSrcBase },
			{ find: /^@chengshiliu16\/pix-ai\/oauth$/, replacement: aiSrcOAuth },
			{ find: /^@chengshiliu16\/pix-ai\/openrouter-images$/, replacement: aiOpenRouterImages },
			{ find: /^@chengshiliu16\/pix-agent-core$/, replacement: agentSrcIndex },
			{ find: /^@chengshiliu16\/pix-agent-core\/base$/, replacement: agentSrcBase },
			{ find: /^@chengshiliu16\/pix-tui$/, replacement: tuiSrcIndex },
			{ find: /^@chengshiliu16\/pix-ai$/, replacement: aiSrcIndex },
			{ find: /^@chengshiliu16\/pix-ai\/base$/, replacement: aiSrcBase },
			{ find: /^@chengshiliu16\/pix-ai\/oauth$/, replacement: aiSrcOAuth },
			{ find: /^@chengshiliu16\/pix-ai\/openrouter-images$/, replacement: aiOpenRouterImages },
			{ find: /^@chengshiliu16\/pix-agent-core$/, replacement: agentSrcIndex },
			{ find: /^@chengshiliu16\/pix-agent-core\/base$/, replacement: agentSrcBase },
			{ find: /^@chengshiliu16\/pix-tui$/, replacement: tuiSrcIndex },
		],
	},
});
