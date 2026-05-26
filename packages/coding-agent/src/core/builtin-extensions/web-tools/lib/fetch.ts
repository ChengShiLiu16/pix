import { getWebToolsConfig, normalizeMaxChars } from "./config.ts";
import { WebToolsError } from "./errors.ts";
import { createTimeoutSignal, defaultFetch } from "./http.ts";
import { extractReadableContent, plainContent, truncateContent } from "./markdown.ts";
import { assertPublicHttpUrl } from "./safety.ts";
import type { FetchLike, WebFetchInput, WebFetchOptions, WebFetchResult } from "./types.ts";

type FetchResponse = {
	response: Response;
	finalUrl: string;
};

const MAX_REDIRECTS = 5;
const STREAM_BYTE_LIMIT = 1024 * 1024; // 1MB — 防止撑爆内存

/**
 * 流式读取响应体，最多读 STREAM_BYTE_LIMIT 字节后取消连接。
 * 不依赖 content-length header，真正防止内存耗尽。
 */
async function readBodyWithLimit(response: Response): Promise<{ text: string; truncated: boolean }> {
	// Quick check: content-length 明显超限，不等 stream 直接拒绝
	const contentLength = response.headers.get("content-length");
	if (contentLength && Number.parseInt(contentLength, 10) > STREAM_BYTE_LIMIT) {
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
			reader.cancel();
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

async function fetchWithRedirects(url: URL, fetchFn: FetchLike, signal: AbortSignal): Promise<FetchResponse> {
	let current = url;
	for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
		await assertPublicHttpUrl(current.toString());
		const response = await fetchFn(current, {
			redirect: "manual",
			headers: {
				"User-Agent": "Pi-Web-Tools/0.1 (+https://github.com/badlogic/pi-skills)",
				Accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.8",
			},
			signal,
		});

		const location = response.headers.get("location");
		if (response.status >= 300 && response.status < 400 && location) {
			current = await assertPublicHttpUrl(new URL(location, current).toString());
			continue;
		}

		return { response, finalUrl: current.toString() };
	}

	throw new WebToolsError(`Too many redirects while fetching ${url.toString()}`);
}

export async function webFetch(input: WebFetchInput, options: WebFetchOptions = {}): Promise<WebFetchResult> {
	const config = options.config ?? getWebToolsConfig();
	const initialUrl = await assertPublicHttpUrl(input.url.trim());
	const maxChars = normalizeMaxChars(input.maxChars, config.defaultFetchMaxChars, config.maxFetchMaxChars);
	const format = normalizeFormat(input.format);
	const timeout = createTimeoutSignal(options.signal, config.fetchTimeoutMs);

	try {
		const { response, finalUrl } = await fetchWithRedirects(
			initialUrl,
			options.fetchFn ?? defaultFetch(),
			timeout.signal,
		);
		if (!response.ok) {
			throw new WebToolsError(`/web failed to fetch page: HTTP ${response.status} ${response.statusText}`);
		}

		const contentType = response.headers.get("content-type") ?? undefined;
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
		timeout.cleanup();
	}
}
