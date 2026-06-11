import { afterEach, describe, expect, it, vi } from "vitest";
import {
	checkForNewPixVersion,
	comparePackageVersions,
	getLatestPixRelease,
	getLatestPixVersion,
	isNewerPackageVersion,
} from "../src/utils/version-check.ts";

const originalSkipVersionCheck = process.env.PIX_SKIP_VERSION_CHECK;
const originalOffline = process.env.PIX_OFFLINE;

afterEach(() => {
	vi.unstubAllGlobals();
	if (originalSkipVersionCheck === undefined) {
		delete process.env.PIX_SKIP_VERSION_CHECK;
	} else {
		process.env.PIX_SKIP_VERSION_CHECK = originalSkipVersionCheck;
	}
	if (originalOffline === undefined) {
		delete process.env.PIX_OFFLINE;
	} else {
		process.env.PIX_OFFLINE = originalOffline;
	}
});

describe("version checks", () => {
	it("compares package versions", () => {
		expect(comparePackageVersions("0.70.6", "0.70.5")).toBeGreaterThan(0);
		expect(comparePackageVersions("0.70.5", "0.70.5")).toBe(0);
		expect(comparePackageVersions("0.70.4", "0.70.5")).toBeLessThan(0);
		expect(isNewerPackageVersion("0.70.5", "0.70.5")).toBe(false);
		expect(isNewerPackageVersion("0.70.6", "0.70.5")).toBe(true);
	});

	it("returns only newer versions", async () => {
		const fetchMock = vi.fn(async () => Response.json({ tag_name: "v1.2.3" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewPixVersion("1.2.3")).resolves.toBeUndefined();
		await expect(checkForNewPixVersion("1.2.2")).resolves.toEqual({
			packageName: "@chengshiliu16/pix-coding-agent",
			version: "1.2.3",
		});
	});

	it("uses the GitHub release API with a pix user agent", async () => {
		const fetchMock = vi.fn(async () => Response.json({ tag_name: "v1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPixVersion("1.2.3")).resolves.toBe("1.2.4");
		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.github.com/repos/ChengShiLiu16/pix/releases/latest",
			expect.objectContaining({
				headers: expect.objectContaining({
					"User-Agent": "pix-coding-agent",
					accept: "application/json",
				}),
			}),
		);
	});

	it("returns the active package metadata from the version check api", async () => {
		const fetchMock = vi.fn(async () => Response.json({ tag_name: "v1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPixRelease("1.2.3")).resolves.toEqual({
			packageName: "@chengshiliu16/pix-coding-agent",
			version: "1.2.4",
		});
	});

	it("returns update notes from the version check api", async () => {
		const fetchMock = vi.fn(async () => Response.json({ body: " **Read this** ", tag_name: "v1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPixRelease("1.2.3")).resolves.toEqual({
			note: "**Read this**",
			packageName: "@chengshiliu16/pix-coding-agent",
			version: "1.2.4",
		});
	});

	it("skips api calls when version checks are disabled", async () => {
		process.env.PIX_SKIP_VERSION_CHECK = "1";
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPixVersion("1.2.3")).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
