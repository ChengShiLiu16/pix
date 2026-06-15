import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
	chmod,
	copyFile,
	lstat,
	mkdir,
	readdir,
	readFile,
	readlink,
	realpath,
	rm,
	rmdir,
	symlink,
	writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { canonicalizePath, normalizePath, resolvePath } from "../utils/paths.ts";

export const WORKSPACE_SNAPSHOT_CUSTOM_TYPE = "workspace_snapshot";

type SnapshotMode = "filesystem" | "git";

interface SnapshotFileRecord {
	type: "file";
	path: string;
	absolutePath?: string;
	mode: number;
	storagePath: string;
}

interface SnapshotSymlinkRecord {
	type: "symlink";
	path: string;
	absolutePath?: string;
	target: string;
}

interface SnapshotDirRecord {
	type: "directory";
	path: string;
	absolutePath?: string;
	mode: number;
}

interface SnapshotMissingRecord {
	type: "missing";
	path: string;
	absolutePath?: string;
}

interface WorkspaceSnapshotManifest {
	version: 1;
	cwd: string;
	mode: SnapshotMode;
	files: SnapshotFileRecord[];
	symlinks: SnapshotSymlinkRecord[];
	directories: SnapshotDirRecord[];
	missing?: SnapshotMissingRecord[];
}

export interface WorkspaceSnapshotDetails {
	version: 1;
	id: string;
	cwd: string;
	mode: SnapshotMode;
	rootPath: string;
	manifestPath: string;
	capturedAt: string;
}

export interface WorkspaceRestoreResult {
	restoredFiles: number;
	restoredSymlinks: number;
	removedPaths: number;
}

type WorkspacePath = {
	absPath: string;
	relPath: string;
};

function execGit(cwd: string, args: string[]): Promise<string | undefined> {
	return new Promise((resolvePromise) => {
		execFile("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
			resolvePromise(error ? undefined : stdout);
		});
	});
}

function isInsidePath(childPath: string, parentPath: string): boolean {
	const isInsideResolved = (child: string, parent: string): boolean => {
		const rel = relative(parent, child);
		return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
	};
	const child = resolvePath(childPath);
	const parent = resolvePath(parentPath);
	if (isInsideResolved(child, parent)) return true;
	return isInsideResolved(canonicalizePath(child), canonicalizePath(parent));
}

function toStoredPath(path: string): string {
	return path.split(sep).join("/");
}

function fromStoredPath(path: string): string {
	return path.split("/").join(sep);
}

function safeJoin(root: string, storedPath: string): string {
	const target = resolve(root, fromStoredPath(storedPath));
	if (!isInsidePath(target, root)) {
		throw new Error(`Invalid snapshot path: ${storedPath}`);
	}
	return target;
}

function snapshotPathKey(record: { path: string; absolutePath?: string }): string {
	return record.absolutePath ? `abs:${resolvePath(record.absolutePath)}` : `cwd:${record.path}`;
}

function getRecordPath(cwd: string, record: { path: string; absolutePath?: string }): string {
	return record.absolutePath ? resolvePath(record.absolutePath) : safeJoin(cwd, record.path);
}

function relativeToCwd(absPath: string, cwd: string): string | undefined {
	const isOutside = (path: string): boolean => path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path);
	const resolvedAbsPath = resolvePath(absPath);
	const resolvedCwd = resolvePath(cwd);
	let relPath = relative(resolvedCwd, resolvedAbsPath);
	if (isOutside(relPath)) {
		relPath = relative(canonicalizePath(resolvedCwd), canonicalizePath(resolvedAbsPath));
	}
	if (isOutside(relPath)) return undefined;
	return relPath ? toStoredPath(relPath) : undefined;
}

async function collectFilesystemPaths(cwd: string, snapshotRoot: string): Promise<WorkspacePath[]> {
	const paths: WorkspacePath[] = [];
	const stack = [cwd];

	while (stack.length > 0) {
		const current = stack.pop()!;
		let entries: string[];
		try {
			entries = await readdir(current);
		} catch {
			continue;
		}

		for (const entry of entries) {
			const absPath = join(current, entry);
			if (entry === ".git" || isInsidePath(absPath, snapshotRoot)) continue;

			const relPath = relativeToCwd(absPath, cwd);
			if (!relPath) continue;

			let stat: Stats;
			try {
				stat = await lstat(absPath);
			} catch {
				continue;
			}

			paths.push({ absPath, relPath });
			if (stat.isDirectory()) {
				stack.push(absPath);
			}
		}
	}

	return paths;
}

