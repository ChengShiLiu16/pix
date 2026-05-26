import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { ExtensionAPI } from "../../../index.ts";
import { errorMessage } from "./lib/errors.ts";

const WebSearchParams = Type.Object({
	action: Type.Union([Type.Literal("search"), Type.Literal("fetch")], {
		description: "search=搜索, fetch=抓取指定 URL 的网页内容",
	}),
	query: Type.Optional(Type.String({ description: "搜索关键词（action 为 search 时必填）" })),
	url: Type.Optional(Type.String({ description: "要抓取的网页 URL（action 为 fetch 时必填）" })),
	count: Type.Optional(Type.Number({ description: "返回结果数量，范围 1-10，默认 5" })),
	freshness: Type.Optional(Type.String({ description: "时间范围：pd=今天, pw=本周, pm=本月, py=今年" })),
});

type WebSearchParams = Static<typeof WebSearchParams>;
const EMPTY = new Text("", 0, 0);

export function builtin(pi: ExtensionAPI): void {
	pi.registerTool<typeof WebSearchParams>({
		name: "Brave_Search",
		label: "Brave Search",
		description: "通过 Brave Search API 搜索互联网获取实时信息，或抓取指定 URL 的网页内容。需要联网信息时使用。",
		promptSnippet: "搜索互联网获取实时信息",
		promptGuidelines: ["需要联网信息时使用 Brave_Search", "用户提供 URL 则 action='fetch'，否则 action='search'"],
		parameters: WebSearchParams,
		renderShell: "self",
		renderCall: (_args: unknown, theme: any) => {
			const detail = (_args as WebSearchParams).query || (_args as WebSearchParams).url || "";
			const line =
				theme.fg("toolTitle", theme.bold("Brave_Search")) +
				"\n" +
				theme.fg("dim", " └─ ") +
				theme.fg("dim", detail);
			return new Text(line, 0, 0);
		},
		renderResult: () => EMPTY,
		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			if (params.action === "fetch") {
				if (!params.url) {
					return {
						content: [{ type: "text", text: "请提供要抓取的 URL" }],
						isError: true,
						details: undefined,
					};
				}
				try {
					const [{ webFetch }, { formatFetchResult }] = await Promise.all([
						import("./lib/fetch.ts"),
						import("./lib/format.ts"),
					]);
					const result = await webFetch({ url: params.url }, { signal });
					return { content: [{ type: "text", text: formatFetchResult(result) }], details: undefined };
				} catch (error) {
					return {
						content: [{ type: "text", text: `抓取失败：${errorMessage(error)}` }],
						isError: true,
						details: undefined,
					};
				}
			}

			if (!params.query) {
				return {
					content: [{ type: "text", text: "请提供搜索关键词" }],
					isError: true,
					details: undefined,
				};
			}
			try {
				const [{ webSearch }, { formatSearchResult }] = await Promise.all([
					import("./lib/search.ts"),
					import("./lib/format.ts"),
				]);
				const result = await webSearch(
					{
						query: params.query,
						count: params.count,
						freshness: params.freshness,
					},
					{ signal },
				);
				return { content: [{ type: "text", text: formatSearchResult(result) }], details: undefined };
			} catch (error) {
				return {
					content: [{ type: "text", text: `搜索失败：${errorMessage(error)}` }],
					isError: true,
					details: undefined,
				};
			}
		},
	});
}
