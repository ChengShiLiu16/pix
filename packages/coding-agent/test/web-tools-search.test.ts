import { describe, expect, it } from "vitest";
import { DEFAULT_WEB_TOOLS_CONFIG } from "../src/core/builtin-extensions/web-tools/lib/config.ts";
import { WebToolsError } from "../src/core/builtin-extensions/web-tools/lib/errors.ts";
import { formatSearchResult } from "../src/core/builtin-extensions/web-tools/lib/format.ts";
import { webSearch } from "../src/core/builtin-extensions/web-tools/lib/search.ts";

const TEST_CONFIG = {
	...DEFAULT_WEB_TOOLS_CONFIG,
	braveApiKey: "test-key",
	defaultSearchCount: 5,
	maxSearchCount: 10,
	searchTimeoutMs: 1000,
};

function braveResponse(results: unknown[]): Response {
	return new Response(JSON.stringify({ web: { results } }), {
		headers: { "content-type": "application/json" },
	});
}

describe("webSearch safety", () => {
	it("filters search result URLs that cannot safely be fetched", async () => {
		const result = await webSearch(
			{ query: "pix cli", count: 10, freshness: "pd" },
			{
				config: TEST_CONFIG,
				fetchFn: async () =>
					braveResponse([
						{ title: "FTP", url: "ftp://example.com/file", description: "ignored" },
						{ title: "Localhost", url: "http://localhost/admin", description: "ignored" },
						{ title: "Private IP", url: "http://127.0.0.1/", description: "ignored" },
						{ title: "Credentials", url: "https://user:pass@example.com/", description: "ignored" },
						{ title: "Needs normalization", url: "https://example.com/path with space", description: "kept" },
						{ title: "Public", url: "https://example.com/", description: "kept" },
					]),
			},
		);

		expect(result.results).toEqual([
			{
				rank: 1,
				title: "Needs normalization",
				url: "https://example.com/path%20with%20space",
				snippet: "kept",
				age: undefined,
			},
			{
				rank: 2,
				title: "Public",
				url: "https://example.com/",
				snippet: "kept",
				age: undefined,
			},
		]);
	});

	it("rejects unsupported freshness values before calling Brave", async () => {
		let called = false;

		await expect(
			webSearch(
				{ query: "pix cli", freshness: "javascript:alert(1)" },
				{
					config: TEST_CONFIG,
					fetchFn: async () => {
						called = true;
						return braveResponse([]);
					},
				},
			),
		).rejects.toThrow(WebToolsError);
		expect(called).toBe(false);
	});

	it("allows relative and ISO-date freshness values", async () => {
		const seen: string[] = [];

		for (const freshness of ["pd", "2026-06-08", "2026-06-01to2026-06-08"]) {
			await webSearch(
				{ query: "pix cli", freshness },
				{
					config: TEST_CONFIG,
					fetchFn: async (input) => {
						seen.push(new URL(String(input)).searchParams.get("freshness") ?? "");
						return braveResponse([]);
					},
				},
			);
		}

		expect(seen).toEqual(["pd", "2026-06-08", "2026-06-01to2026-06-08"]);
	});

	it("rejects oversized queries before calling Brave", async () => {
		let called = false;

		await expect(
			webSearch(
				{ query: "x".repeat(1025) },
				{
					config: TEST_CONFIG,
					fetchFn: async () => {
						called = true;
						return braveResponse([]);
					},
				},
			),
		).rejects.toThrow(WebToolsError);
		expect(called).toBe(false);
	});

	it("truncates Brave error response bodies", async () => {
		await expect(
			webSearch(
				{ query: "pix cli" },
				{
					config: TEST_CONFIG,
					fetchFn: async () => new Response("x".repeat(2500), { status: 500, statusText: "Server Error" }),
				},
			),
		).rejects.toThrow("[... 500 more characters truncated]");
	});

	it("marks formatted search results as untrusted web data", () => {
		const formatted = formatSearchResult({
			query: "pix cli",
			count: 1,
			country: "US",
			results: [{ rank: 1, title: "Title", url: "https://example.com/", snippet: "Snippet" }],
		});

		expect(formatted).toContain("Untrusted web search results");
	});
});
