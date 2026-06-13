import { beforeEach, describe, expect, it } from "vitest";
import { messagesHaveGitEvidenceSignal } from "../src/core/agent-session.ts";
import {
	buildSessionContext,
	type CompactionEntry,
	type SessionEntry,
	type SessionMessageEntry,
} from "../src/core/session-manager.ts";

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

// The one corner the static analysis could not prove safe: a session that was
// COMPACTED (dropping the original `git ...` command) and then RESUMED. Resume
// re-activation (sdk.ts) scans the *post-compaction* transcript, so it can only
// rely on a surviving digest's text — never the original command. These tests run
// the real buildSessionContext() compaction resolver and lock that behavior.
describe("messagesHaveGitEvidenceSignal — compact-then-resume corner", () => {
	let counter = 0;
	let lastId: string | null = null;
	beforeEach(() => {
		counter = 0;
		lastId = null;
	});

	function entry(message: unknown): SessionMessageEntry {
		const id = `e${counter++}`;
		const e: SessionMessageEntry = {
			type: "message",
			id,
			parentId: lastId,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: message as never,
		};
		lastId = id;
		return e;
	}
	function compaction(summary: string, firstKeptEntryId: string): CompactionEntry {
		const id = `c${counter++}`;
		const e: CompactionEntry = {
			type: "compaction",
			id,
			parentId: lastId,
			timestamp: "2026-01-01T00:00:00.000Z",
			summary,
			firstKeptEntryId,
			tokensBefore: 10000,
		};
		lastId = id;
		return e;
	}

	const gitCommandMsg = {
		role: "assistant",
		content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "git diff HEAD" } }],
	};
	// The digest the bash tool produced — note the required GIT_EVIDENCE_PREFIX.
	const digestMsg = {
		role: "toolResult",
		toolName: "bash",
		content: [{ type: "text", text: "Git evidence captured: git-diff-abcdef123456 (3 files, +12 -4)" }],
	};

	it("still fires when compaction dropped the command but a digest survived", () => {
		// The git command (and its turn) sit BEFORE the cut point → summarized away.
		// The digest survives as the first kept entry → must still re-activate on resume.
		const cmd = entry(gitCommandMsg);
		const dropped = entry({ role: "assistant", content: [{ type: "text", text: "inspecting…" }] });
		const digest = entry(digestMsg);
		const after = entry({ role: "user", content: "and now?" });
		const comp = compaction("(earlier git inspection summarized)", digest.id);
		const entries: SessionEntry[] = [cmd, dropped, digest, after, comp];

		const { messages } = buildSessionContext(entries);
		// The original git command must be gone, proving we rely on the digest text alone.
		const hasCommand = messages.some(
			(m) =>
				(m as { role?: string }).role === "assistant" &&
				Array.isArray((m as { content?: unknown[] }).content) &&
				(m as { content: { type?: string; name?: string }[] }).content.some(
					(b) => b.type === "toolCall" && b.name === "bash",
				),
		);
		expect(hasCommand).toBe(false);
		expect(messagesHaveGitEvidenceSignal(messages)).toBe(true);
	});

	it("does not fire when compaction dropped BOTH the command and the digest", () => {
		// Nothing readable survives → no activation is correct (there is no digest to read).
		const cmd = entry(gitCommandMsg);
		const digest = entry(digestMsg);
		const after = entry({ role: "user", content: "moving on" });
		const comp = compaction("(git work summarized, no evidence retained)", after.id);
		const entries: SessionEntry[] = [cmd, digest, after, comp];

		const { messages } = buildSessionContext(entries);
		expect(messagesHaveGitEvidenceSignal(messages)).toBe(false);
	});

	it("relies on the GIT_EVIDENCE_PREFIX: a prefix-stripped surviving digest is NOT detected", () => {
		// Contract lock for the flagged corner — if compaction ever keeps a readable
		// digest but drops its 'Git evidence captured:' prefix, resume re-activation
		// silently stops working. This test makes that coupling explicit so any change
		// to the digest text format forces a matching update to isGitEvidenceText.
		const strippedDigest = {
			role: "toolResult",
			toolName: "bash",
			content: [{ type: "text", text: "git-diff-abcdef123456 (3 files, +12 -4)" }],
		};
		const cmd = entry(gitCommandMsg);
		const digest = entry(strippedDigest);
		const after = entry({ role: "user", content: "next" });
		const comp = compaction("summary", digest.id);
		const entries: SessionEntry[] = [cmd, digest, after, comp];

		const { messages } = buildSessionContext(entries);
		expect(messagesHaveGitEvidenceSignal(messages)).toBe(false);
	});
});
