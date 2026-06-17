import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
	captureWorkspaceSnapshot,
	isRestorableWorkspaceSnapshot,
	restoreWorkspaceSnapshot,
} from "../src/core/workspace-snapshot.ts";

const execFileAsync = promisify(execFile);

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pix-workspace-snapshot-"));
	tempDirs.push(dir);
	return dir;
}

/** Base dir under which capture creates per-workspace shadow git repos (kept outside any worktree). */
async function createSnapshotBaseDir(): Promise<string> {
	return join(await createTempDir(), "snapshots");
}

async function initGitRepo(cwd: string): Promise<void> {
	await execFileAsync("git", ["init", "--quiet"], { cwd });
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("workspace snapshot (git shadow)", () => {
	it("reverts modified/deleted tracked files and removes files created after the snapshot", async () => {
		const cwd = await createTempDir();
		const baseDir = await createSnapshotBaseDir();
		await initGitRepo(cwd);
		await mkdir(join(cwd, "src"));
		await writeFile(join(cwd, "src", "file.txt"), "before\n", "utf8");
		await writeFile(join(cwd, "keep.txt"), "keep\n", "utf8");

		const snapshot = await captureWorkspaceSnapshot(cwd, baseDir);
		expect(isRestorableWorkspaceSnapshot(snapshot)).toBe(true);

		await writeFile(join(cwd, "src", "file.txt"), "after\n", "utf8"); // modify
		await rm(join(cwd, "keep.txt")); // delete
		await mkdir(join(cwd, "new-dir"));
		await writeFile(join(cwd, "new-dir", "new.txt"), "new\n", "utf8"); // create

		await restoreWorkspaceSnapshot(snapshot);

		await expect(readFile(join(cwd, "src", "file.txt"), "utf8")).resolves.toBe("before\n");
		await expect(readFile(join(cwd, "keep.txt"), "utf8")).resolves.toBe("keep\n");
		await expect(readFile(join(cwd, "new-dir", "new.txt"), "utf8")).rejects.toThrow();
	});

	it("leaves .gitignored paths untouched (not snapshotted, not removed) — the node_modules guard", async () => {
		const cwd = await createTempDir();
		const baseDir = await createSnapshotBaseDir();
		await initGitRepo(cwd);
		await writeFile(join(cwd, ".gitignore"), "ignored/\nnode_modules/\n", "utf8");
		await writeFile(join(cwd, "tracked.txt"), "before\n", "utf8");
		await mkdir(join(cwd, "ignored"));
		await writeFile(join(cwd, "ignored", "cache.txt"), "cache\n", "utf8");
		await mkdir(join(cwd, "node_modules"));
		await writeFile(join(cwd, "node_modules", "dep.js"), "dep\n", "utf8");

		const snapshot = await captureWorkspaceSnapshot(cwd, baseDir);

		await writeFile(join(cwd, "tracked.txt"), "after\n", "utf8");
		await writeFile(join(cwd, "ignored", "cache.txt"), "changed\n", "utf8");

		await restoreWorkspaceSnapshot(snapshot);

		// Tracked file reverted; ignored paths preserved exactly as they were left.
		await expect(readFile(join(cwd, "tracked.txt"), "utf8")).resolves.toBe("before\n");
		await expect(readFile(join(cwd, "ignored", "cache.txt"), "utf8")).resolves.toBe("changed\n");
		await expect(readFile(join(cwd, "node_modules", "dep.js"), "utf8")).resolves.toBe("dep\n");
	});

	it("disables snapshots in a non-git workspace (restore is a no-op)", async () => {
		const cwd = await createTempDir();
		const baseDir = await createSnapshotBaseDir();
		await writeFile(join(cwd, "file.txt"), "before\n", "utf8");

		const snapshot = await captureWorkspaceSnapshot(cwd, baseDir);
		expect(isRestorableWorkspaceSnapshot(snapshot)).toBe(false);

		await writeFile(join(cwd, "file.txt"), "after\n", "utf8");
		const result = await restoreWorkspaceSnapshot(snapshot);

		expect(result).toEqual({ restoredFiles: 0, restoredSymlinks: 0, removedPaths: 0 });
		await expect(readFile(join(cwd, "file.txt"), "utf8")).resolves.toBe("after\n");
	});

	// Regression: launching pix from a subdirectory must anchor the shadow worktree at the git
	// toplevel so the repo-root .gitignore is honored. Otherwise node_modules (ignored only at the
	// root) gets snapshotted, and a later revert's `git clean -fd` deletes deps installed afterwards.
	it("honors the repo-root .gitignore when captured from a subdirectory (monorepo node_modules guard)", async () => {
		const repo = await createTempDir();
		const baseDir = await createSnapshotBaseDir();
		await initGitRepo(repo);
		await writeFile(join(repo, ".gitignore"), "node_modules/\n", "utf8");
		const sub = join(repo, "packages", "app");
		await mkdir(sub, { recursive: true });
		await writeFile(join(sub, "index.ts"), "before\n", "utf8");
		await mkdir(join(sub, "node_modules"));
		await writeFile(join(sub, "node_modules", "dep.js"), "dep\n", "utf8");

		// Capture from the SUBDIRECTORY, not the repo root.
		const snapshot = await captureWorkspaceSnapshot(sub, baseDir);
		expect(isRestorableWorkspaceSnapshot(snapshot)).toBe(true);

		await writeFile(join(sub, "index.ts"), "after\n", "utf8"); // modify a tracked file
		await writeFile(join(sub, "node_modules", "added-after.js"), "new\n", "utf8"); // "install" a new dep

		await restoreWorkspaceSnapshot(snapshot);

		// Tracked file reverted; ignored node_modules left fully intact (not snapshotted, not cleaned).
		await expect(readFile(join(sub, "index.ts"), "utf8")).resolves.toBe("before\n");
		await expect(readFile(join(sub, "node_modules", "dep.js"), "utf8")).resolves.toBe("dep\n");
		await expect(readFile(join(sub, "node_modules", "added-after.js"), "utf8")).resolves.toBe("new\n");
	});

	// Regression: when the snapshot tree was reclaimed by git gc, restore must fail loudly and must
	// NOT mutate the worktree (no destructive `git clean` after a failed `read-tree`).
	it("throws and leaves the worktree untouched when the snapshot tree is gone", async () => {
		const cwd = await createTempDir();
		const baseDir = await createSnapshotBaseDir();
		await initGitRepo(cwd);
		await writeFile(join(cwd, "f.txt"), "v1\n", "utf8");

		const snapshot = await captureWorkspaceSnapshot(cwd, baseDir);
		if (snapshot.version !== 2) throw new Error("expected a git-shadow snapshot");
		const missingTree = { ...snapshot, tree: "0".repeat(40) };

		await writeFile(join(cwd, "f.txt"), "v2\n", "utf8");
		await writeFile(join(cwd, "after.txt"), "untracked\n", "utf8");

		await expect(restoreWorkspaceSnapshot(missingTree)).rejects.toThrow();
		// Nothing should have been reverted or removed.
		await expect(readFile(join(cwd, "f.txt"), "utf8")).resolves.toBe("v2\n");
		await expect(readFile(join(cwd, "after.txt"), "utf8")).resolves.toBe("untracked\n");
	});
});
