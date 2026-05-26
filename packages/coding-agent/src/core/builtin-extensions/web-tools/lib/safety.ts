import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { WebToolsError } from "./errors.ts";

function stripIpv6Brackets(host: string): string {
	return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function isPrivateIpv4(ip: string): boolean {
	const parts = ip.split(".").map((part) => Number.parseInt(part, 10));
	if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
	const [a, b] = parts;
	return (
		a === 10 ||
		a === 127 ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		a === 0 ||
		a >= 224
	);
}

function isPrivateIpv6(ip: string): boolean {
	const normalized = ip.toLowerCase();
	return (
		normalized === "::1" ||
		normalized === "::" ||
		normalized.startsWith("fc") ||
		normalized.startsWith("fd") ||
		normalized.startsWith("fe80:")
	);
}

export function isPrivateIpAddress(ip: string): boolean {
	const normalized = stripIpv6Brackets(ip);
	const version = isIP(normalized);
	if (version === 4) return isPrivateIpv4(normalized);
	if (version === 6) return isPrivateIpv6(normalized);
	return true;
}

export function parseHttpUrl(rawUrl: string): URL {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new WebToolsError(`Invalid URL: ${rawUrl}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new WebToolsError("/web only supports http and https URLs.");
	}
	if (!url.hostname) {
		throw new WebToolsError("/web requires a URL with a hostname.");
	}
	return url;
}

function isBlockedHostname(hostname: string): boolean {
	const host = stripIpv6Brackets(hostname).toLowerCase();
	return host === "localhost" || host.endsWith(".localhost");
}

export async function assertPublicHttpUrl(rawUrl: string): Promise<URL> {
	const url = parseHttpUrl(rawUrl);
	const host = stripIpv6Brackets(url.hostname);
	if (isBlockedHostname(host)) {
		throw new WebToolsError(`Blocked local URL: ${rawUrl}`);
	}
	if (isIP(host) && isPrivateIpAddress(host)) {
		throw new WebToolsError(`Blocked private network URL: ${rawUrl}`);
	}
	if (!isIP(host)) {
		const addresses = await lookup(host, { all: true, verbatim: true });
		if (addresses.some((entry) => isPrivateIpAddress(entry.address))) {
			throw new WebToolsError(`Blocked private network host: ${host}`);
		}
		// TODO: TOCTOU window — DNS validated above, but fetch() in fetch.ts will
		// re-resolve DNS, leaving a race window for DNS rebinding attacks.
		// To fix: resolve IPs here and pass a custom fetch wrapper that pins
		// the connection to the validated IPs.
	}
	return url;
}
