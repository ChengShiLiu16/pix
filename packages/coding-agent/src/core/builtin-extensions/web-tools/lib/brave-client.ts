import { WebToolsError } from "./errors.ts";
import { createTimeoutSignal, defaultFetch } from "./http.ts";
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
	return {
		rank,
		title,
		url,
		snippet: stringValue(value.description) ?? "",
		age: stringValue(value.age) ?? stringValue(value.page_age),
	};
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
			const errorText = await response.text();
			throw new WebToolsError(
				`Brave Search request failed: HTTP ${response.status} ${response.statusText}${errorText ? `\n${errorText}` : ""}`,
			);
		}

		const data: unknown = await response.json();
		const web = isRecord(data) && isRecord(data.web) ? data.web : undefined;
		const rawResults = Array.isArray(web?.results) ? web.results : [];
		return rawResults
			.map((item, index) => braveResultFromUnknown(item, index + 1))
			.filter((item): item is WebSearchResultItem => item !== undefined)
			.slice(0, request.count);
	} finally {
		timeout.cleanup();
	}
}
