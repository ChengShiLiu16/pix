import type { SearchResult } from "@ff-labs/fff-node";
import { describe, expect, it, vi } from "vitest";
import { builtin as fffBuiltin } from "../src/core/builtin-extensions/fff.ts";
import {
	buildFffQuery,
	createFffMentionProvider,
	formatFffFindOutput,
	normalizePathConstraint,
	resolveFffToolNames,
} from "../src/core/builtin-extensions/lib/fff.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";

const fffNativeMock = vi.hoisted(() => {
	const finder = {
		isDestroyed: false,
		destroy: vi.fn(),
		waitForScan: vi.fn(async () => ({ ok: true, value: true })),
		mixedSearch: vi.fn(() => ({
			ok: true,
			value: {
				items: [
					{
						type: "file",
						item: {
							relativePath: "src/index.ts",
							fileName: "index.ts",
							size: 12,
							modified: 0,
							accessFrecencyScore: 0,
							modificationFrecencyScore: 0,
							totalFrecencyScore: 0,
							gitStatus: "clean",
						},
					},
				],
				scores: [],
				totalMatched: 1,
				totalFiles: 1,
				totalDirs: 0,
			},
		})),
	};
	return {
		finder,
		create: vi.fn(() => ({ ok: true, value: finder })),
	};
});

vi.mock("@ff-labs/fff-node", () => ({
	FileFinder: {
		create: fffNativeMock.create,
	},
}));

function createMockApi(flagValues = new Map<string, boolean | string>()) {
	const tools: string[] = [];
	const toolDefinitions: Array<{ name: string; aliases?: string[] }> = [];
	const commands: string[] = [];
	const flags: string[] = [];
	const sessionStartHandlers: Array<(event: unknown, ctx: unknown) => void> = [];

	const api = {
		on(event: string, handler: unknown) {
			if (event === "session_start" && typeof handler === "function") {
				sessionStartHandlers.push(handler as (event: unknown, ctx: unknown) => void);
			}
		},
		registerTool(tool: { name: string; aliases?: string[] }) {
			tools.push(tool.name);
			toolDefinitions.push({ name: tool.name, aliases: tool.aliases });
		},
		registerCommand(name: string) {
			commands.push(name);
		},
		registerFlag(name: string) {
			flags.push(name);
		},
		getFlag(name: string) {
			return flagValues.get(name);
		},
	};

	return {
		api: api as unknown as ExtensionAPI,
		tools,
		toolDefinitions,
		commands,
		flags,
		sessionStartHandlers,
	};
}

function createSessionStartContext() {
	return {
		cwd: "/repo",
		ui: {
			addAutocompleteProvider: vi.fn(),
			notify: vi.fn(),
			setStatus: vi.fn(),
		},
	};
}

