import { fetchBraveSearchResults } from "./brave-client.ts";
import { getWebToolsConfig, normalizeCount } from "./config.ts";
import { WebToolsError } from "./errors.ts";
import type { WebSearchInput, WebSearchOptions, WebSearchResult } from "./types.ts";

const MAX_QUERY_CHARS = 1024;
const RELATIVE_FRESHNESS_VALUES = new Set(["pd", "pw", "pm", "py"]);

function normalizeCountry(country: string | undefined, fallback: string): string {
	const normalized = (country?.trim() || fallback).toUpperCase();
	return /^[A-Z]{2}$/.test(normalized) ? normalized : fallback;
}

function normalizeFreshness(freshness: string | undefined): string | undefined {
	const normalized = freshness?.trim();
	if (!normalized) return undefined;
	if (RELATIVE_FRESHNESS_VALUES.has(normalized)) return normalized;
	if (/^\d{4}-\d{2}-\d{2}(to\d{4}-\d{2}-\d{2})?$/.test(normalized)) return normalized;
	throw new WebToolsError("/web freshness must be one of pd, pw, pm, py, YYYY-MM-DD, or YYYY-MM-DDtoYYYY-MM-DD.");
}

export async function webSearch(input: WebSearchInput, options: WebSearchOptions = {}): Promise<WebSearchResult> {
	const config = options.config ?? getWebToolsConfig();
	const query = input.query.trim();
	if (!query) {
		throw new WebToolsError("/web requires a non-empty query or URL.");
	}
	if (query.length > MAX_QUERY_CHARS) {
		throw new WebToolsError(`/web query is too long (${query.length} chars, limit ${MAX_QUERY_CHARS}).`);
	}
	if (!config.braveApiKey) {
		throw new WebToolsError(
			"BRAVE_API_KEY is not configured. Set BRAVE_API_KEY or BRAVE_SEARCH_API_KEY in your shell environment.",
		);
	}

	const count = normalizeCount(input.count, config.defaultSearchCount, config.maxSearchCount);
	const country = normalizeCountry(input.country, config.defaultCountry);
	const freshness = normalizeFreshness(input.freshness);
	const results = await fetchBraveSearchResults({
		apiKey: config.braveApiKey,
		query,
		count,
		country,
		freshness,
		timeoutMs: config.searchTimeoutMs,
		fetchFn: options.fetchFn,
		signal: options.signal,
	});

	return { query, count, country, freshness, results };
}
