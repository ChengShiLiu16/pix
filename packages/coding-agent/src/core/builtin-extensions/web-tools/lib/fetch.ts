import { buildConnector, type Dispatcher, Pool, fetch as undiciFetch } from "undici";
import { getWebToolsConfig, normalizeMaxChars } from "./config.ts";
import { WebToolsError } from "./errors.ts";
import { createTimeoutSignal } from "./http.ts";
import { extractReadableContent, plainContent, truncateContent } from "./markdown.ts";
import { parseHttpUrl, resolvePublicHttpUrl } from "./safety.ts";
import type { FetchLike, WebFetchInput, WebFetchOptions, WebFetchResult } from "./types.ts";

type FetchResponse = {
	response: Response;
	finalUrl: string;
	cleanup?: () => Promise<void>;
};

type FetchWithPinningOptions = {
	fetchFn?: FetchLike;
	resolveHost?: WebFetchOptions["resolveHost"];
	dispatcherFactory?: WebFetchOptions["dispatcherFactory"];
};

type FetchPinnedResponse = {
	response: Response;
	cleanup?: () => Promise<void>;
};

const MAX_REDIRECTS = 5;
const STREAM_BYTE_LIMIT = 1024 * 1024; // 1MB — 防止撑爆内存

async function cancelResponseBody(response: Response): Promise<void> {
	try {
		await response.body?.cancel();
	} catch {
		/* ignore */
	}
}

/**
 * 流式读取响应体，最多读 STREAM_BYTE_LIMIT 字节后取消连接。
 * 不依赖 content-length header，真正防止内存耗尽。
 */
async function readBodyWithLimit(response: Response): Promise<{ text: string; truncated: boolean }> {
	// Quick check: content-length 明显超限，不等 stream 直接拒绝
	const contentLength = response.headers.get("content-length");
	if (contentLength && Number.parseInt(contentLength, 10) > STREAM_BYTE_LIMIT) {
		await cancelResponseBody(response);
		throw new WebToolsError(`Response too large (${contentLength} bytes, limit ${STREAM_BYTE_LIMIT})`);
	}

	const reader = response.body?.getReader();
	if (!reader) {
		// 不支持 stream 的环境（极少见），fallback 到 text()
		const text = await response.text();
		return { text, truncated: false };
	}

	const chunks: Uint8Array[] = [];
	let totalBytes = 0;

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;

		const remaining = STREAM_BYTE_LIMIT - totalBytes;
		if (value.length > remaining) {
			chunks.push(value.subarray(0, remaining));
			totalBytes += remaining;
			break;
		}

		chunks.push(value);
		totalBytes += value.length;
		if (totalBytes >= STREAM_BYTE_LIMIT) break;
	}

	const truncated = totalBytes >= STREAM_BYTE_LIMIT;
	if (truncated) {
		try {
			await reader.cancel();
		} catch {
			/* ignore */
		}
	}

	// 合并所有 chunk 为单一 buffer，一次性 decode
	const combined = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		combined.set(chunk, offset);
		offset += chunk.length;
	}

	const text = new TextDecoder().decode(combined);
	return { text, truncated };
}

function normalizeFormat(format: WebFetchInput["format"]): "markdown" | "text" {
	return format === "text" ? "text" : "markdown";
}

function isHtmlContent(contentType: string | undefined): boolean {
	return (
		!contentType ||
		contentType.toLowerCase().includes("text/html") ||
		contentType.toLowerCase().includes("application/xhtml+xml")
	);
}

function isTextualContent(contentType: string | undefined): boolean {
	if (!contentType) return true;
	const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
	if (!mediaType) return true;
	if (mediaType.startsWith("text/")) return true;
	if (mediaType.endsWith("+json") || mediaType.endsWith("+xml")) return true;
	return (
		mediaType === "application/json" ||
		mediaType === "application/javascript" ||
		mediaType === "application/ecmascript" ||
		mediaType === "application/xml" ||
		mediaType === "application/xhtml+xml" ||
		mediaType === "image/svg+xml"
	);
}

