import { fetchBraveSearchResults } from "./brave-client.ts";
import { getWebToolsConfig, normalizeCount } from "./config.ts";
import { WebToolsError } from "./errors.ts";
import type { WebSearchInput, WebSearchOptions, WebSearchResult } from "./types.ts";

function normalizeCountry(country: string | undefined, fallback: string): string {
	const normalized = (country?.trim() || fallback).toUpperCase();
	return /^[A-Z]{2}$/.test(normalized) ? normalized : fallback;
}

export async function webSearch(input: WebSearchInput, options: WebSearchOptions = {}): Promise<WebSearchResult> {
	const config = options.config ?? getWebToolsConfig();
	const query = input.query.trim();
	if (!query) {
		throw new WebToolsError("/web requires a non-empty query or URL.");
	}
	if (!config.braveApiKey) {
		throw new WebToolsError(
			"BRAVE_API_KEY is not configured. Set BRAVE_API_KEY or BRAVE_SEARCH_API_KEY in your shell environment.",
		);
	}

	const count = normalizeCount(input.count, config.defaultSearchCount, config.maxSearchCount);
	const country = normalizeCountry(input.country, config.defaultCountry);
	const freshness = input.freshness?.trim() || undefined;
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
