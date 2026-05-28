import { describe, expect, test } from "vitest";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";

describe("buildSystemPrompt", () => {
	describe("empty tools", () => {
		test("shows (none) for empty tools list", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Available tools:\n(none)");
		});

		test("shows file paths guideline even with no tools", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Show file paths clearly");
		});
	});

	describe("default tools", () => {
		test("includes all default tools when snippets are provided", () => {
			const prompt = buildSystemPrompt({
				toolSnippets: {
					read: "Read file contents",
					bash: "Execute bash commands",
					edit: "Make surgical edits",
					write: "Create or overwrite files",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- read:");
			expect(prompt).toContain("- bash:");
			expect(prompt).toContain("- edit:");
			expect(prompt).toContain("- write:");
		});

		test("instructs models to resolve pi docs and examples under absolute base paths", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain(
				"- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory",
			);
		});
	});

	describe("custom tool snippets", () => {
		test("includes custom tools in available tools section when promptSnippet is provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				toolSnippets: {
					dynamic_tool: "Run dynamic test behavior",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- dynamic_tool: Run dynamic test behavior");
		});

		test("omits custom tools from available tools section when promptSnippet is not provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain("dynamic_tool");
		});
	});

	describe("prompt guidelines", () => {
		test("appends promptGuidelines to default guidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for project summaries."],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- Use dynamic_tool for project summaries.");
		});

		test("deduplicates and trims promptGuidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for summaries.", "  Use dynamic_tool for summaries.  ", "   "],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt.match(/- Use dynamic_tool for summaries\./g)).toHaveLength(1);
		});
	});

	describe("context files", () => {
		test("includes context files verbatim in default prompt", () => {
			const content = "# Project Guidelines\n\nBe helpful.";
			const prompt = buildSystemPrompt({
				contextFiles: [{ path: "/project/AGENTS.md", content }],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain(content);
			expect(prompt).toContain('path="/project/AGENTS.md"');
		});

		test("includes context files verbatim in custom prompt", () => {
			const content = "# Custom Guidelines\n\nBe precise.";
			const prompt = buildSystemPrompt({
				customPrompt: "Custom system prompt.",
				contextFiles: [{ path: "/project/CLAUDE.md", content }],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain(content);
			expect(prompt).toContain('path="/project/CLAUDE.md"');
		});

		test("truncates context files exceeding token budget", () => {
			// CONTEXT_FILES_TOKEN_BUDGET = 4000 tokens ≈ 16000 chars
			const bigContent = "x".repeat(20000); // ~5000 tokens, exceeds budget
			const prompt = buildSystemPrompt({
				contextFiles: [{ path: "/project/AGENTS.md", content: bigContent }],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("file truncated to fit context budget");
			expect(prompt).toContain("Read /project/AGENTS.md for full content");
			// Should not contain the full content
			expect(prompt.length).toBeLessThan(bigContent.length);
		});

		test("does not truncate context files within token budget", () => {
			const smallContent = "# Guidelines\n\nBe helpful."; // well under budget
			const prompt = buildSystemPrompt({
				contextFiles: [{ path: "/project/AGENTS.md", content: smallContent }],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain(smallContent);
			expect(prompt).not.toContain("file truncated");
		});

		test("truncates later files first when multiple files exceed budget", () => {
			// Two files together exceed budget, first file fits, second gets truncated
			const firstContent = "x".repeat(12000); // ~3000 tokens
			const secondContent = "y".repeat(12000); // ~3000 tokens, total ~6000 > 4000
			const prompt = buildSystemPrompt({
				contextFiles: [
					{ path: "/project/AGENTS.md", content: firstContent },
					{ path: "/project/CLAUDE.md", content: secondContent },
				],
				skills: [],
				cwd: process.cwd(),
			});

			// First file should be intact
			expect(prompt).toContain("x".repeat(100));
			// Second file should be truncated
			expect(prompt).toContain("file truncated to fit context budget");
			expect(prompt).toContain("Read /project/CLAUDE.md for full content");
		});

		test("guarantees minimum content for each file even when budget is tight", () => {
			// Three large files, budget = 4000 tokens, min per file = 500 tokens
			// Each file is ~5000 tokens, total ~15000 >> 4000
			const content = "z".repeat(20000);
			const prompt = buildSystemPrompt({
				contextFiles: [
					{ path: "/project/A.md", content },
					{ path: "/project/B.md", content },
					{ path: "/project/C.md", content },
				],
				skills: [],
				cwd: process.cwd(),
			});

			// All three files should appear (not 0 chars for later files)
			expect(prompt).toContain('path="/project/A.md"');
			expect(prompt).toContain('path="/project/B.md"');
			expect(prompt).toContain('path="/project/C.md"');
			// At least the last file should be truncated
			expect(prompt).toContain("file truncated to fit context budget");
		});
	});
});
