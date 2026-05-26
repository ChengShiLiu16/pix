import type { WebToolsConfig, WebToolsEnv } from "./types.ts";

export const DEFAULT_WEB_TOOLS_CONFIG: WebToolsConfig = {
	defaultCountry: "US",
	defaultSearchCount: 5,
	maxSearchCount: 10,
	searchTimeoutMs: 8000,
	fetchTimeoutMs: 12000,
	defaultFetchMaxChars: 8000,
	maxFetchMaxChars: 20000,
};

function readInteger(env: WebToolsEnv, key: string, fallback: number, min: number, max: number): number {
	const value = env[key];
	if (!value) return fallback;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.max(min, Math.min(max, parsed));
}

export function getWebToolsConfig(env: WebToolsEnv = process.env): WebToolsConfig {
	const maxSearchCount = readInteger(env, "PI_WEB_SEARCH_MAX_COUNT", DEFAULT_WEB_TOOLS_CONFIG.maxSearchCount, 1, 20);
	const maxFetchMaxChars = readInteger(
		env,
		"PI_WEB_FETCH_MAX_CHARS",
		DEFAULT_WEB_TOOLS_CONFIG.maxFetchMaxChars,
		1000,
		100000,
	);

	return {
		braveApiKey: env.BRAVE_API_KEY?.trim() || env.BRAVE_SEARCH_API_KEY?.trim() || undefined,
		defaultCountry: (env.PI_WEB_SEARCH_COUNTRY?.trim() || DEFAULT_WEB_TOOLS_CONFIG.defaultCountry).toUpperCase(),
		defaultSearchCount: readInteger(
			env,
			"PI_WEB_SEARCH_DEFAULT_COUNT",
			DEFAULT_WEB_TOOLS_CONFIG.defaultSearchCount,
			1,
			maxSearchCount,
		),
		maxSearchCount,
		searchTimeoutMs: readInteger(
			env,
			"PI_WEB_SEARCH_TIMEOUT_MS",
			DEFAULT_WEB_TOOLS_CONFIG.searchTimeoutMs,
			1000,
			60000,
		),
		fetchTimeoutMs: readInteger(env, "PI_WEB_FETCH_TIMEOUT_MS", DEFAULT_WEB_TOOLS_CONFIG.fetchTimeoutMs, 1000, 60000),
		defaultFetchMaxChars: readInteger(
			env,
			"PI_WEB_FETCH_DEFAULT_MAX_CHARS",
			DEFAULT_WEB_TOOLS_CONFIG.defaultFetchMaxChars,
			1000,
			maxFetchMaxChars,
		),
		maxFetchMaxChars,
	};
}

export function normalizeCount(value: number | undefined, fallback: number, max: number): number {
	if (!Number.isFinite(value)) return fallback;
	return Math.max(1, Math.min(max, Math.floor(value ?? fallback)));
}

export function normalizeMaxChars(value: number | undefined, fallback: number, max: number): number {
	if (!Number.isFinite(value)) return fallback;
	return Math.max(1, Math.min(max, Math.floor(value ?? fallback)));
}
