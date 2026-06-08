import type { Dispatcher } from "undici";
import { describe, expect, it } from "vitest";
import { DEFAULT_WEB_TOOLS_CONFIG } from "../src/core/builtin-extensions/web-tools/lib/config.ts";
import { WebToolsError } from "../src/core/builtin-extensions/web-tools/lib/errors.ts";
import { webFetch } from "../src/core/builtin-extensions/web-tools/lib/fetch.ts";
import { formatFetchResult } from "../src/core/builtin-extensions/web-tools/lib/format.ts";
import { isPrivateIpAddress, resolvePublicHttpUrl } from "../src/core/builtin-extensions/web-tools/lib/safety.ts";

const TEST_CONFIG = {
	...DEFAULT_WEB_TOOLS_CONFIG,
	fetchTimeoutMs: 1000,
	defaultFetchMaxChars: 2000,
	maxFetchMaxChars: 2000,
};

const cleanupCalls: string[] = [];

function createFailingDispatcher(): Dispatcher {
	return {
		dispatch(_options, handler) {
			handler.onResponseError?.(
				{
					get aborted() {
						return false;
					},
					get paused() {
						return false;
					},
					get reason() {
						return null;
					},
					abort() {},
					pause() {},
					resume() {},
				},
				new Error("pinned dispatcher used"),
			);
			return true;
		},
		async close() {
			cleanupCalls.push("close");
		},
	} as Dispatcher;
}

describe("IP address safety", () => {
	it.each([
		"10.0.0.1",
		"100.64.0.1",
		"127.0.0.1",
		"169.254.169.254",
		"172.16.0.1",
		"192.0.2.1",
		"192.168.0.1",
		"198.18.0.1",
		"198.51.100.1",
		"203.0.113.1",
		"::",
		"::1",
		"::ffff:127.0.0.1",
		"::ffff:8.8.8.8",
		"64:ff9b::808:808",
		"100::",
		"2001::1",
		"2001:db8::1",
		"2002::1",
		"3ffe::1",
		"3fff::1",
		"fc00::1",
		"fe90::1",
		"ff02::1",
	])("blocks non-public or special-use address %s", (address) => {
		expect(isPrivateIpAddress(address)).toBe(true);
	});

	it.each(["8.8.8.8", "93.184.216.34", "2606:4700:4700::1111", "2001:4860:4860::8888"])(
		"allows public address %s",
		(address) => {
			expect(isPrivateIpAddress(address)).toBe(false);
		},
	);
});

describe("resolvePublicHttpUrl", () => {
	it("rejects hostnames resolving to private addresses", async () => {
		await expect(resolvePublicHttpUrl("https://example.test/", async () => ["127.0.0.1"])).rejects.toThrow(
			WebToolsError,
		);
	});

	it("rejects direct special-use IP URLs", async () => {
		await expect(resolvePublicHttpUrl("http://100.64.0.1/")).rejects.toThrow(WebToolsError);
		await expect(resolvePublicHttpUrl("http://[::ffff:127.0.0.1]/")).rejects.toThrow(WebToolsError);
	});

	it("rejects URLs containing credentials", async () => {
		await expect(resolvePublicHttpUrl("https://user:pass@example.test/")).rejects.toThrow(WebToolsError);
	});

	it("returns validated addresses for public hostnames", async () => {
		await expect(
			resolvePublicHttpUrl("https://example.test/path", async () => ["93.184.216.34"]),
		).resolves.toMatchObject({
			addresses: ["93.184.216.34"],
		});
	});

	it("allows DNS-resolved benchmark addresses used by local egress proxies", async () => {
		await expect(
			resolvePublicHttpUrl("https://example.test/path", async () => ["198.18.8.140"]),
		).resolves.toMatchObject({
			addresses: ["198.18.8.140"],
		});
	});

	it("rejects clearly non-text responses", async () => {
		await expect(
			webFetch(
				{ url: "https://example.test/image.png", format: "text" },
				{
					config: TEST_CONFIG,
					resolveHost: async () => ["93.184.216.34"],
					fetchFn: async () => new Response("png bytes", { headers: { "content-type": "image/png" } }),
				},
			),
		).rejects.toThrow(WebToolsError);
	});

	it("marks formatted fetch results as untrusted web data", () => {
		const formatted = formatFetchResult({
			url: "https://example.com/",
			finalUrl: "https://example.com/",
			content: "page text",
			truncated: false,
		});

		expect(formatted).toContain("Untrusted web page content");
	});
});

describe("webFetch DNS pinning", () => {
	it("uses the validated addresses with the default undici path", async () => {
		const seen: Array<{ host: string; addresses: string[] }> = [];
		cleanupCalls.length = 0;

		await expect(
			webFetch(
				{ url: "https://example.test/path", format: "text" },
				{
					config: TEST_CONFIG,
					resolveHost: async () => ["93.184.216.34"],
					dispatcherFactory: (url, addresses) => {
						seen.push({ host: url.hostname, addresses });
						return createFailingDispatcher();
					},
				},
			),
		).rejects.toThrow();

		expect(seen).toEqual([{ host: "example.test", addresses: ["93.184.216.34"] }]);
		expect(cleanupCalls).toEqual(["close"]);
	});

	it("keeps injected fetchFn on the test seam without dispatcher pinning", async () => {
		const result = await webFetch(
			{ url: "https://example.test/path", format: "text" },
			{
				config: TEST_CONFIG,
				resolveHost: async () => ["93.184.216.34"],
				fetchFn: async () => new Response("stub body", { headers: { "content-type": "text/plain" } }),
			},
		);

		expect(result).toMatchObject({
			finalUrl: "https://example.test/path",
			content: "stub body",
			truncated: false,
		});
	});

	it("revalidates redirect targets and blocks private-network redirects", async () => {
		await expect(
			webFetch(
				{ url: "https://example.test/", format: "text" },
				{
					config: TEST_CONFIG,
					resolveHost: async (hostname) => (hostname === "internal.test" ? ["10.0.0.1"] : ["93.184.216.34"]),
					fetchFn: async (url) => {
						if (new URL(url).hostname === "example.test") {
							return new Response("", { status: 302, headers: { location: "http://internal.test/" } });
						}
						return new Response("blocked");
					},
				},
			),
		).rejects.toThrow(WebToolsError);
	});
});
