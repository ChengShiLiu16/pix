import assert from "node:assert/strict";
import { webFetch } from "./fetch.ts";
import { isPrivateIpAddress, parseHttpUrl } from "./safety.ts";
import type { FetchLike, WebToolsConfig } from "./types.ts";

const config: WebToolsConfig = {
	braveApiKey: "test-key",
	defaultCountry: "US",
	defaultSearchCount: 5,
	maxSearchCount: 10,
	searchTimeoutMs: 1000,
	fetchTimeoutMs: 1000,
	defaultFetchMaxChars: 20,
	maxFetchMaxChars: 100,
};

function response(body: string, init?: ResponseInit): Response {
	return new Response(body, init);
}

async function testFetchPlainTextAndTruncates(): Promise<void> {
	const fetchFn: FetchLike = async () => response("abcdefghijklmnopqrstuvwxyz", {
		status: 200,
		headers: { "content-type": "text/plain" },
	});

	const result = await webFetch({ url: "https://93.184.216.34/file.txt" }, { config, fetchFn });
	assert.equal(result.content, "abcdefghijklmnopqrst");
	assert.equal(result.truncated, true);
}

async function testFetchFollowsRelativeRedirect(): Promise<void> {
	const urls: string[] = [];
	const fetchFn: FetchLike = async (input) => {
		urls.push(input.toString());
		if (urls.length === 1) {
			return response("", { status: 302, headers: { location: "/final.txt" } });
		}
		return response("done", { status: 200, headers: { "content-type": "text/plain" } });
	};

	const result = await webFetch({ url: "https://93.184.216.34/start" }, { config, fetchFn });
	assert.deepEqual(urls, ["https://93.184.216.34/start", "https://93.184.216.34/final.txt"]);
	assert.equal(result.finalUrl, "https://93.184.216.34/final.txt");
	assert.equal(result.content, "done");
}

async function testFetchHtmlAsMarkdown(): Promise<void> {
	const fetchFn: FetchLike = async () => response(`<!doctype html>
		<html>
			<head><title>Example Article</title></head>
			<body><article><h1>Example Article</h1><p>Hello <strong>web</strong>.</p></article></body>
		</html>`, {
		status: 200,
		headers: { "content-type": "text/html" },
	});

	const result = await webFetch({ url: "https://93.184.216.34/article", maxChars: 100 }, { config, fetchFn });
	assert.equal(result.title, "Example Article");
	assert.match(result.content, /Hello \*\*web\*\*\./);
}

async function testFetchHtmlFallbackContent(): Promise<void> {
	const fetchFn: FetchLike = async () => response(`<!doctype html>
		<html>
			<head><title>Fallback Page</title></head>
			<body><main><button>Fallback body content.</button></main></body>
		</html>`, {
		status: 200,
		headers: { "content-type": "text/html" },
	});

	const result = await webFetch({ url: "https://93.184.216.34/fallback", maxChars: 100 }, { config, fetchFn });
	assert.equal(result.title, "Fallback Page");
	assert.match(result.content, /Fallback body content\./);
}

function testSafetyBlocksLocalTargets(): void {
	assert.throws(() => parseHttpUrl("file:///tmp/a"), /http and https/);
	assert.equal(isPrivateIpAddress("127.0.0.1"), true);
	assert.equal(isPrivateIpAddress("10.0.0.1"), true);
	assert.equal(isPrivateIpAddress("8.8.8.8"), false);
}

const tests = [testFetchPlainTextAndTruncates, testFetchFollowsRelativeRedirect, testFetchHtmlAsMarkdown, testFetchHtmlFallbackContent, testSafetyBlocksLocalTargets];

for (const test of tests) {
	await test();
}

console.log(`web-tools fetch tests: ${tests.length} passed`);
