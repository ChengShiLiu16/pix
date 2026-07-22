import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { builtinExtensionFactories } from "../src/core/builtin-extensions/index.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("builtin extension display names", () => {
	it("registers builtins as named InlineExtension wrappers", () => {
		expect(builtinExtensionFactories.length).toBeGreaterThan(0);
		for (const entry of builtinExtensionFactories) {
			expect(typeof entry).not.toBe("function");
			expect(entry).toEqual(
				expect.objectContaining({
					name: expect.any(String),
					factory: expect.any(Function),
				}),
			);
			if (typeof entry !== "function") {
				expect(entry.name.length).toBeGreaterThan(0);
			}
		}
	});

	it("surfaces <inline:name> paths in the resource loader", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pix-builtin-ext-names-"));
		tempDirs.push(dir);
		const loader = new DefaultResourceLoader({
			cwd: dir,
			agentDir: dir,
			extensionFactories: builtinExtensionFactories,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await loader.reload();

		const paths = loader
			.getExtensions()
			.extensions.map((ext) => ext.path)
			.filter((path) => path.startsWith("<inline:"));

		expect(paths).toContain("<inline:fff>");
		expect(paths).toContain("<inline:web-tools>");
		expect(paths).toContain("<inline:ask-user-question>");
		// Must not fall back to bare numeric labels for these builtins.
		expect(paths.some((path) => /^<inline:\d+>$/.test(path))).toBe(false);
	});
});