async function collectGitPaths(cwd: string, snapshotRoot: string): Promise<WorkspacePath[] | undefined> {
	const rootOutput = await execGit(cwd, ["rev-parse", "--show-toplevel"]);
	if (!rootOutput) return undefined;

	const gitRoot = resolvePath(rootOutput.trim());
	const output = await execGit(cwd, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--full-name"]);
	if (output === undefined) return undefined;

	const paths: WorkspacePath[] = [];
	const seen = new Set<string>();
	for (const gitPath of output.split("\0")) {
		if (!gitPath) continue;
		const absPath = resolve(gitRoot, fromStoredPath(gitPath));
		if (isInsidePath(absPath, snapshotRoot)) continue;
		const relPath = relativeToCwd(absPath, cwd);
		if (!relPath || seen.has(relPath)) continue;
		seen.add(relPath);
		paths.push({ absPath, relPath });
	}

	return paths;
}

async function collectSnapshotPaths(cwd: string, snapshotRoot: string, mode: SnapshotMode): Promise<WorkspacePath[]> {
	if (mode === "git") {
		const gitPaths = await collectGitPaths(cwd, snapshotRoot);
		if (gitPaths !== undefined) return gitPaths;
	}
	return collectFilesystemPaths(cwd, snapshotRoot);
}

function snapshotFileStoragePath(snapshotDir: string, relPath: string): { absPath: string; storedPath: string } {
	const hash = createHash("sha256").update(relPath).digest("hex");
	const storedPath = `files/${hash}`;
	return { absPath: join(snapshotDir, "files", hash), storedPath };
}

async function recreateDirectory(absPath: string, mode: number): Promise<void> {
	try {
		const stat = await lstat(absPath);
		if (!stat.isDirectory()) {
			await rm(absPath, { force: true, recursive: true });
		}
	} catch {}
	await mkdir(absPath, { recursive: true });
	await chmod(absPath, mode);
}

export async function captureWorkspaceSnapshot(
	cwdInput: string,
	snapshotRootInput: string,
): Promise<WorkspaceSnapshotDetails> {
	const cwd = resolvePath(cwdInput);
	const snapshotRoot = resolvePath(snapshotRootInput);
	const id = randomUUID();
	const snapshotDir = join(snapshotRoot, id);
	await mkdir(join(snapshotDir, "files"), { recursive: true });

	const gitPaths = await collectGitPaths(cwd, snapshotRoot);
	const mode: SnapshotMode = gitPaths ? "git" : "filesystem";
	const paths = gitPaths ?? (await collectFilesystemPaths(cwd, snapshotRoot));

	const manifest: WorkspaceSnapshotManifest = {
		version: 1,
		cwd,
		mode,
		files: [],
		symlinks: [],
		directories: [],
		missing: [],
	};

	for (const path of paths) {
		let stat: Stats;
		try {
			stat = await lstat(path.absPath);
		} catch {
			continue;
		}

		if (stat.isDirectory()) {
			manifest.directories.push({ type: "directory", path: path.relPath, mode: stat.mode & 0o777 });
			continue;
		}

		if (stat.isSymbolicLink()) {
			manifest.symlinks.push({ type: "symlink", path: path.relPath, target: await readlink(path.absPath) });
			continue;
		}

		if (!stat.isFile()) continue;

		const storagePath = snapshotFileStoragePath(snapshotDir, path.relPath);
		await copyFile(path.absPath, storagePath.absPath);
		manifest.files.push({
			type: "file",
			path: path.relPath,
			mode: stat.mode & 0o777,
			storagePath: storagePath.storedPath,
		});
	}

	const manifestPath = join(snapshotDir, "manifest.json");
	await writeFile(manifestPath, JSON.stringify(manifest), "utf8");

	return {
		version: 1,
		id,
		cwd,
		mode,
		rootPath: snapshotDir,
		manifestPath,
		capturedAt: new Date().toISOString(),
	};
}

async function readManifest(path: string): Promise<WorkspaceSnapshotManifest> {
	return parseManifest(await readFile(path, "utf8"));
}

async function writeManifest(path: string, manifest: WorkspaceSnapshotManifest): Promise<void> {
	await writeFile(path, JSON.stringify(manifest), "utf8");
}

function parseManifest(raw: string): WorkspaceSnapshotManifest {
	const value = JSON.parse(raw) as WorkspaceSnapshotManifest;
	if (value.version !== 1 || typeof value.cwd !== "string" || !Array.isArray(value.files)) {
		throw new Error("Invalid workspace snapshot manifest.");
	}
	return value;
}

export function isWorkspaceSnapshotDetails(value: unknown): value is WorkspaceSnapshotDetails {
	if (!value || typeof value !== "object") return false;
	const snapshot = value as WorkspaceSnapshotDetails;
	return (
		snapshot.version === 1 &&
		typeof snapshot.cwd === "string" &&
		typeof snapshot.rootPath === "string" &&
		typeof snapshot.manifestPath === "string"
	);
}

export async function addPathToWorkspaceSnapshot(details: WorkspaceSnapshotDetails, pathInput: string): Promise<void> {
	const manifest = await readManifest(details.manifestPath);
	const absolutePath = resolvePath(pathInput);
	const cwdPath = relativeToCwd(absolutePath, manifest.cwd);
	const recordPath = cwdPath ?? toStoredPath(absolutePath);
	const absoluteRecordPath = cwdPath ? undefined : absolutePath;
	const key = snapshotPathKey({ path: recordPath, absolutePath: absoluteRecordPath });
	const existing = [
		...manifest.files,
		...manifest.symlinks,
		...manifest.directories,
		...(manifest.missing ?? []),
	].some((record) => snapshotPathKey(record) === key);
	if (existing) return;

	let stat: Stats;
	try {
		stat = await lstat(absolutePath);
	} catch {
		manifest.missing ??= [];
		manifest.missing.push({ type: "missing", path: recordPath, absolutePath: absoluteRecordPath });
		await writeManifest(details.manifestPath, manifest);
		return;
	}

	if (stat.isDirectory()) {
		manifest.directories.push({
			type: "directory",
			path: recordPath,
			absolutePath: absoluteRecordPath,
			mode: stat.mode & 0o777,
		});
	} else if (stat.isSymbolicLink()) {
		manifest.symlinks.push({
			type: "symlink",
			path: recordPath,
			absolutePath: absoluteRecordPath,
			target: await readlink(absolutePath),
		});
		await writeManifest(details.manifestPath, manifest);
		try {
			await addPathToWorkspaceSnapshot(details, await realpath(absolutePath));
		} catch {}
		return;
	} else if (stat.isFile()) {
		const storagePath = snapshotFileStoragePath(details.rootPath, key);
		await copyFile(absolutePath, storagePath.absPath);
		manifest.files.push({
			type: "file",
			path: recordPath,
			absolutePath: absoluteRecordPath,
			mode: stat.mode & 0o777,
			storagePath: storagePath.storedPath,
		});
	}

	await writeManifest(details.manifestPath, manifest);
}

export async function restoreWorkspaceSnapshot(details: WorkspaceSnapshotDetails): Promise<WorkspaceRestoreResult> {
	const manifest = await readManifest(details.manifestPath);
	const cwd = normalizePath(manifest.cwd);
	const snapshotRoot = normalizePath(details.rootPath);
	const snapshotStorageRoot = dirname(snapshotRoot);
	const currentPaths = await collectSnapshotPaths(cwd, snapshotStorageRoot, manifest.mode);
	const desiredFiles = new Set(manifest.files.filter((file) => !file.absolutePath).map((file) => file.path));
	const desiredSymlinks = new Set(manifest.symlinks.filter((link) => !link.absolutePath).map((link) => link.path));
	const desiredDirectories = new Set(
		manifest.directories.filter((directory) => !directory.absolutePath).map((directory) => directory.path),
	);
	let removedPaths = 0;

	for (const current of currentPaths.sort((a, b) => b.relPath.length - a.relPath.length)) {
		if (
			desiredFiles.has(current.relPath) ||
			desiredSymlinks.has(current.relPath) ||
			desiredDirectories.has(current.relPath)
		) {
			continue;
		}
		await rm(current.absPath, { force: true, recursive: true });
		removedPaths++;
	}

	for (const directory of manifest.directories.sort((a, b) => a.path.length - b.path.length)) {
		const absPath = getRecordPath(cwd, directory);
		await recreateDirectory(absPath, directory.mode);
	}

	let restoredFiles = 0;
	for (const file of manifest.files) {
		const absPath = getRecordPath(cwd, file);
		await rm(absPath, { force: true, recursive: true });
		await mkdir(dirname(absPath), { recursive: true });
		await copyFile(safeJoin(details.rootPath, file.storagePath), absPath);
		await chmod(absPath, file.mode);
		restoredFiles++;
	}

	let restoredSymlinks = 0;
	for (const link of manifest.symlinks) {
		const absPath = getRecordPath(cwd, link);
		await rm(absPath, { force: true, recursive: true });
		await mkdir(dirname(absPath), { recursive: true });
		await symlink(link.target, absPath);
		restoredSymlinks++;
	}

	for (const missing of manifest.missing ?? []) {
		await rm(getRecordPath(cwd, missing), { force: true, recursive: true });
		removedPaths++;
	}

	for (const current of currentPaths.sort((a, b) => b.relPath.length - a.relPath.length)) {
		if (desiredDirectories.has(current.relPath)) continue;
		try {
			await rmdir(current.absPath);
		} catch {}
	}

	return { restoredFiles, restoredSymlinks, removedPaths };
}
