import type { Dispatcher } from "undici";
import type { ResolveHost } from "./safety.ts";

export type WebToolsEnv = Record<string, string | undefined>;

export type WebToolsConfig = {
	braveApiKey?: string;
	defaultCountry: string;
	defaultSearchCount: number;
	maxSearchCount: number;
	searchTimeoutMs: number;
	fetchTimeoutMs: number;
	defaultFetchMaxChars: number;
	maxFetchMaxChars: number;
};

export type WebSearchInput = {
	query: string;
	count?: number;
	country?: string;
	freshness?: string;
};

export type WebSearchResultItem = {
	rank: number;
	title: string;
	url: string;
	snippet: string;
	age?: string;
	source?: string;
};

export type WebSearchResult = {
	query: string;
	count: number;
	country: string;
	freshness?: string;
	results: WebSearchResultItem[];
};

export type WebFetchInput = {
	url: string;
	maxChars?: number;
	format?: "markdown" | "text";
};

export type WebFetchResult = {
	url: string;
	finalUrl: string;
	title?: string;
	contentType?: string;
	content: string;
	truncated: boolean;
};

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type WebSearchOptions = {
	config?: WebToolsConfig;
	fetchFn?: FetchLike;
	signal?: AbortSignal;
};

export type WebFetchOptions = {
	config?: WebToolsConfig;
	fetchFn?: FetchLike;
	resolveHost?: ResolveHost;
	dispatcherFactory?: (url: URL, addresses: string[]) => Dispatcher;
	signal?: AbortSignal;
};
