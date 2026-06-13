import type { Model } from "@chengshiliu16/pix-ai";
import { setKeybindings, type TUI } from "@chengshiliu16/pix-tui";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../../../src/core/keybindings.ts";
import type { ModelRegistry } from "../../../src/core/model-registry.ts";
import type { SettingsManager } from "../../../src/core/settings-manager.ts";
import { ModelSelectorComponent } from "../../../src/modes/interactive/components/model-selector.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";

function createFakeTui(): TUI {
	return {
		requestRender: () => {},
	} as unknown as TUI;
}

function createModel(provider: string, id: string): Model<any> {
	return {
		provider,
		id,
		name: id,
		api: "anthropic-messages",
		baseUrl: "https://example.test",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 1000,
	};
}

function createSelector(models: Model<any>[], currentModel: Model<any>): ModelSelectorComponent {
	const modelRegistry = {
		refresh: () => {},
		getError: () => undefined,
		getAvailable: async () => models,
	} as unknown as ModelRegistry;
	const settingsManager = {
		setDefaultModelAndProvider: () => {},
	} as unknown as SettingsManager;

	return new ModelSelectorComponent(
		createFakeTui(),
		currentModel,
		settingsManager,
		modelRegistry,
		() => {},
		() => {},
	);
}

async function waitForAsyncRender(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("model selector provider grouping", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("groups models by provider and marks the current model in place", async () => {
		const currentModel = createModel("zai", "glm-5");
		const selector = createSelector(
			[
				createModel("openai", "gpt-5"),
				currentModel,
				createModel("zai", "glm-4"),
				createModel("anthropic", "claude-opus"),
			],
			currentModel,
		);

		await waitForAsyncRender();

		const renderedLines = stripAnsi(selector.render(120).join("\n"))
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0);

		expect(renderedLines).toContain("anthropic (1)");
		expect(renderedLines).toContain("claude-opus");
		expect(renderedLines).toContain("openai (1)");
		expect(renderedLines).toContain("gpt-5");
		expect(renderedLines.filter((line) => line === "zai (2)")).toHaveLength(1);
		expect(renderedLines).toContain("glm-4");
		expect(renderedLines.some((line) => line.endsWith("glm-5 ✓"))).toBe(true);
	});
});
