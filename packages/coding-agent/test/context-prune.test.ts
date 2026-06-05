import type { AgentMessage } from "@earendil-works/pix-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pix-ai";
import { describe, expect, it } from "vitest";
import { pruneStaleReads, pruneThinkingForNonAnthropic } from "../src/core/context-prune.ts";

const BIG = "x".repeat(1000);

function assistantCall(id: string, name: string, args: Record<string, unknown>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: args }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 0,
	} as AssistantMessage;
}

function toolResult(id: string, toolName: string, text = BIG, isError = false): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName,
		content: [{ type: "text", text }],
		isError,
		timestamp: 0,
	};
}

function readResult(id: string, text = BIG, isError = false): ToolResultMessage {
	return toolResult(id, "read", text, isError);
}

function mutationResult(id: string, toolName: string): ToolResultMessage {
	return toolResult(id, toolName, "ok");
}

function resultText(message: AgentMessage): string {
	if (message.role !== "toolResult") return "";
	return (message as ToolResultMessage).content
		.filter((b): b is { type: "text"; text: string } => b.type === "text")
		.map((b) => b.text)
		.join("");
}

function omittedDetails(message: AgentMessage): Record<string, unknown> {
	if (message.role !== "toolResult") return {};
	const details = (message as ToolResultMessage<Record<string, unknown>>).details;
	const omitted = details?.contextOmitted;
	return typeof omitted === "object" && omitted !== null ? (omitted as Record<string, unknown>) : {};
}

// ============================================================================
// read tool (original tests, preserved)
// ============================================================================

