import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
	addPathToWorkspaceSnapshot,
	captureWorkspaceSnapshot,
	restoreWorkspaceSnapshot,
} from "../src/core/workspace-snapshot.ts";

const execFileAsync = promisify(execFile);

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pix-workspace-snapshot-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("workspace snapshot", () => {
	it("restores files, symlinks, deletions, and added paths", async () => {
		const cwd = await createTempDir();
		const snapshotRoot = join(cwd, ".snapshots");
		await mkdir(join(cwd, "src"));
		await writeFile(join(cwd, "src", "file.txt"), "before\n", "utf8");
		await writeFile(join(cwd, "target.txt"), "target\n", "utf8");
		await symlink("target.txt", join(cwd, "link.txt"));

		const snapshot = await captureWorkspaceSnapshot(cwd, snapshotRoot);

		await writeFile(join(cwd, "src", "file.txt"), "after\n", "utf8");
		await rm(join(cwd, "target.txt"));
		await rm(join(cwd, "link.txt"));
		await mkdir(join(cwd, "new-dir"));
		await writeFile(join(cwd, "new-dir", "new.txt"), "new\n", "utf8");

		const result = await restoreWorkspaceSnapshot(snapshot);

		expect(result.restoredFiles).toBe(2);
		expect(result.restoredSymlinks).toBe(1);
		expect(result.removedPaths).toBeGreaterThan(0);
		await expect(readFile(join(cwd, "src", "file.txt"), "utf8")).resolves.toBe("before\n");
		await expect(readFile(join(cwd, "target.txt"), "utf8")).resolves.toBe("target\n");
		await expect(readFile(join(cwd, "link.txt"), "utf8")).resolves.toBe("target\n");
		await expect(readFile(join(cwd, "new-dir", "new.txt"), "utf8")).rejects.toThrow();
	});

	it("uses git-visible files and skips ignored paths", async () => {
		const cwd = await createTempDir();
		const snapshotRoot = join(cwd, ".snapshots");
		await execFileAsync("git", ["init"], { cwd });
		await writeFile(join(cwd, ".gitignore"), "ignored/\n", "utf8");
		await writeFile(join(cwd, "tracked.txt"), "before\n", "utf8");
		await execFileAsync("git", ["add", ".gitignore", "tracked.txt"], { cwd });
		await mkdir(join(cwd, "ignored"));
		await writeFile(join(cwd, "ignored", "cache.txt"), "cache\n", "utf8");

		const snapshot = await captureWorkspaceSnapshot(cwd, snapshotRoot);
		const manifest = JSON.parse(await readFile(snapshot.manifestPath, "utf8")) as {
			files: Array<{ path: string; storagePath: string }>;
		};
		const trackedSnapshot = manifest.files.find((file) => file.path === "tracked.txt");
		expect(trackedSnapshot).toBeDefined();
		await expect(readFile(join(snapshot.rootPath, trackedSnapshot!.storagePath), "utf8")).resolves.toBe("before\n");

		await writeFile(join(cwd, "tracked.txt"), "after\n", "utf8");
		await writeFile(join(cwd, "ignored", "cache.txt"), "changed\n", "utf8");

		await restoreWorkspaceSnapshot(snapshot);

		expect(snapshot.mode).toBe("git");
		await expect(readFile(join(cwd, "tracked.txt"), "utf8")).resolves.toBe("before\n");
		await expect(readFile(join(cwd, "ignored", "cache.txt"), "utf8")).resolves.toBe("changed\n");
	});

	it("restores added tool target paths outside the cwd snapshot", async () => {
		const cwd = await createTempDir();
		const externalDir = await createTempDir();
		const externalFile = join(externalDir, "config.json");
		await writeFile(externalFile, "before\n", "utf8");

		const snapshot = await captureWorkspaceSnapshot(cwd, join(cwd, ".snapshots"));
		await addPathToWorkspaceSnapshot(snapshot, externalFile);

		await writeFile(externalFile, "after\n", "utf8");
		await restoreWorkspaceSnapshot(snapshot);

		await expect(readFile(externalFile, "utf8")).resolves.toBe("before\n");
	});

	it("removes tool-created paths that did not exist before", async () => {
		const cwd = await createTempDir();
		const externalDir = await createTempDir();
		const externalFile = join(externalDir, "created.json");

		const snapshot = await captureWorkspaceSnapshot(cwd, join(cwd, ".snapshots"));
		await addPathToWorkspaceSnapshot(snapshot, externalFile);

		await writeFile(externalFile, "created\n", "utf8");
		await restoreWorkspaceSnapshot(snapshot);

		await expect(readFile(externalFile, "utf8")).rejects.toThrow();
	});
});
