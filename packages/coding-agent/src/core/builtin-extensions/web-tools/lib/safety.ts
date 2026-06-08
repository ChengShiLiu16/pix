import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { WebToolsError } from "./errors.ts";

export type PublicHttpUrl = {
	url: URL;
	addresses: string[];
};

export type ResolveHost = (hostname: string) => Promise<string[]>;

function stripIpv6Brackets(host: string): string {
	return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

type Ipv4Parts = [number, number, number, number];

function parseIpv4(ip: string): Ipv4Parts | undefined {
	const parts = ip.split(".");
	if (parts.length !== 4) return undefined;
	const numbers = parts.map((part) => (/^\d+$/.test(part) ? Number.parseInt(part, 10) : Number.NaN));
	if (numbers.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return undefined;
	return numbers as Ipv4Parts;
}

function isPrivateIpv4Parts(parts: Ipv4Parts): boolean {
	const [a, b] = parts;
	return (
		a === 10 ||
		a === 127 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 0) ||
		(a === 192 && b === 88 && parts[2] === 99) ||
		(a === 192 && b === 168) ||
		(a === 198 && (b === 18 || b === 19)) ||
		(a === 198 && b === 51 && parts[2] === 100) ||
		(a === 203 && b === 0 && parts[2] === 113) ||
		a === 0 ||
		a >= 224
	);
}

function isPrivateIpv4(ip: string): boolean {
	const parts = parseIpv4(ip);
	return parts ? isPrivateIpv4Parts(parts) : true;
}

function isBenchmarkIpv4(ip: string): boolean {
	const parts = parseIpv4(ip);
	return parts ? parts[0] === 198 && (parts[1] === 18 || parts[1] === 19) : false;
}

function parseIpv6Hextets(ip: string): number[] | undefined {
	const lower = ip.toLowerCase();
	if (lower.includes("%")) return undefined;

	const ipv4Suffix = lower.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1];
	const ipv4Parts = ipv4Suffix ? parseIpv4(ipv4Suffix) : undefined;
	if (ipv4Suffix && !ipv4Parts) return undefined;
	const value =
		ipv4Suffix && lower.endsWith(`:${ipv4Suffix}`) && !lower.endsWith(`::${ipv4Suffix}`)
			? lower.slice(0, -ipv4Suffix.length - 1)
			: ipv4Suffix
				? lower.slice(0, -ipv4Suffix.length)
				: lower;

	function parseGroup(group: string): number[] | undefined {
		if (!group) return [];
		const parts = group.split(":");
		if (parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return undefined;
		return parts.map((part) => Number.parseInt(part, 16));
	}

	const ipv4Hextets = ipv4Parts ? [(ipv4Parts[0] << 8) | ipv4Parts[1], (ipv4Parts[2] << 8) | ipv4Parts[3]] : [];
	if (value.includes("::")) {
		const compressed = value.split("::");
		if (compressed.length !== 2) return undefined;
		const head = parseGroup(compressed[0] ?? "");
		const tail = parseGroup(compressed[1] ?? "");
		if (!head || !tail) return undefined;
		const missing = 8 - head.length - tail.length - ipv4Hextets.length;
		if (missing < 1) return undefined;
		return [...head, ...Array.from({ length: missing }, () => 0), ...tail, ...ipv4Hextets];
	}

	const hextets = parseGroup(value);
	if (!hextets) return undefined;
	const result = [...hextets, ...ipv4Hextets];
	return result.length === 8 ? result : undefined;
}

function mappedIpv4Parts(hextets: number[]): Ipv4Parts | undefined {
	if (
		hextets.length === 8 &&
		hextets[0] === 0 &&
		hextets[1] === 0 &&
		hextets[2] === 0 &&
		hextets[3] === 0 &&
		hextets[4] === 0 &&
		hextets[5] === 0xffff
	) {
		const high = hextets[6] ?? 0;
		const low = hextets[7] ?? 0;
		return [high >> 8, high & 0xff, low >> 8, low & 0xff];
	}
	return undefined;
}

function isPrivateIpv6(ip: string): boolean {
	const hextets = parseIpv6Hextets(ip);
	if (!hextets) return true;
	const mappedIpv4 = mappedIpv4Parts(hextets);
	if (mappedIpv4) return true;
	const [first = 0, second = 0, third = 0, fourth = 0] = hextets;
	return (
		first === 0 ||
		(first === 0x0064 && second === 0xff9b) ||
		(first === 0x0100 && second === 0 && third === 0 && (fourth === 0 || fourth === 1)) ||
		(first === 0x2001 && second <= 0x01ff) ||
		(first === 0x2001 && second === 0x0db8) ||
		first === 0x2002 ||
		first === 0x3ffe ||
		(first === 0x3fff && second <= 0x0fff) ||
		(first & 0xfe00) === 0xfc00 ||
		(first & 0xffc0) === 0xfe80 ||
		(first & 0xff00) === 0xff00
	);
}

export function isPrivateIpAddress(ip: string): boolean {
	// /web 只允许公网地址；特殊用途地址也按私网处理。
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
	if (url.username || url.password) {
		throw new WebToolsError("/web does not support URLs containing credentials.");
	}
	return url;
}

function isBlockedHostname(hostname: string): boolean {
	const host = stripIpv6Brackets(hostname).toLowerCase();
	return host === "localhost" || host.endsWith(".localhost");
}

export function normalizePotentiallyPublicHttpUrl(rawUrl: string): string | undefined {
	let url: URL;
	try {
		url = parseHttpUrl(rawUrl);
	} catch {
		return undefined;
	}
	const host = stripIpv6Brackets(url.hostname);
	if (isBlockedHostname(host)) return undefined;
	if (isIP(host) && isPrivateIpAddress(host)) return undefined;
	return url.toString();
}

async function defaultResolveHost(hostname: string): Promise<string[]> {
	const addresses = await lookup(hostname, { all: true, verbatim: true });
	return addresses.map((entry) => entry.address);
}

function assertPublicAddresses(host: string, addresses: string[]): string[] {
	if (addresses.length === 0) {
		throw new WebToolsError(`No DNS addresses found for host: ${host}`);
	}
	// 一些本地/CI 出口代理会把公网域名解析到 198.18.0.0/15。
	// 字面量 URL 仍会在 resolvePublicHttpUrl() 的 IP 分支被拒绝。
	if (addresses.some((address) => isPrivateIpAddress(address) && !isBenchmarkIpv4(address))) {
		throw new WebToolsError(`Blocked private network host: ${host}`);
	}
	return addresses;
}

export async function resolvePublicHttpUrl(
	rawUrl: string,
	resolveHost: ResolveHost = defaultResolveHost,
): Promise<PublicHttpUrl> {
	const url = parseHttpUrl(rawUrl);
	const host = stripIpv6Brackets(url.hostname);
	if (isBlockedHostname(host)) {
		throw new WebToolsError(`Blocked local URL: ${rawUrl}`);
	}
	if (isIP(host)) {
		if (isPrivateIpAddress(host)) {
			throw new WebToolsError(`Blocked private network URL: ${rawUrl}`);
		}
		return { url, addresses: [host] };
	}
	const addresses = await resolveHost(host);
	return { url, addresses: assertPublicAddresses(host, addresses) };
}

export async function assertPublicHttpUrl(rawUrl: string): Promise<URL> {
	return (await resolvePublicHttpUrl(rawUrl)).url;
}
