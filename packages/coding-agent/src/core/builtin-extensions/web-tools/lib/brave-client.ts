import { WebToolsError } from "./errors.ts";
import { createTimeoutSignal, defaultFetch } from "./http.ts";
import { normalizePotentiallyPublicHttpUrl } from "./safety.ts";
import type { FetchLike, WebSearchResultItem } from "./types.ts";

type BraveSearchRequest = {
	apiKey: string;
	query: string;
	count: number;
	country: string;
	freshness?: string;
	timeoutMs: number;
	fetchFn?: FetchLike;
	signal?: AbortSignal;
};

const ERROR_BODY_MAX_CHARS = 2000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function braveResultFromUnknown(value: unknown, rank: number): WebSearchResultItem | undefined {
	if (!isRecord(value)) return undefined;
	const title = stringValue(value.title) ?? "Untitled";
	const url = stringValue(value.url);
	if (!url) return undefined;
	const safeUrl = normalizePotentiallyPublicHttpUrl(url);
	if (!safeUrl) return undefined;
	return {
		rank,
		title,
		url: safeUrl,
		snippet: stringValue(value.description) ?? "",
		age: stringValue(value.age) ?? stringValue(value.page_age),
	};
}

function truncateErrorText(text: string): string {
	if (text.length <= ERROR_BODY_MAX_CHARS) return text;
	return `${text.slice(0, ERROR_BODY_MAX_CHARS)}\n[... ${text.length - ERROR_BODY_MAX_CHARS} more characters truncated]`;
}

export async function fetchBraveSearchResults(request: BraveSearchRequest): Promise<WebSearchResultItem[]> {
	const params = new URLSearchParams({
		q: request.query,
		count: request.count.toString(),
		country: request.country,
	});
	if (request.freshness) params.set("freshness", request.freshness);

	const timeout = createTimeoutSignal(request.signal, request.timeoutMs);
	try {
		const response = await (request.fetchFn ?? defaultFetch())(
			`https://api.search.brave.com/res/v1/web/search?${params}`,
			{
				headers: {
					Accept: "application/json",
					"Accept-Encoding": "gzip",
					"X-Subscription-Token": request.apiKey,
				},
				signal: timeout.signal,
			},
		);

		if (!response.ok) {
			const errorText = truncateErrorText(await response.text());
			throw new WebToolsError(
				`Brave Search request failed: HTTP ${response.status} ${response.statusText}${errorText ? `\n${errorText}` : ""}`,
			);
		}

		const data: unknown = await response.json();
		const web = isRecord(data) && isRecord(data.web) ? data.web : undefined;
		const rawResults = Array.isArray(web?.results) ? web.results : [];
		const results: WebSearchResultItem[] = [];
		for (const item of rawResults) {
			const result = braveResultFromUnknown(item, results.length + 1);
			if (!result) continue;
			results.push(result);
			if (results.length >= request.count) break;
		}
		return results;
	} finally {
		timeout.cleanup();
	}
}
