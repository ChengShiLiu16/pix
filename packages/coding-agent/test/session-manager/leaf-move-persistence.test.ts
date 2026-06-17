import { mkdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

/**
 * Regression coverage for durable revert navigation.
 *
 * A plain tree branch only moves the in-memory leaf pointer, so a reload resets
 * the head to the last entry. Revert restores the workspace, so its leaf MUST
 * survive a reload (otherwise the on-disk files and the session head diverge).
 * recordLeafMove() persists a leaf_move marker for exactly this case.
 */
describe("SessionManager leaf_move persistence", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `leaf-move-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	/** Append a user+assistant exchange. The assistant message flushes the session to disk. */
	function appendExchange(session: SessionManager, text: string): void {
		session.appendMessage({ role: "user", content: text, timestamp: Date.now() });
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: `reply to ${text}` }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
	}

	function seedSession(): { file: string; firstUserId: string } {
		const session = SessionManager.create(tempDir, tempDir);
		appendExchange(session, "m1");
		appendExchange(session, "m2");
		const file = session.getSessionFile();
		if (!file) throw new Error("expected persisted session file");
		const firstUserId = session.getEntries()[0].id;
		return { file, firstUserId };
	}

	it("restores the recorded leaf after reload (revert survives restart)", () => {
		const { file, firstUserId } = seedSession();

		// Revert-style navigation: move the head back to the first user message and persist it.
		const live = SessionManager.open(file, tempDir);
		expect(live.getEntries()[live.getEntries().length - 1].id).toBe(live.getLeafId()); // head at latest pre-revert
		live.recordLeafMove(firstUserId);
		expect(live.getLeafId()).toBe(firstUserId);

		// Reload from disk: the head must still be at the reverted position, not the last entry.
		const reloaded = SessionManager.open(file, tempDir);
		expect(reloaded.getLeafId()).toBe(firstUserId);
		expect(reloaded.buildSessionContext().messages).toEqual([
			{ role: "user", content: "m1", timestamp: expect.any(Number) },
		]);
	});

	it("keeps the marker out of getEntries() and getTree()", () => {
		const { file, firstUserId } = seedSession();
		const live = SessionManager.open(file, tempDir);
		const entryCountBefore = live.getEntries().length;
		live.recordLeafMove(firstUserId);

		const reloaded = SessionManager.open(file, tempDir);
		// Marker is file-level metadata: it is persisted but never surfaces as a conversation entry.
		expect(reloaded.getEntries()).toHaveLength(entryCountBefore);
		expect(reloaded.getEntries().some((e) => (e as { type: string }).type === "leaf_move")).toBe(false);
		const treeTypes: string[] = [];
		const stack = [...reloaded.getTree()];
		while (stack.length) {
			const node = stack.pop()!;
			treeTypes.push(node.entry.type);
			stack.push(...node.children);
		}
		expect(treeTypes).not.toContain("leaf_move");

		// But it IS on disk.
		const rawLines = readFileSync(file, "utf-8").trim().split("\n");
		expect(rawLines.some((line) => JSON.parse(line).type === "leaf_move")).toBe(true);
	});

	it("does NOT persist a plain branch (tree browsing stays ephemeral)", () => {
		const { file, firstUserId } = seedSession();

		const live = SessionManager.open(file, tempDir);
		const lastId = live.getLeafId();
		live.branch(firstUserId); // ephemeral move, no marker
		expect(live.getLeafId()).toBe(firstUserId);

		// Reload: a plain branch leaves no trace, so the head resets to the latest entry.
		const reloaded = SessionManager.open(file, tempDir);
		expect(reloaded.getLeafId()).toBe(lastId);
	});

	it("persists a revert-to-root (leaf before the first entry)", () => {
		const { file } = seedSession();

		const live = SessionManager.open(file, tempDir);
		live.recordLeafMove(null);
		expect(live.getLeafId()).toBeNull();

		const reloaded = SessionManager.open(file, tempDir);
		expect(reloaded.getLeafId()).toBeNull();
		expect(reloaded.buildSessionContext().messages).toEqual([]);
	});
});
