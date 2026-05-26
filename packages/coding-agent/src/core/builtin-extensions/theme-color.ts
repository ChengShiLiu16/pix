import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "../../index.ts";
import { applyThemeAccentColor, type ThemeFile, themeColorCompletions, themeColorUsage } from "./lib/theme-color.ts";

type SettingsFile = {
	theme?: unknown;
};

function agentRootFromImportUrl(importUrl: string): string {
	return dirname(dirname(fileURLToPath(importUrl)));
}

function parseJsonObject<T extends object>(text: string, path: string): T {
	const parsed: unknown = JSON.parse(text);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Expected JSON object at ${path}`);
	}
	return parsed as T;
}

async function readActiveThemeName(agentRoot: string): Promise<string> {
	const settingsPath = join(agentRoot, "settings.json");
	const settings = parseJsonObject<SettingsFile>(await readFile(settingsPath, "utf8"), settingsPath);
	if (typeof settings.theme !== "string" || !settings.theme.trim()) {
		throw new Error("settings.json does not define a theme name");
	}
	return settings.theme;
}

export function builtin(pi: ExtensionAPI) {
	const agentRoot = agentRootFromImportUrl(import.meta.url);

	pi.registerCommand("theme-color", {
		description: "Set current Pi theme accent color",
		getArgumentCompletions: themeColorCompletions,
		handler: async (args, ctx) => {
			try {
				const themeName = await readActiveThemeName(agentRoot);
				const themePath = join(agentRoot, "themes", `${themeName}.json`);
				const theme = parseJsonObject<ThemeFile>(await readFile(themePath, "utf8"), themePath);
				const result = applyThemeAccentColor(theme, args);
				await writeFile(themePath, `${JSON.stringify(result.theme, null, "\t")}\n`, "utf8");

				const message = `Theme ${themeName} accent set to ${result.color.label} (${result.color.hex}). Reload/restart Pi to apply.`;
				if (ctx.hasUI) ctx.ui.notify(message, "info");
				else console.info(message);
			} catch (error) {
				const message = `${themeColorUsage()}\n${error instanceof Error ? error.message : String(error)}`;
				if (ctx.hasUI) ctx.ui.notify(message, "warning");
				else console.warn(message);
			}
		},
	});
}