describe("pruneStaleReads", () => {
	// --- read vs read ---

	it("stubs an earlier read superseded by a later read of the same window", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "read", { path: "/a.ts" }),
			readResult("c1"),
			assistantCall("c2", "read", { path: "/a.ts" }),
			readResult("c2"),
		];
		const result = pruneStaleReads(messages);
		expect(resultText(result[1])).toContain("Stale read omitted");
		expect(resultText(result[1])).toContain("read /a.ts");
		expect(omittedDetails(result[1])).toMatchObject({
			reason: "stale",
			toolName: "read",
			paths: ["/a.ts"],
			restoreHint: "Restore by re-reading: read /a.ts.",
		});
		expect(resultText(result[3])).toBe(BIG);
	});

	it("stubs a read superseded by a later edit/write of the same path", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "read", { path: "/a.ts" }),
			readResult("c1"),
			assistantCall("c2", "edit", { path: "/a.ts" }),
			mutationResult("c2", "edit"),
		];
		const result = pruneStaleReads(messages);
		expect(resultText(result[1])).toContain("Stale read omitted");
	});

	it("keeps reads of different files", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "read", { path: "/a.ts" }),
			readResult("c1"),
			assistantCall("c2", "read", { path: "/b.ts" }),
			readResult("c2"),
		];
		expect(pruneStaleReads(messages)).toBe(messages);
	});

	it("keeps reads with different offset/limit windows (non-overlapping)", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "read", { path: "/a.ts", offset: 1, limit: 50 }),
			readResult("c1"),
			assistantCall("c2", "read", { path: "/a.ts", offset: 200, limit: 50 }),
			readResult("c2"),
		];
		expect(pruneStaleReads(messages)).toBe(messages);
	});

	it("stubs a partial read when a later full-file read covers it", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "read", { path: "/a.ts", offset: 10, limit: 50 }),
			readResult("c1"),
			assistantCall("c2", "read", { path: "/a.ts" }),
			readResult("c2"),
		];
		const result = pruneStaleReads(messages);
		// Full read covers partial read → partial is stale
		expect(resultText(result[1])).toContain("Stale read omitted");
		expect(resultText(result[3])).toBe(BIG);
	});

	it("does NOT stub a full-file read when a later partial read doesn't cover it", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "read", { path: "/a.ts" }),
			readResult("c1"),
			assistantCall("c2", "read", { path: "/a.ts", offset: 10, limit: 50 }),
			readResult("c2"),
		];
		// Full read has more info than partial → full is NOT stale
		expect(pruneStaleReads(messages)).toBe(messages);
	});

	it("stubs a narrower partial read when a wider partial read covers it", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "read", { path: "/a.ts", offset: 1, limit: 50 }),
			readResult("c1"),
			assistantCall("c2", "read", { path: "/a.ts", offset: 1, limit: 100 }),
			readResult("c2"),
		];
		const result = pruneStaleReads(messages);
		// lines 1-100 covers lines 1-50 → earlier is stale
		expect(resultText(result[1])).toContain("Stale read omitted");
	});

	it("does NOT stub a partial read when a later partial read starts later", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "read", { path: "/a.ts", offset: 1, limit: 100 }),
			readResult("c1"),
			assistantCall("c2", "read", { path: "/a.ts", offset: 50, limit: 100 }),
			readResult("c2"),
		];
		// later starts at line 50, earlier starts at line 1 → not a superset
		expect(pruneStaleReads(messages)).toBe(messages);
	});

	it("stubs a partial read when a later partial read starts earlier and extends past it", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "read", { path: "/a.ts", offset: 10, limit: 50 }),
			readResult("c1"),
			assistantCall("c2", "read", { path: "/a.ts", offset: 1, limit: 100 }),
			readResult("c2"),
		];
		const result = pruneStaleReads(messages);
		// lines 1-100 covers lines 10-59 → earlier is stale
		expect(resultText(result[1])).toContain("Stale read omitted");
	});

	it("does not stub small reads below the threshold", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "read", { path: "/a.ts" }),
			readResult("c1", "tiny"),
			assistantCall("c2", "read", { path: "/a.ts" }),
			readResult("c2", "tiny"),
		];
		expect(pruneStaleReads(messages)).toBe(messages);
	});

	it("does not stub error reads", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "read", { path: "/a.ts" }),
			readResult("c1", BIG, true),
			assistantCall("c2", "read", { path: "/a.ts" }),
			readResult("c2"),
		];
		const result = pruneStaleReads(messages);
		expect(resultText(result[1])).toBe(BIG);
	});

	it("returns the original array when nothing is stale", () => {
		const messages: AgentMessage[] = [assistantCall("c1", "read", { path: "/a.ts" }), readResult("c1")];
		expect(pruneStaleReads(messages)).toBe(messages);
	});

	it("recognizes the filePath alias when matching a later edit", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "read", { path: "/a.ts" }),
			readResult("c1"),
			assistantCall("c2", "edit", { filePath: "/a.ts" }),
			mutationResult("c2", "edit"),
		];
		const result = pruneStaleReads(messages);
		expect(resultText(result[1])).toContain("Stale read omitted");
	});

	it("does not treat a failed edit as superseding an earlier read", () => {
		const failedEdit: ToolResultMessage = { ...mutationResult("c2", "edit"), isError: true };
		const messages: AgentMessage[] = [
			assistantCall("c1", "read", { path: "/a.ts" }),
			readResult("c1"),
			assistantCall("c2", "edit", { path: "/a.ts" }),
			failedEdit,
		];
		expect(pruneStaleReads(messages)).toBe(messages);
	});

	it("does not treat a failed duplicate read as superseding an earlier read", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "read", { path: "/a.ts" }),
			readResult("c1"),
			assistantCall("c2", "read", { path: "/a.ts" }),
			readResult("c2", BIG, true),
		];
		const result = pruneStaleReads(messages);
		expect(resultText(result[1])).toBe(BIG);
	});

	// --- grep: scope matching ---

	it("stubs a grep result when a file in its search scope is later edited", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "grep", { pattern: "foo", path: "/src" }),
			toolResult("c1", "grep", BIG),
			assistantCall("c2", "edit", { path: "/src/a.ts" }),
			mutationResult("c2", "edit"),
		];
		const result = pruneStaleReads(messages);
		expect(resultText(result[1])).toContain("Stale grep result omitted");
	});

	it("stubs a grep result when the exact searched file is later edited", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "grep", { pattern: "foo", path: "/a.ts" }),
			toolResult("c1", "grep", BIG),
			assistantCall("c2", "edit", { path: "/a.ts" }),
			mutationResult("c2", "edit"),
		];
		const result = pruneStaleReads(messages);
		expect(resultText(result[1])).toContain("Stale grep result omitted");
	});

	it("does not stub a grep result when a different directory is edited", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "grep", { pattern: "foo", path: "/src" }),
			toolResult("c1", "grep", BIG),
			assistantCall("c2", "edit", { path: "/other/a.ts" }),
			mutationResult("c2", "edit"),
		];
		expect(pruneStaleReads(messages)).toBe(messages);
	});

	it("does not stub a grep result superseded by a later read (read does not supersede grep)", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "grep", { pattern: "foo", path: "/a.ts" }),
			toolResult("c1", "grep", BIG),
			assistantCall("c2", "read", { path: "/a.ts" }),
			readResult("c2"),
		];
		expect(pruneStaleReads(messages)).toBe(messages);
	});

	it("does not stub a grep result superseded by a later grep (grep does not supersede grep)", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "grep", { pattern: "foo", path: "/a.ts" }),
			toolResult("c1", "grep", BIG),
			assistantCall("c2", "grep", { pattern: "bar", path: "/a.ts" }),
			toolResult("c2", "grep", BIG),
		];
		expect(pruneStaleReads(messages)).toBe(messages);
	});

	// --- grep: pathless (cwd fallback) ---

	it("stubs a pathless grep result when a file in cwd is later edited", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "grep", { pattern: "foo" }),
			toolResult("c1", "grep", BIG),
			assistantCall("c2", "edit", { path: "/proj/src/a.ts" }),
			mutationResult("c2", "edit"),
		];
		const result = pruneStaleReads(messages, "/proj");
		expect(resultText(result[1])).toContain("Stale grep result omitted");
	});

	it("does not stub a pathless grep result when cwd is not provided", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "grep", { pattern: "foo" }),
			toolResult("c1", "grep", BIG),
			assistantCall("c2", "edit", { path: "/proj/src/a.ts" }),
			mutationResult("c2", "edit"),
		];
		// Without cwd, pathless grep is not tracked → never stale
		expect(pruneStaleReads(messages)).toBe(messages);
	});

	// --- find: structure tool, scope matching ---

	it("stubs a find result when a file in the searched directory is later written (structural mutation)", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "find", { pattern: "*.ts", path: "/src" }),
			toolResult("c1", "find", BIG),
			assistantCall("c2", "write", { path: "/src/new.ts", content: "x" }),
			mutationResult("c2", "write"),
		];
		const result = pruneStaleReads(messages);
		expect(resultText(result[1])).toContain("Stale find result omitted");
	});

	it("does NOT stub a find result when a file in the directory is later edited (content-only mutation)", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "find", { pattern: "*.ts", path: "/src" }),
			toolResult("c1", "find", BIG),
			assistantCall("c2", "edit", { path: "/src/a.ts" }),
			mutationResult("c2", "edit"),
		];
		// edit only changes content, not file structure → find is NOT stale
		expect(pruneStaleReads(messages)).toBe(messages);
	});

	it("does not stub a find result when a different directory is written", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "find", { pattern: "*.ts", path: "/src" }),
			toolResult("c1", "find", BIG),
			assistantCall("c2", "write", { path: "/other/new.ts", content: "x" }),
			mutationResult("c2", "write"),
		];
		expect(pruneStaleReads(messages)).toBe(messages);
	});

	// --- ls: structure tool, scope matching ---

	it("stubs an ls result when a file in the listed directory is later written (structural mutation)", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "ls", { path: "/src" }),
			toolResult("c1", "ls", BIG),
			assistantCall("c2", "write", { path: "/src/new.ts", content: "x" }),
			mutationResult("c2", "write"),
		];
		const result = pruneStaleReads(messages);
		expect(resultText(result[1])).toContain("Stale ls result omitted");
	});

	it("does NOT stub an ls result when a file in the directory is later edited (content-only mutation)", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "ls", { path: "/src" }),
			toolResult("c1", "ls", BIG),
			assistantCall("c2", "edit", { path: "/src/a.ts" }),
			mutationResult("c2", "edit"),
		];
		// edit only changes content, not file structure → ls is NOT stale
		expect(pruneStaleReads(messages)).toBe(messages);
	});

	it("does not stub an ls result when a different directory is written", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "ls", { path: "/src" }),
			toolResult("c1", "ls", BIG),
			assistantCall("c2", "write", { path: "/other/new.ts", content: "x" }),
			mutationResult("c2", "write"),
		];
		expect(pruneStaleReads(messages)).toBe(messages);
	});

	// --- ls: pathless (cwd fallback) ---

	it("stubs a pathless ls result when a file in cwd is later written", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "ls", {}),
			toolResult("c1", "ls", BIG),
			assistantCall("c2", "write", { path: "/proj/new.ts", content: "x" }),
			mutationResult("c2", "write"),
		];
		const result = pruneStaleReads(messages, "/proj");
		expect(resultText(result[1])).toContain("Stale ls result omitted");
	});

	// --- bash (file-reading commands) ---

	it("stubs a bash cat result superseded by a later edit of the same file", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "bash", { command: "cat /a.ts" }),
			toolResult("c1", "bash", BIG),
			assistantCall("c2", "edit", { path: "/a.ts" }),
			mutationResult("c2", "edit"),
		];
		const result = pruneStaleReads(messages);
		expect(resultText(result[1])).toContain("Stale command output omitted");
	});

	it("stubs a bash head result superseded by a later write of the same file", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "bash", { command: "head -20 /a.ts" }),
			toolResult("c1", "bash", BIG),
			assistantCall("c2", "write", { path: "/a.ts" }),
			mutationResult("c2", "write"),
		];
		const result = pruneStaleReads(messages);
		expect(resultText(result[1])).toContain("Stale command output omitted");
	});

	it("handles bash head --lines=N flag correctly", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "bash", { command: "head --lines=20 /a.ts" }),
			toolResult("c1", "bash", BIG),
			assistantCall("c2", "edit", { path: "/a.ts" }),
			mutationResult("c2", "edit"),
		];
		const result = pruneStaleReads(messages);
		expect(resultText(result[1])).toContain("Stale command output omitted");
	});

	it("does not stub a bash result when the command is not a file read", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "bash", { command: "npm test" }),
			toolResult("c1", "bash", BIG),
			assistantCall("c2", "edit", { path: "/a.ts" }),
			mutationResult("c2", "edit"),
		];
		expect(pruneStaleReads(messages)).toBe(messages);
	});

	it("does not stub a bash result when the read file differs from the edited file", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "bash", { command: "cat /b.ts" }),
			toolResult("c1", "bash", BIG),
			assistantCall("c2", "edit", { path: "/a.ts" }),
			mutationResult("c2", "edit"),
		];
		expect(pruneStaleReads(messages)).toBe(messages);
	});

	it("does not stub a bash heredoc command (ambiguous)", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "bash", { command: "cat >> /a.ts <<EOF\nhello\nEOF" }),
			toolResult("c1", "bash", BIG),
			assistantCall("c2", "edit", { path: "/a.ts" }),
			mutationResult("c2", "edit"),
		];
		// heredoc cat >> is a write, not a read — should not be tracked
		expect(pruneStaleReads(messages)).toBe(messages);
	});

	// --- cross-tool: read + grep both stale ---

	it("stubs both a read and a grep result when the same file is later edited", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "read", { path: "/a.ts" }),
			readResult("c1"),
			assistantCall("c2", "grep", { pattern: "foo", path: "/a.ts" }),
			toolResult("c2", "grep", BIG),
			assistantCall("c3", "edit", { path: "/a.ts" }),
			mutationResult("c3", "edit"),
		];
		const result = pruneStaleReads(messages);
		expect(resultText(result[1])).toContain("Stale read omitted");
		expect(resultText(result[3])).toContain("Stale grep result omitted");
	});

	// --- cross-tool: read stale, find NOT stale ---

	it("stubs a read but NOT a find when a file in the directory is edited", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "read", { path: "/src/a.ts" }),
			readResult("c1"),
			assistantCall("c2", "find", { pattern: "*.ts", path: "/src" }),
			toolResult("c2", "find", BIG),
			assistantCall("c3", "edit", { path: "/src/a.ts" }),
			mutationResult("c3", "edit"),
		];
		const result = pruneStaleReads(messages);
		// read is a content tool → stale on edit
		expect(resultText(result[1])).toContain("Stale read omitted");
		// find is a structure tool → NOT stale on edit (content-only mutation)
		expect(resultText(result[3])).toBe(BIG);
	});

	// --- cross-tool: find stale on write, read stale on edit ---

	it("stubs a find but NOT a read of a different file when a new file is written in the directory", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "read", { path: "/src/a.ts" }),
			readResult("c1"),
			assistantCall("c2", "find", { pattern: "*.ts", path: "/src" }),
			toolResult("c2", "find", BIG),
			assistantCall("c3", "write", { path: "/src/b.ts", content: "x" }),
			mutationResult("c3", "write"),
		];
		const result = pruneStaleReads(messages);
		// read /src/a.ts: write /src/b.ts is a different file → NOT stale
		expect(resultText(result[1])).toBe(BIG);
		// find /src: write /src/b.ts is in scope → stale (structural mutation)
		expect(resultText(result[3])).toContain("Stale find result omitted");
	});

	it("stubs both a read and a find when the same file is written", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "read", { path: "/src/a.ts" }),
			readResult("c1"),
			assistantCall("c2", "find", { pattern: "*.ts", path: "/src" }),
			toolResult("c2", "find", BIG),
			assistantCall("c3", "write", { path: "/src/a.ts", content: "x" }),
			mutationResult("c3", "write"),
		];
		const result = pruneStaleReads(messages);
		// read /src/a.ts: write /src/a.ts is exact match → stale
		expect(resultText(result[1])).toContain("Stale read omitted");
		// find /src: write /src/a.ts is in scope → stale (structural mutation)
		expect(resultText(result[3])).toContain("Stale find result omitted");
	});

	// --- small results below threshold ---

	it("does not stub a small grep result below the threshold", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "grep", { pattern: "foo", path: "/a.ts" }),
			toolResult("c1", "grep", "tiny"),
			assistantCall("c2", "edit", { path: "/a.ts" }),
			mutationResult("c2", "edit"),
		];
		expect(pruneStaleReads(messages)).toBe(messages);
	});

	it("does not stub a small bash cat result below the threshold", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "bash", { command: "cat /a.ts" }),
			toolResult("c1", "bash", "tiny"),
			assistantCall("c2", "edit", { path: "/a.ts" }),
			mutationResult("c2", "edit"),
		];
		expect(pruneStaleReads(messages)).toBe(messages);
	});

	// --- read_many: batch content tool ---

	it("stubs a read_many result when a file in its batch is later edited", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "read_many", { files: [{ path: "/a.ts" }, { path: "/b.ts" }] }),
			toolResult("c1", "read_many", BIG),
			assistantCall("c2", "edit", { path: "/a.ts" }),
			mutationResult("c2", "edit"),
		];
		const result = pruneStaleReads(messages);
		expect(resultText(result[1])).toContain("Stale read omitted");
	});

	it("stubs a read_many result when a file in its batch is later written", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "read_many", { files: [{ path: "/a.ts" }, { path: "/b.ts" }] }),
			toolResult("c1", "read_many", BIG),
			assistantCall("c2", "write", { path: "/b.ts", content: "x" }),
			mutationResult("c2", "write"),
		];
		const result = pruneStaleReads(messages);
		expect(resultText(result[1])).toContain("Stale read omitted");
	});

	it("does not stub a read_many result when a different file is edited", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "read_many", { files: [{ path: "/a.ts" }, { path: "/b.ts" }] }),
			toolResult("c1", "read_many", BIG),
			assistantCall("c2", "edit", { path: "/c.ts" }),
			mutationResult("c2", "edit"),
		];
		expect(pruneStaleReads(messages)).toBe(messages);
	});

	it("stubs a read_many result using paths[] shorthand", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "read_many", { paths: ["/a.ts", "/b.ts"] }),
			toolResult("c1", "read_many", BIG),
			assistantCall("c2", "edit", { path: "/a.ts" }),
			mutationResult("c2", "edit"),
		];
		const result = pruneStaleReads(messages);
		expect(resultText(result[1])).toContain("Stale read omitted");
	});

	it("later read_many supersedes earlier single read of the same file", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "read", { path: "/a.ts" }),
			readResult("c1"),
			assistantCall("c2", "read_many", { files: [{ path: "/a.ts" }, { path: "/b.ts" }] }),
			toolResult("c2", "read_many", BIG),
		];
		const result = pruneStaleReads(messages);
		expect(resultText(result[1])).toContain("Stale read omitted");
	});

	it("later read_many supersedes earlier read with matching offset/limit", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "read", { path: "/a.ts", offset: 10, limit: 50 }),
			readResult("c1"),
			assistantCall("c2", "read_many", { files: [{ path: "/a.ts", offset: 10, limit: 50 }] }),
			toolResult("c2", "read_many", BIG),
		];
		const result = pruneStaleReads(messages);
		expect(resultText(result[1])).toContain("Stale read omitted");
	});

	it("later read_many with full-file read supersedes earlier partial read", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "read", { path: "/a.ts", offset: 10, limit: 50 }),
			readResult("c1"),
			assistantCall("c2", "read_many", { files: [{ path: "/a.ts" }] }),
			toolResult("c2", "read_many", BIG),
		];
		const result = pruneStaleReads(messages);
		// Full read in read_many covers partial read → stale
		expect(resultText(result[1])).toContain("Stale read omitted");
	});

	it("later read_many does NOT supersede earlier read with different offset (non-covering)", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "read", { path: "/a.ts", offset: 1, limit: 100 }),
			readResult("c1"),
			assistantCall("c2", "read_many", { files: [{ path: "/a.ts", offset: 200, limit: 50 }] }),
			toolResult("c2", "read_many", BIG),
		];
		expect(pruneStaleReads(messages)).toBe(messages);
	});

	// --- grep_many: batch content tool with dir scope ---

	it("stubs a grep_many result when a file in any search scope is later edited", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "grep_many", {
				searches: [
					{ pattern: "foo", path: "/src" },
					{ pattern: "bar", path: "/lib" },
				],
			}),
			toolResult("c1", "grep_many", BIG),
			assistantCall("c2", "edit", { path: "/src/a.ts" }),
			mutationResult("c2", "edit"),
		];
		const result = pruneStaleReads(messages);
		expect(resultText(result[1])).toContain("Stale grep result omitted");
	});

	it("stubs a grep_many result when a file in the second search scope is edited", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "grep_many", {
				searches: [
					{ pattern: "foo", path: "/src" },
					{ pattern: "bar", path: "/lib" },
				],
			}),
			toolResult("c1", "grep_many", BIG),
			assistantCall("c2", "edit", { path: "/lib/b.ts" }),
			mutationResult("c2", "edit"),
		];
		const result = pruneStaleReads(messages);
		expect(resultText(result[1])).toContain("Stale grep result omitted");
	});

	it("does not stub a grep_many result when a different directory is edited", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "grep_many", { searches: [{ pattern: "foo", path: "/src" }] }),
			toolResult("c1", "grep_many", BIG),
			assistantCall("c2", "edit", { path: "/other/a.ts" }),
			mutationResult("c2", "edit"),
		];
		expect(pruneStaleReads(messages)).toBe(messages);
	});

	it("stubs a pathless grep_many result when cwd is provided", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "grep_many", { searches: [{ pattern: "foo" }] }),
			toolResult("c1", "grep_many", BIG),
			assistantCall("c2", "edit", { path: "/proj/src/a.ts" }),
			mutationResult("c2", "edit"),
		];
		const result = pruneStaleReads(messages, "/proj");
		expect(resultText(result[1])).toContain("Stale grep result omitted");
	});

	it("stubs a grep_many single-search shorthand result", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "grep_many", { pattern: "foo", path: "/src" }),
			toolResult("c1", "grep_many", BIG),
			assistantCall("c2", "edit", { path: "/src/a.ts" }),
			mutationResult("c2", "edit"),
		];
		const result = pruneStaleReads(messages);
		expect(resultText(result[1])).toContain("Stale grep result omitted");
	});

	// --- ls_many: batch structure tool ---

	it("stubs an ls_many result when a file in any listed directory is later written", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "ls_many", { paths: ["/src", "/lib"] }),
			toolResult("c1", "ls_many", BIG),
			assistantCall("c2", "write", { path: "/src/new.ts", content: "x" }),
			mutationResult("c2", "write"),
		];
		const result = pruneStaleReads(messages);
		expect(resultText(result[1])).toContain("Stale ls result omitted");
	});

	it("does NOT stub an ls_many result when a file in the directory is edited (content-only)", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "ls_many", { paths: ["/src", "/lib"] }),
			toolResult("c1", "ls_many", BIG),
			assistantCall("c2", "edit", { path: "/src/a.ts" }),
			mutationResult("c2", "edit"),
		];
		expect(pruneStaleReads(messages)).toBe(messages);
	});

	it("does not stub an ls_many result when a different directory is written", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "ls_many", { paths: ["/src"] }),
			toolResult("c1", "ls_many", BIG),
			assistantCall("c2", "write", { path: "/other/new.ts", content: "x" }),
			mutationResult("c2", "write"),
		];
		expect(pruneStaleReads(messages)).toBe(messages);
	});

	// --- cross-tool: read_many + grep_many stale, ls_many NOT stale on edit ---

	it("stubs read_many and grep_many but NOT ls_many when a file is edited", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "read_many", { files: [{ path: "/src/a.ts" }] }),
			toolResult("c1", "read_many", BIG),
			assistantCall("c2", "grep_many", { searches: [{ pattern: "foo", path: "/src" }] }),
			toolResult("c2", "grep_many", BIG),
			assistantCall("c3", "ls_many", { paths: ["/src"] }),
			toolResult("c3", "ls_many", BIG),
			assistantCall("c4", "edit", { path: "/src/a.ts" }),
			mutationResult("c4", "edit"),
		];
		const result = pruneStaleReads(messages);
		// Content tools → stale on edit
		expect(resultText(result[1])).toContain("Stale read omitted");
		expect(resultText(result[3])).toContain("Stale grep result omitted");
		// Structure tool → NOT stale on edit
		expect(resultText(result[5])).toBe(BIG);
	});

	// --- error results ---

	it("does not stub an error grep result", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "grep", { pattern: "foo", path: "/a.ts" }),
			toolResult("c1", "grep", BIG, true),
			assistantCall("c2", "edit", { path: "/a.ts" }),
			mutationResult("c2", "edit"),
		];
		const result = pruneStaleReads(messages);
		expect(resultText(result[1])).toBe(BIG);
	});

	it("does not stub an error bash cat result", () => {
		const messages: AgentMessage[] = [
			assistantCall("c1", "bash", { command: "cat /a.ts" }),
			toolResult("c1", "bash", BIG, true),
			assistantCall("c2", "edit", { path: "/a.ts" }),
			mutationResult("c2", "edit"),
		];
		const result = pruneStaleReads(messages);
		expect(resultText(result[1])).toBe(BIG);
	});
});