describe("fff builtin extension", () => {
	it("normalizes FFF path constraints and excludes", () => {
		expect(normalizePathConstraint("/repo/src/**/*.ts", "/repo")).toBe("src/**/*.ts");
		expect(normalizePathConstraint("src", "/repo")).toBe("src/");
		expect(normalizePathConstraint("package.json", "/repo")).toBe("package.json");
		expect(buildFffQuery("src", "registerTool", "test/,*.map", "/repo")).toBe("src/ !test/ !*.map registerTool");
		expect(() => normalizePathConstraint("/outside/file.ts", "/repo")).toThrow(/relative to the workspace/);
	});

	it("keeps default tool names separate and maps override names explicitly", () => {
		expect(resolveFffToolNames("tools-and-ui")).toEqual({
			grep: "ffgrep",
			find: "fffind",
			findAliases: ["ffind"],
			multiGrep: "fff-multi-grep",
		});
		expect(resolveFffToolNames("override")).toEqual({
			grep: "grep",
			find: "find",
			findAliases: [],
			multiGrep: "multi_grep",
		});
	});

	it("formats weak find results with a capped sample", () => {
		const result: SearchResult = {
			items: [
				{
					relativePath: "src/a.ts",
					fileName: "a.ts",
					size: 1,
					modified: 0,
					accessFrecencyScore: 0,
					modificationFrecencyScore: 0,
					totalFrecencyScore: 0,
					gitStatus: "clean",
				},
				{
					relativePath: "src/b.ts",
					fileName: "b.ts",
					size: 1,
					modified: 0,
					accessFrecencyScore: 0,
					modificationFrecencyScore: 0,
					totalFrecencyScore: 0,
					gitStatus: "clean",
				},
			],
			scores: [
				{
					total: 0,
					baseScore: 0,
					filenameBonus: 0,
					specialFilenameBonus: 0,
					frecencyBoost: 0,
					distancePenalty: 0,
					currentFilePenalty: 0,
					comboMatchBoost: 0,
					exactMatch: false,
					matchType: "fuzzy",
				},
			],
			totalMatched: 2,
			totalFiles: 2,
		};

		expect(formatFffFindOutput(result, 30, "abc")).toEqual({
			output: "src/a.ts\nsrc/b.ts",
			weak: true,
			shownCount: 2,
		});
	});

	it("wraps only @ mention completions and preserves fallback behavior", async () => {
		const fallback = {
			getSuggestions: vi.fn(async () => null),
			applyCompletion: vi.fn((lines: string[], cursorLine: number, cursorCol: number) => ({
				lines,
				cursorLine,
				cursorCol,
			})),
		};
		const provider = createFffMentionProvider(
			async () => [{ value: "@src/index.ts", label: "index.ts", description: "src/index.ts" }],
			fallback,
		);
		const controller = new AbortController();

		const suggestions = await provider.getSuggestions(["open @sr"], 0, 8, { signal: controller.signal });

		expect(suggestions?.prefix).toBe("@sr");
		expect(suggestions?.items[0]?.value).toBe("@src/index.ts");
		expect(fallback.getSuggestions).not.toHaveBeenCalled();
		expect(provider.applyCompletion(["open @sr"], 0, 8, suggestions!.items[0]!, "@sr")).toEqual({
			lines: ["open @src/index.ts "],
			cursorLine: 0,
			cursorCol: 19,
		});

		await provider.getSuggestions(["plain"], 0, 5, { signal: controller.signal });
		expect(fallback.getSuggestions).toHaveBeenCalled();
	});

	it("registers non-overriding tools by default on session start", () => {
		const mock = createMockApi();
		fffBuiltin(mock.api);
		const ctx = createSessionStartContext();

		mock.sessionStartHandlers[0]?.({ type: "session_start", reason: "startup" }, ctx);

		expect(mock.flags).toEqual(["fff-mode", "fff-frecency-db", "fff-history-db"]);
		expect(mock.commands).toEqual(["fff-mode", "fff-health", "fff-rescan"]);
		expect(mock.tools).toContain("fffind");
		expect(mock.tools).toContain("ffgrep");
		expect(mock.tools).not.toContain("ffind");
		expect(mock.tools).not.toContain("find");
		expect(mock.tools).not.toContain("grep");
		expect(mock.toolDefinitions.find((tool) => tool.name === "fffind")?.aliases).toEqual(["ffind"]);
		expect(ctx.ui.addAutocompleteProvider).toHaveBeenCalledTimes(1);
	});

	it("registers overriding tool names only when explicitly configured", () => {
		const mock = createMockApi(new Map([["fff-mode", "override"]]));
		fffBuiltin(mock.api);
		const ctx = createSessionStartContext();

		mock.sessionStartHandlers[0]?.({ type: "session_start", reason: "startup" }, ctx);

		expect(mock.tools).toContain("find");
		expect(mock.tools).toContain("grep");
		expect(mock.tools).not.toContain("ffind");
		expect(mock.tools).not.toContain("fffind");
		expect(mock.tools).not.toContain("ffgrep");
		expect(mock.toolDefinitions.find((tool) => tool.name === "find")?.aliases).toEqual([]);
	});
});
