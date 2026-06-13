import { describe, expect, it } from "vitest";
import { messagesHaveGitEvidenceSignal } from "../src/core/agent-session.ts";

// The lazy git-evidence activation hinges on this detector firing on exactly the
// same signal that createGitEvidenceResult uses to mint a digest (detectGitInspection),
// so the tools are present before the model could read the digest — never more, never less.
describe("messagesHaveGitEvidenceSignal", () => {
	const assistantBash = (command: string) => ({
		role: "assistant" as const,
		content: [{ type: "toolCall" as const, id: "t1", name: "bash", arguments: { command } }],
	});

	it("returns false for an empty transcript", () => {
		expect(messagesHaveGitEvidenceSignal([])).toBe(false);
	});

	it("returns false for non-git bash commands", () => {
		expect(messagesHaveGitEvidenceSignal([assistantBash("ls -la") as never])).toBe(false);
		expect(messagesHaveGitEvidenceSignal([assistantBash("echo hi | wc -l") as never])).toBe(false);
	});

	it("fires on git inspection commands (matching the digest gate)", () => {
		expect(messagesHaveGitEvidenceSignal([assistantBash("git status") as never])).toBe(true);
		expect(messagesHaveGitEvidenceSignal([assistantBash("git diff HEAD~1") as never])).toBe(true);
		expect(messagesHaveGitEvidenceSignal([assistantBash("cd /repo && git log --oneline") as never])).toBe(true);
	});

	it("fires on git inside pipes or substitutions", () => {
		expect(messagesHaveGitEvidenceSignal([assistantBash("git diff | head") as never])).toBe(true);
		expect(messagesHaveGitEvidenceSignal([assistantBash("echo $(git show HEAD)") as never])).toBe(true);
	});

	it("fires when an already-captured git evidence digest is present (resume safety)", () => {
		const digest = {
			role: "toolResult" as const,
			toolName: "bash",
			content: [{ type: "text" as const, text: "Git evidence captured: git-diff-abcdef123456 (...)" }],
		};
		expect(messagesHaveGitEvidenceSignal([digest as never])).toBe(true);
	});

	it("fires on a bashExecution message running git", () => {
		const exec = { role: "bashExecution" as const, command: "git show HEAD", output: "diff --git ..." };
		expect(messagesHaveGitEvidenceSignal([exec as never])).toBe(true);
	});
});
