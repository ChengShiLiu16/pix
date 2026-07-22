/**
 * S3 probe: workspace_snapshot custom entries on the default SessionManager path
 * (JSONL / in-memory tree) can be found via navigateTree semantics and restored.
 *
 * Does not require a live model — exercises the storage + restore hook only.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { Message } from "@chengshiliu16/pix-ai/compat";
import { SessionManager } from "../src/core/session-manager.ts";
import {
	captureWorkspaceSnapshot,
	isRestorableWorkspaceSnapshot,
	isWorkspaceSnapshotDetails,
	restoreWorkspaceSnapshot,
	WORKSPACE_SNAPSHOT_CUSTOM_TYPE,
	type WorkspaceSnapshotDetails,
} from "../src/core/workspace-snapshot.ts";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pix-snapshot-session-"));
	tempDirs.push(dir);
	return dir;
}

async function initGitRepo(cwd: string): Promise<void> {
	await execFileAsync("git", ["init", "--quiet"], { cwd });
	await execFileAsync("git", ["config", "user.email", "pix@test"], { cwd });
	await execFileAsync("git", ["config", "user.name", "pix"], { cwd });
}

/**
 * Mirrors AgentSession._restoreWorkspaceSnapshotForLeaf after navigateTree
 * sets newLeafId to the parent of a user message (the snapshot custom entry).
 */
async function restoreFromLeafId(
	sessionManager: SessionManager,
	leafId: string | null,
): Promise<{ restoredFiles: number } | undefined> {
	if (!leafId) return undefined;
	const entry = sessionManager.getEntry(leafId);
	if (entry?.type !== "custom" || entry.customType !== WORKSPACE_SNAPSHOT_CUSTOM_TYPE) {
		return undefined;
	}
	if (!isWorkspaceSnapshotDetails(entry.data) || !isRestorableWorkspaceSnapshot(entry.data)) {
		return undefined;
	}
	return restoreWorkspaceSnapshot(entry.data);
}

function userMessage(text: string): Message {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("workspace snapshot session path (S3 probe)", () => {
	it("links workspace_snapshot as the parent of the user message entry", async () => {
		const cwd = await createTempDir();
		const baseDir = join(await createTempDir(), "snapshots");
		await initGitRepo(cwd);
		await writeFile(join(cwd, "a.txt"), "v1\n");
		await execFileAsync("git", ["add", "a.txt"], { cwd });
		await execFileAsync("git", ["commit", "-m", "init", "--quiet"], { cwd });

		const sessionManager = SessionManager.inMemory(cwd);
		const snapshot = await captureWorkspaceSnapshot(cwd, baseDir);
		expect(isRestorableWorkspaceSnapshot(snapshot)).toBe(true);

		const snapId = sessionManager.appendCustomEntry(WORKSPACE_SNAPSHOT_CUSTOM_TYPE, snapshot);
		const userId = sessionManager.appendMessage(userMessage("edit a.txt"));

		const userEntry = sessionManager.getEntry(userId);
		expect(userEntry?.type).toBe("message");
		expect(userEntry?.parentId).toBe(snapId);

		const snapEntry = sessionManager.getEntry(snapId);
		expect(snapEntry?.type).toBe("custom");
		expect(snapEntry?.customType).toBe(WORKSPACE_SNAPSHOT_CUSTOM_TYPE);
	});

	it("restores the workspace when navigateTree would set leaf to the snapshot parent", async () => {
		const cwd = await createTempDir();
		const baseDir = join(await createTempDir(), "snapshots");
		await initGitRepo(cwd);
		await writeFile(join(cwd, "a.txt"), "before\n");
		await execFileAsync("git", ["add", "a.txt"], { cwd });
		await execFileAsync("git", ["commit", "-m", "init", "--quiet"], { cwd });

		const sessionManager = SessionManager.inMemory(cwd);
		const snapshot = await captureWorkspaceSnapshot(cwd, baseDir);
		const snapId = sessionManager.appendCustomEntry(WORKSPACE_SNAPSHOT_CUSTOM_TYPE, snapshot);
		const userId = sessionManager.appendMessage(userMessage("change workspace"));

		// Mutate after capture (as the agent would)
		await writeFile(join(cwd, "a.txt"), "after\n");
		await writeFile(join(cwd, "new.txt"), "created\n");

		// navigateTree(userMessage): newLeafId = parentId
		const userEntry = sessionManager.getEntry(userId)!;
		const newLeafId = userEntry.parentId;
		expect(newLeafId).toBe(snapId);

		const result = await restoreFromLeafId(sessionManager, newLeafId);
		expect(result).toBeDefined();
		expect(result!.restoredFiles).toBeGreaterThan(0);

		expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("before\n");
	});

	it("round-trips snapshot details through JSONL SessionManager open", async () => {
		const cwd = await createTempDir();
		const sessionDir = await createTempDir();
		const baseDir = join(await createTempDir(), "snapshots");
		await initGitRepo(cwd);
		await writeFile(join(cwd, "tracked.txt"), "snap-content\n");
		await execFileAsync("git", ["add", "tracked.txt"], { cwd });
		await execFileAsync("git", ["commit", "-m", "init", "--quiet"], { cwd });

		const writer = SessionManager.create(cwd, sessionDir);
		const snapshot = await captureWorkspaceSnapshot(cwd, baseDir);
		const snapId = writer.appendCustomEntry(WORKSPACE_SNAPSHOT_CUSTOM_TYPE, snapshot);
		const userId = writer.appendMessage(userMessage("hello"));
		// Force a second message so the session file is flushed (writer waits for assistant
		// before first flush in some paths — append an assistant to flush).
		writer.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "openai-completions",
			provider: "test",
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
			timestamp: Date.now(),
		} as Message);

		const sessionFile = writer.getSessionFile();
		expect(sessionFile).toBeTruthy();

		await writeFile(join(cwd, "tracked.txt"), "mutated\n");

		const reader = SessionManager.open(sessionFile!, sessionDir, cwd);
		const userEntry = reader.getEntry(userId);
		expect(userEntry?.parentId).toBe(snapId);

		const result = await restoreFromLeafId(reader, userEntry!.parentId);
		expect(result).toBeDefined();
		expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe("snap-content\n");

		// Data shape still validates after JSONL round-trip
		const snapEntry = reader.getEntry(snapId);
		expect(snapEntry?.type).toBe("custom");
		expect(isWorkspaceSnapshotDetails((snapEntry as { data?: unknown }).data)).toBe(true);
		expect(isRestorableWorkspaceSnapshot((snapEntry as { data: WorkspaceSnapshotDetails }).data)).toBe(true);
	});
});