// ============================================================================
// pruneThinkingForNonAnthropic
// ============================================================================

function assistantWithThinking(thinking: string, text?: string): AssistantMessage {
	const content: Array<{
		type: string;
		thinking?: string;
		text?: string;
		id?: string;
		name?: string;
		arguments?: Record<string, unknown>;
		thinkingSignature?: string;
		redacted?: boolean;
	}> = [];
	if (thinking) content.push({ type: "thinking", thinking });
	if (text) content.push({ type: "text", text });
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	} as AssistantMessage;
}

function getThinkingText(message: AgentMessage): string {
	if (message.role !== "assistant") return "";
	const assistant = message as AssistantMessage;
	return assistant.content
		.filter((b): b is { type: "text"; text: string } => b.type === "text")
		.map((b) => b.text)
		.join("");
}

describe("pruneThinkingForNonAnthropic", () => {
	it("returns original messages for Anthropic provider", () => {
		const messages: AgentMessage[] = [
			assistantWithThinking("I need to think about this carefully...", "Here is my answer"),
		];
		expect(pruneThinkingForNonAnthropic(messages, "anthropic")).toBe(messages);
	});

	it("strips thinking blocks for non-Anthropic provider", () => {
		const messages: AgentMessage[] = [
			assistantWithThinking("I need to think about this carefully...", "Here is my answer"),
		];
		const result = pruneThinkingForNonAnthropic(messages, "openai");
		expect(result).not.toBe(messages);
		const text = getThinkingText(result[0]);
		expect(text).toContain("[Thinking:");
		expect(text).toContain("Here is my answer");
	});

	it("truncates long thinking to 100 chars", () => {
		const longThinking = "x".repeat(500);
		const messages: AgentMessage[] = [assistantWithThinking(longThinking, "answer")];
		const result = pruneThinkingForNonAnthropic(messages, "openai");
		const text = getThinkingText(result[0]);
		expect(text).toContain("[Thinking:");
		expect(text).toContain("chars of thinking omitted");
		// The summary should be much shorter than the original
		expect(text.length).toBeLessThan(longThinking.length);
	});

	it("preserves short thinking in full", () => {
		const shortThinking = "Quick thought";
		const messages: AgentMessage[] = [assistantWithThinking(shortThinking, "answer")];
		const result = pruneThinkingForNonAnthropic(messages, "openai");
		const text = getThinkingText(result[0]);
		expect(text).toContain(shortThinking);
		expect(text).not.toContain("chars of thinking omitted");
	});

	it("returns original array when no thinking blocks exist", () => {
		const messages: AgentMessage[] = [assistantWithThinking("", "Just a text response")];
		expect(pruneThinkingForNonAnthropic(messages, "openai")).toBe(messages);
	});

	it("handles multiple thinking blocks in one message", () => {
		const messages: AgentMessage[] = [
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "First thought" },
					{ type: "text", text: "Partial answer" },
					{ type: "thinking", thinking: "Second thought" },
					{ type: "text", text: "Final answer" },
				],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 0,
			} as AssistantMessage,
		];
		const result = pruneThinkingForNonAnthropic(messages, "openai");
		const assistant = result[0] as AssistantMessage;
		const thinkingBlocks = assistant.content.filter((b) => b.type === "thinking");
		expect(thinkingBlocks.length).toBe(0);
		const textBlocks = assistant.content.filter((b) => b.type === "text");
		expect(textBlocks.length).toBe(4); // 2 summaries + 2 original texts
	});

	it("preserves thinking blocks with thinkingSignature", () => {
		const messages: AgentMessage[] = [
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "x".repeat(500), thinkingSignature: "sig-123" },
					{ type: "text", text: "answer" },
				],
				api: "openai-responses",
				provider: "openai",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 0,
			} as AssistantMessage,
		];
		const result = pruneThinkingForNonAnthropic(messages, "openai");
		const assistant = result[0] as AssistantMessage;
		// Thinking block with signature should be preserved, not replaced
		const thinkingBlocks = assistant.content.filter((b) => b.type === "thinking");
		expect(thinkingBlocks.length).toBe(1);
		expect((thinkingBlocks[0] as { thinkingSignature?: string }).thinkingSignature).toBe("sig-123");
	});

	it("preserves redacted thinking blocks", () => {
		const messages: AgentMessage[] = [
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "", redacted: true, thinkingSignature: "redacted-sig" },
					{ type: "text", text: "answer" },
				],
				api: "openai-responses",
				provider: "openai",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 0,
			} as AssistantMessage,
		];
		const result = pruneThinkingForNonAnthropic(messages, "openai");
		const assistant = result[0] as AssistantMessage;
		const thinkingBlocks = assistant.content.filter((b) => b.type === "thinking");
		expect(thinkingBlocks.length).toBe(1);
		expect((thinkingBlocks[0] as { redacted?: boolean }).redacted).toBe(true);
	});
});
