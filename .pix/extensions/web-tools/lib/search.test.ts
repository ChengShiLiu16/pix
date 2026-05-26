import assert from "node:assert/strict";
import { webSearch } from "./search.ts";
import type { FetchLike, WebToolsConfig } from "./types.ts";

const config: WebToolsConfig = {
	braveApiKey: "test-key",
	defaultCountry: "US",
	defaultSearchCount: 5,
	maxSearchCount: 10,
	searchTimeoutMs: 1000,
	fetchTimeoutMs: 1000,
	defaultFetchMaxChars: 8000,
	maxFetchMaxChars: 20000,
};

async function testSearchFormatsBraveResults(): Promise<void> {
	let requestedUrl = "";
	const fetchFn: FetchLike = async (input) => {
		requestedUrl = input.toString();
		return new Response(JSON.stringify({
			web: {
				results: [
					{ title: "Official docs", url: "https://example.com/docs", description: "Docs snippet", age: "2 days ago" },
				],
			},
		}), { status: 200, headers: { "content-type": "application/json" } });
	};

	const result = await webSearch({ query: " test query ", count: 20, country: "de", freshness: "pw" }, { config, fetchFn });
	assert.equal(result.query, "test query");
	assert.equal(result.count, 10);
	assert.equal(result.country, "DE");
	assert.equal(result.results[0]?.url, "https://example.com/docs");
	assert.match(requestedUrl, /q=test\+query/);
	assert.match(requestedUrl, /count=10/);
	assert.match(requestedUrl, /country=DE/);
	assert.match(requestedUrl, /freshness=pw/);
}

async function testSearchRequiresApiKey(): Promise<void> {
	await assert.rejects(
		() => webSearch({ query: "x" }, { config: { ...config, braveApiKey: undefined } }),
		/BRAVE_API_KEY/,
	);
}

async function testSearchRequiresQuery(): Promise<void> {
	await assert.rejects(
		() => webSearch({ query: "   " }, { config }),
		/non-empty query/,
	);
}

const tests = [testSearchFormatsBraveResults, testSearchRequiresApiKey, testSearchRequiresQuery];

for (const test of tests) {
	await test();
}

console.log(`web-tools search tests: ${tests.length} passed`);
