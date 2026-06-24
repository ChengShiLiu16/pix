import { compare, valid } from "semver";
import { getPixUserAgent } from "./pix-user-agent.ts";

const LATEST_VERSION_URL = "https://pi.dev/api/latest-version";
const DEFAULT_VERSION_CHECK_TIMEOUT_MS = 10000;

export interface LatestPixRelease {
	version: string;
	packageName?: string;
	note?: string;
}

export function comparePackageVersions(leftVersion: string, rightVersion: string): number | undefined {
	const left = valid(leftVersion.trim());
	const right = valid(rightVersion.trim());
	if (!left || !right) {
		return undefined;
	}
	return compare(left, right);
}

export function isNewerPackageVersion(candidateVersion: string, currentVersion: string): boolean {
	const comparison = comparePackageVersions(candidateVersion, currentVersion);
	if (comparison !== undefined) {
		return comparison > 0;
	}
	return candidateVersion.trim() !== currentVersion.trim();
}

export async function getLatestPixRelease(
	currentVersion: string,
	options: { timeoutMs?: number } = {},
): Promise<LatestPixRelease | undefined> {
	if (
		process.env.PIX_SKIP_VERSION_CHECK ||
		process.env.PI_SKIP_VERSION_CHECK ||
		process.env.PIX_OFFLINE ||
		process.env.PI_OFFLINE
	) {
		return undefined;
	}

	const response = await fetch(LATEST_VERSION_URL, {
		headers: {
			"User-Agent": getPixUserAgent(currentVersion),
			accept: "application/json",
		},
		signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_VERSION_CHECK_TIMEOUT_MS),
	});
	if (!response.ok) return undefined;

	const data = (await response.json()) as {
		packageName?: unknown;
		version?: unknown;
		note?: unknown;
	};
	if (typeof data.version !== "string" || !data.version.trim()) {
		return undefined;
	}
	const packageName =
		typeof data.packageName === "string" && data.packageName.trim() ? data.packageName.trim() : undefined;
	const note = typeof data.note === "string" && data.note.trim() ? data.note.trim() : undefined;
	return {
		version: data.version.trim(),
		packageName,
		...(note ? { note } : {}),
	};
}

export async function getLatestPixVersion(
	currentVersion: string,
	options: { timeoutMs?: number } = {},
): Promise<string | undefined> {
	return (await getLatestPixRelease(currentVersion, options))?.version;
}

export async function checkForNewPixVersion(currentVersion: string): Promise<LatestPixRelease | undefined> {
	try {
		const latestRelease = await getLatestPixRelease(currentVersion);
		if (latestRelease && isNewerPackageVersion(latestRelease.version, currentVersion)) {
			return latestRelease;
		}
		return undefined;
	} catch {
		return undefined;
	}
}