function createPinnedDispatcher(url: URL, addresses: string[]): Dispatcher {
	let nextAddress = 0;
	const connector = buildConnector({
		allowH2: false,
		servername: url.hostname,
	});
	return new Pool(url.origin, {
		connections: 1,
		connect(connectOptions, callback) {
			const address = addresses[nextAddress % addresses.length];
			nextAddress++;
			connector({ ...connectOptions, hostname: address, servername: url.hostname }, callback);
		},
	});
}

async function fetchPinnedUrl(
	url: URL,
	addresses: string[],
	signal: AbortSignal,
	options: FetchWithPinningOptions,
): Promise<FetchPinnedResponse> {
	const headers = {
		"User-Agent": "Pix-Web-Tools/0.1 (+https://github.com/ChengShiLiu16/pix)",
		Accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.8",
	};
	if (options.fetchFn) {
		return {
			response: await options.fetchFn(url, {
				redirect: "manual",
				headers,
				signal,
			}),
		};
	}
	const dispatcher = options.dispatcherFactory?.(url, addresses) ?? createPinnedDispatcher(url, addresses);
	try {
		const response = (await undiciFetch(url, {
			redirect: "manual",
			headers,
			signal,
			dispatcher,
		})) as unknown as Response;
		return {
			response,
			cleanup: () => dispatcher.close(),
		};
	} catch (error) {
		await dispatcher.close();
		throw error;
	}
}

async function fetchWithRedirects(
	url: URL,
	signal: AbortSignal,
	options: FetchWithPinningOptions,
): Promise<FetchResponse> {
	let current = url;
	for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
		const publicUrl = await resolvePublicHttpUrl(current.toString(), options.resolveHost);
		const { response, cleanup } = await fetchPinnedUrl(publicUrl.url, publicUrl.addresses, signal, options);

		const location = response.headers.get("location");
		if (response.status >= 300 && response.status < 400 && location) {
			await cancelResponseBody(response);
			await cleanup?.();
			current = new URL(location, current);
			continue;
		}

		return { response, finalUrl: current.toString(), cleanup };
	}

	throw new WebToolsError(`Too many redirects while fetching ${url.toString()}`);
}

export async function webFetch(input: WebFetchInput, options: WebFetchOptions = {}): Promise<WebFetchResult> {
	const config = options.config ?? getWebToolsConfig();
	const initialUrl = parseHttpUrl(input.url.trim());
	const maxChars = normalizeMaxChars(input.maxChars, config.defaultFetchMaxChars, config.maxFetchMaxChars);
	const format = normalizeFormat(input.format);
	const timeout = createTimeoutSignal(options.signal, config.fetchTimeoutMs);
	let cleanup: (() => Promise<void>) | undefined;

	try {
		const fetched = await fetchWithRedirects(initialUrl, timeout.signal, {
			fetchFn: options.fetchFn,
			resolveHost: options.resolveHost,
			dispatcherFactory: options.dispatcherFactory,
		});
		const { response, finalUrl } = fetched;
		cleanup = fetched.cleanup;
		if (!response.ok) {
			await cancelResponseBody(response);
			throw new WebToolsError(`/web failed to fetch page: HTTP ${response.status} ${response.statusText}`);
		}

		const contentType = response.headers.get("content-type") ?? undefined;
		if (!isTextualContent(contentType)) {
			await cancelResponseBody(response);
			throw new WebToolsError(`/web only supports textual responses, got ${contentType}.`);
		}
		const { text: raw, truncated: bodyTruncated } = await readBodyWithLimit(response);
		if (!isHtmlContent(contentType)) {
			const plain = plainContent(raw, maxChars);
			return {
				url: initialUrl.toString(),
				finalUrl,
				contentType,
				content: plain.content,
				truncated: plain.truncated || bodyTruncated,
			};
		}

		const extracted = await extractReadableContent(raw, finalUrl, format);
		const truncated = truncateContent(extracted.content, maxChars);
		return {
			url: initialUrl.toString(),
			finalUrl,
			title: extracted.title,
			contentType,
			content: truncated.content,
			truncated: truncated.truncated || bodyTruncated,
		};
	} finally {
		await cleanup?.();
		timeout.cleanup();
	}
}
