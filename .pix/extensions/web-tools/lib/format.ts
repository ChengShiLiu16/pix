import type { WebFetchResult, WebSearchResult } from "./types.ts";

export function formatSearchResult(result: WebSearchResult): string {
	if (result.results.length === 0) {
		return `No web search results found for: ${result.query}`;
	}

	const header = [
		`Query: ${result.query}`,
		`Country: ${result.country}`,
		result.freshness ? `Freshness: ${result.freshness}` : undefined,
	].filter((line): line is string => line !== undefined);

	const items = result.results.map((item) => [
		`--- Result ${item.rank} ---`,
		`Title: ${item.title}`,
		`Link: ${item.url}`,
		item.age ? `Age: ${item.age}` : undefined,
		`Snippet: ${item.snippet}`,
	].filter((line): line is string => line !== undefined).join("\n"));

	return [...header, "", ...items].join("\n");
}

export function formatFetchResult(result: WebFetchResult): string {
	return [
		result.title ? `# ${result.title}` : undefined,
		`URL: ${result.url}`,
		result.finalUrl !== result.url ? `Final URL: ${result.finalUrl}` : undefined,
		result.contentType ? `Content-Type: ${result.contentType}` : undefined,
		result.truncated ? "Truncated: true" : undefined,
		"",
		result.content,
	].filter((line): line is string => line !== undefined).join("\n");
}
