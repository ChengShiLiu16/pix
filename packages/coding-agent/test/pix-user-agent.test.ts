import { describe, expect, it } from "vitest";
import { getPixUserAgent } from "../src/utils/pix-user-agent.ts";

describe("getPixUserAgent", () => {
	it("formats the user agent expected by pi.dev", () => {
		const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
		const userAgent = getPixUserAgent("1.2.3");

		expect(userAgent).toBe(`pix/1.2.3 (${process.platform}; ${runtime}; ${process.arch})`);
		expect(userAgent).toMatch(/^pix\/[^\s()]+ \([^;()]+;\s*[^;()]+;\s*[^()]+\)$/);
	});
});
