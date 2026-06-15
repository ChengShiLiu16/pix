import type { AutocompleteProvider } from "@chengshiliu16/pix-tui";
import type { SearchResult } from "@ff-labs/fff-node";
import type { Static, TSchema } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { builtin as fffBuiltin } from "../src/core/builtin-extensions/fff.ts";
import {
	buildFffQuery,
	createFffMentionProvider,
	formatFffFindOutput,
	normalizePathConstraint,
	resolveFffToolNames,
} from "../src/core/builtin-extensions/lib/fff.ts";
import type { AgentToolResult, ExtensionAPI, ToolDefinition } from "../src/core/extensions/types.ts";

const fffNativeMock = vi.hoisted(() => {
	const finder = {
		isDestroyed: false,
		destroy: vi.fn(),
		waitForScan: vi.fn(async () => ({ ok: true, value: true })),
		scanFiles: vi.fn(() => ({ ok: true })),
		grep: vi.fn(() => ({
			ok: true,
			value: {
				items: [],
				scores: [],
				totalMatched: 0,
				totalFiles: 1,
			},
		})),
		fileSearch: vi.fn(() => ({
			ok: true,
			value: {
				items: [],
				scores: [],
				totalMatched: 0,
				totalFiles: 1,
			},
		})),
		multiGrep: vi.fn(() => ({
			ok: true,
			value: {
				items: [],
				scores: [],
				totalMatched: 0,
				totalFiles: 1,
			},
		})),
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
	const toolDefinitions: ToolDefinition<TSchema, unknown>[] = [];
	const commands: string[] = [];
	const flags: string[] = [];
	const sessionStartHandlers: Array<(event: unknown, ctx: unknown) => void> = [];

	const api = {
		on(event: string, handler: unknown) {
			if (event === "session_start" && typeof handler === "function") {
				sessionStartHandlers.push(handler as (event: unknown, ctx: unknown) => void);
			}
		},
		registerTool(tool: ToolDefinition<TSchema, unknown>) {
			tools.push(tool.name);
			toolDefinitions.push(tool);
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
		tool(name: string) {
			const tool = toolDefinitions.find((definition) => definition.name === name);
			if (!tool) throw new Error(`missing tool ${name}`);
			return tool;
		},
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

function resetFffMock() {
	fffNativeMock.create.mockClear();
	fffNativeMock.finder.isDestroyed = false;
	fffNativeMock.finder.destroy.mockClear();
	fffNativeMock.finder.waitForScan.mockClear();
	fffNativeMock.finder.scanFiles.mockClear();
	fffNativeMock.finder.grep.mockClear();
	fffNativeMock.finder.fileSearch.mockClear();
	fffNativeMock.finder.multiGrep.mockClear();
	fffNativeMock.finder.mixedSearch.mockClear();
}

async function flushMicrotasks() {
	await Promise.resolve();
	await Promise.resolve();
}

async function executeTool<TParams extends TSchema>(
	tool: ToolDefinition<TParams>,
	params: Static<TParams>,
): Promise<AgentToolResult<unknown>> {
	return tool.execute("call-id", params, undefined, undefined, {} as never);
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
		resetFffMock();
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
		expect(fffNativeMock.create).toHaveBeenCalledWith(
			expect.objectContaining({
				basePath: "/repo",
				disableWatch: true,
			}),
		);
	});

	it("registers overriding tool names only when explicitly configured", () => {
		resetFffMock();
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

	it("refreshes the disabled watcher index before first-page grep searches", async () => {
		resetFffMock();
		const mock = createMockApi();
		fffBuiltin(mock.api);
		const ctx = createSessionStartContext();
		mock.sessionStartHandlers[0]?.({ type: "session_start", reason: "startup" }, ctx);
		await flushMicrotasks();

		await executeTool(mock.tool("ffgrep"), { pattern: "needle" });

		expect(fffNativeMock.finder.scanFiles).toHaveBeenCalledTimes(1);
		expect(fffNativeMock.finder.waitForScan).toHaveBeenCalledWith(3000);
		expect(fffNativeMock.finder.grep).toHaveBeenCalledWith(
			"needle",
			expect.objectContaining({ mode: "plain", cursor: null }),
		);
	});

	it("does not refresh before cursor grep continuation", async () => {
		resetFffMock();
		const mock = createMockApi();
		fffBuiltin(mock.api);
		const ctx = createSessionStartContext();
		mock.sessionStartHandlers[0]?.({ type: "session_start", reason: "startup" }, ctx);
		await flushMicrotasks();

		await executeTool(mock.tool("ffgrep"), { pattern: "needle", cursor: "missing" });

		expect(fffNativeMock.finder.scanFiles).not.toHaveBeenCalled();
		expect(fffNativeMock.finder.grep).toHaveBeenCalledWith(
			"needle",
			expect.objectContaining({ mode: "plain", cursor: null }),
		);
	});

	it("refreshes the disabled watcher index before first-page find searches", async () => {
		resetFffMock();
		const mock = createMockApi();
		fffBuiltin(mock.api);
		const ctx = createSessionStartContext();
		mock.sessionStartHandlers[0]?.({ type: "session_start", reason: "startup" }, ctx);
		await flushMicrotasks();

		await executeTool(mock.tool("fffind"), { pattern: "needle" });

		expect(fffNativeMock.finder.scanFiles).toHaveBeenCalledTimes(1);
		expect(fffNativeMock.finder.waitForScan).toHaveBeenCalledWith(3000);
		expect(fffNativeMock.finder.fileSearch).toHaveBeenCalledWith("needle", { pageIndex: 0, pageSize: 30 });
	});

	it("refreshes the disabled watcher index before first-page multi grep searches", async () => {
		resetFffMock();
		const previous = process.env.PIX_FFF_MULTIGREP;
		process.env.PIX_FFF_MULTIGREP = "1";
		try {
			const mock = createMockApi();
			fffBuiltin(mock.api);
			const ctx = createSessionStartContext();
			mock.sessionStartHandlers[0]?.({ type: "session_start", reason: "startup" }, ctx);
			await flushMicrotasks();

			await executeTool(mock.tool("fff-multi-grep"), { patterns: ["needle"] });

			expect(fffNativeMock.finder.scanFiles).toHaveBeenCalledTimes(1);
			expect(fffNativeMock.finder.waitForScan).toHaveBeenCalledWith(3000);
			expect(fffNativeMock.finder.multiGrep).toHaveBeenCalledWith(
				expect.objectContaining({ patterns: ["needle"], cursor: null }),
			);
		} finally {
			if (previous === undefined) {
				delete process.env.PIX_FFF_MULTIGREP;
			} else {
				process.env.PIX_FFF_MULTIGREP = previous;
			}
		}
	});

	it("refreshes the disabled watcher index before mention completions", async () => {
		resetFffMock();
		const mock = createMockApi();
		fffBuiltin(mock.api);
		const ctx = createSessionStartContext();
		mock.sessionStartHandlers[0]?.({ type: "session_start", reason: "startup" }, ctx);
		const providerFactory = vi.mocked(ctx.ui.addAutocompleteProvider).mock.calls[0]?.[0] as
			| ((fallback: AutocompleteProvider) => AutocompleteProvider)
			| undefined;
		expect(providerFactory).toBeDefined();
		const provider = providerFactory!({
			getSuggestions: vi.fn(async () => null),
			applyCompletion: vi.fn((lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol })),
		});
		await flushMicrotasks();

		const suggestions = await provider.getSuggestions(["open @sr"], 0, 8, { signal: new AbortController().signal });

		expect(fffNativeMock.finder.scanFiles).toHaveBeenCalledTimes(1);
		expect(fffNativeMock.finder.waitForScan).toHaveBeenCalledWith(3000);
		expect(fffNativeMock.finder.mixedSearch).toHaveBeenCalledWith("sr", { pageSize: 20 });
		expect(suggestions?.items[0]?.value).toBe("@src/index.ts");
	});

	it("throttles mention refreshes while still searching each request", async () => {
		resetFffMock();
		const now = vi.spyOn(Date, "now");
		try {
			now.mockReturnValue(10_000);
			const mock = createMockApi();
			fffBuiltin(mock.api);
			const ctx = createSessionStartContext();
			mock.sessionStartHandlers[0]?.({ type: "session_start", reason: "startup" }, ctx);
			const providerFactory = vi.mocked(ctx.ui.addAutocompleteProvider).mock.calls[0]?.[0] as
				| ((fallback: AutocompleteProvider) => AutocompleteProvider)
				| undefined;
			expect(providerFactory).toBeDefined();
			const provider = providerFactory!({
				getSuggestions: vi.fn(async () => null),
				applyCompletion: vi.fn((lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol })),
			});
			await flushMicrotasks();

			await provider.getSuggestions(["open @sr"], 0, 8, { signal: new AbortController().signal });
			now.mockReturnValue(11_000);
			await provider.getSuggestions(["open @src"], 0, 9, { signal: new AbortController().signal });
			now.mockReturnValue(12_001);
			await provider.getSuggestions(["open @src/"], 0, 10, { signal: new AbortController().signal });

			expect(fffNativeMock.finder.scanFiles).toHaveBeenCalledTimes(2);
			expect(fffNativeMock.finder.mixedSearch).toHaveBeenCalledTimes(3);
		} finally {
			now.mockRestore();
		}
	});
});
