import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, type Stats } from "node:fs";
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

/** Legacy file-copy snapshot (still restorable for sessions created before the git-shadow rewrite). */
interface WorkspaceSnapshotDetailsV1 {
	version: 1;
	id: string;
	cwd: string;
	mode: SnapshotMode;
	rootPath: string;
	manifestPath: string;
	capturedAt: string;
}

/** Git-shadow snapshot: a dangling tree object in a per-workspace shadow git repo. */
interface WorkspaceSnapshotDetailsV2 {
	version: 2;
	/** The cwd the snapshot was captured from (informational; may be a subdirectory of the repo). */
	cwd: string;
	/** Git toplevel used as the shadow worktree for capture/restore (honors the repo-root .gitignore). */
	worktree: string;
	/** Absolute path to the per-repo shadow git dir that holds the snapshot objects. */
	gitdir: string;
	/** git tree hash for this snapshot; null when snapshots are unavailable (non-git workspace). */
	tree: string | null;
	capturedAt: string;
}

export type WorkspaceSnapshotDetails = WorkspaceSnapshotDetailsV1 | WorkspaceSnapshotDetailsV2;

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

function runGit(args: string[], opts?: { cwd?: string; env?: Record<string, string> }): Promise<{ code: number }> {
	return new Promise((resolvePromise) => {
		execFile(
			"git",
			args,
			{
				encoding: "utf8",
				maxBuffer: 64 * 1024 * 1024,
				cwd: opts?.cwd,
				env: opts?.env ? { ...process.env, ...opts.env } : process.env,
			},
			(error) => {
				const code = (error as (NodeJS.ErrnoException & { code?: number }) | null)?.code;
				resolvePromise({ code: error ? (typeof code === "number" ? code : 1) : 0 });
			},
		);
	});
}

interface ShadowGitResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** Run a shadow-git command (git dir separate from the worktree), returning exit code + output. */
function execShadowGitResult(gitdir: string, worktree: string, args: string[]): Promise<ShadowGitResult> {
	return new Promise((resolvePromise) => {
		execFile(
			"git",
			["--git-dir", gitdir, "--work-tree", worktree, ...args],
			{ encoding: "utf8", maxBuffer: 64 * 1024 * 1024, cwd: worktree },
			(error, stdout, stderr) => {
				const code = (error as (NodeJS.ErrnoException & { code?: number }) | null)?.code;
				resolvePromise({
					code: error ? (typeof code === "number" ? code : 1) : 0,
					stdout: stdout ?? "",
					stderr: stderr ?? "",
				});
			},
		);
	});
}

/** Run a shadow-git command, returning stdout or undefined on failure (best-effort callers). */
async function execShadowGit(gitdir: string, worktree: string, args: string[]): Promise<string | undefined> {
	const result = await execShadowGitResult(gitdir, worktree, args);
	return result.code === 0 ? result.stdout : undefined;
}

const SHADOW_GIT_LOCK_RETRIES = 5;
const SHADOW_GIT_LOCK_DELAY_MS = 60;

function delay(ms: number): Promise<void> {
	return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/** index.lock / ref-lock contention from a concurrent pix session sharing this per-repo shadow git. */
function isGitLockError(stderr: string): boolean {
	return /\.lock|another git process seems to be running/i.test(stderr);
}

/** Like execShadowGitResult, but retries briefly on lock contention (shared shadow repo, concurrent sessions). */
async function execShadowGitWithLockRetry(gitdir: string, worktree: string, args: string[]): Promise<ShadowGitResult> {
	let result = await execShadowGitResult(gitdir, worktree, args);
	for (
		let attempt = 1;
		attempt < SHADOW_GIT_LOCK_RETRIES && result.code !== 0 && isGitLockError(result.stderr);
		attempt++
	) {
		await delay(SHADOW_GIT_LOCK_DELAY_MS);
		result = await execShadowGitResult(gitdir, worktree, args);
	}
	return result;
}

/** Resolve the git worktree root (toplevel) for a cwd, or undefined for a non-git workspace. */
async function resolveGitWorkTreeRoot(cwd: string): Promise<string | undefined> {
	const out = await execGit(cwd, ["rev-parse", "--show-toplevel"]);
	const root = out?.trim();
	return root ? resolvePath(root) : undefined;
}

/** Initialize the shadow git repo (idempotent). The git dir lives outside the worktree, so it is never snapshotted. */
async function ensureShadowGit(gitdir: string, worktree: string): Promise<void> {
	if (existsSync(join(gitdir, "HEAD"))) return;
	await mkdir(gitdir, { recursive: true });
	await runGit(["init", "--quiet"], { cwd: worktree, env: { GIT_DIR: gitdir, GIT_WORK_TREE: worktree } });
	const config: Array<[string, string]> = [
		["core.autocrlf", "false"],
		["core.longpaths", "true"],
		["core.symlinks", "true"],
		["core.fsmonitor", "false"],
	];
	for (const [key, value] of config) {
		await runGit(["--git-dir", gitdir, "config", key, value]);
	}
}

/** Stable per-repo shadow git dir under baseDir, keyed by the git toplevel so all sessions of the same repo share one object store. */
function workspaceShadowGitDir(baseDir: string, worktreeRoot: string): string {
	const key = createHash("sha256").update(resolvePath(worktreeRoot)).digest("hex").slice(0, 16);
	return join(resolvePath(baseDir), key);
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
	baseDirInput: string,
): Promise<WorkspaceSnapshotDetails> {
	const cwd = resolvePath(cwdInput);
	const baseDir = resolvePath(baseDirInput);
	const capturedAt = new Date().toISOString();

	// opencode parity: snapshots are git-only and span the whole repository. Anchor the shadow
	// worktree at the git toplevel (not cwd) so the repo-root .gitignore is honored even when pix
	// is launched from a subdirectory — otherwise node_modules etc. would be snapshotted and a
	// later revert's `git clean` would delete them.
	const worktree = await resolveGitWorkTreeRoot(cwd);
	if (!worktree) {
		// Non-git workspace: record a placeholder (tree: null); restore is a no-op.
		return { version: 2, cwd, worktree: cwd, gitdir: workspaceShadowGitDir(baseDir, cwd), tree: null, capturedAt };
	}
	// Key the shadow repo by the toplevel so all sessions of the same repo share one object store.
	const gitdir = workspaceShadowGitDir(baseDir, worktree);

	try {
		await ensureShadowGit(gitdir, worktree);
		// `add --all` stages the whole worktree into the shadow index. It honors the worktree's
		// .gitignore (so node_modules etc. stay out) and never adds the real .git directory.
		const added = await execShadowGitWithLockRetry(gitdir, worktree, ["add", "--all"]);
		if (added.code !== 0) {
			return { version: 2, cwd, worktree, gitdir, tree: null, capturedAt };
		}
		const written = await execShadowGitWithLockRetry(gitdir, worktree, ["write-tree"]);
		const tree = written.code === 0 ? written.stdout.trim() : "";
		return { version: 2, cwd, worktree, gitdir, tree: tree || null, capturedAt };
	} catch {
		return { version: 2, cwd, worktree, gitdir, tree: null, capturedAt };
	}
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
	const snapshot = value as {
		version?: unknown;
		cwd?: unknown;
		worktree?: unknown;
		gitdir?: unknown;
		rootPath?: unknown;
		manifestPath?: unknown;
	};
	if (snapshot.version === 2) {
		return (
			typeof snapshot.cwd === "string" &&
			typeof snapshot.worktree === "string" &&
			typeof snapshot.gitdir === "string"
		);
	}
	return (
		snapshot.version === 1 &&
		typeof snapshot.cwd === "string" &&
		typeof snapshot.rootPath === "string" &&
		typeof snapshot.manifestPath === "string"
	);
}

/** Whether a snapshot can actually restore the workspace (false for non-git placeholders). */
export function isRestorableWorkspaceSnapshot(details: WorkspaceSnapshotDetails): boolean {
	return details.version === 2 ? details.tree !== null : true;
}

/** Run git gc on the shadow repo to bound disk usage. Dangling snapshot trees older than the prune window are reclaimed. */
export async function gcWorkspaceShadowGit(gitdir: string): Promise<void> {
	const resolved = resolvePath(gitdir);
	if (!existsSync(join(resolved, "HEAD"))) return;
	await runGit(["--git-dir", resolved, "gc", "--prune=7.days", "--quiet"]);
}

export async function addPathToWorkspaceSnapshot(details: WorkspaceSnapshotDetails, pathInput: string): Promise<void> {
	// v2 (git shadow) captures the entire worktree at snapshot time, so per-file bookkeeping is
	// unnecessary. Out-of-worktree targets are intentionally not tracked (matches opencode).
	if (details.version === 2) return;
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

async function restoreGitShadowSnapshot(details: WorkspaceSnapshotDetailsV2): Promise<WorkspaceRestoreResult> {
	if (!details.tree) {
		return { restoredFiles: 0, restoredSymlinks: 0, removedPaths: 0 };
	}
	const worktree = resolvePath(details.worktree);
	const gitdir = resolvePath(details.gitdir);
	const splitLines = (value: string | undefined): string[] =>
		value
			?.split("\n")
			.map((line) => line.trim())
			.filter(Boolean) ?? [];

	// Fail loudly if the snapshot tree is gone (e.g. reclaimed by `git gc`). We must NOT run a
	// destructive `git clean` against a stale index when we cannot actually restore the tree.
	if ((await execShadowGit(gitdir, worktree, ["cat-file", "-e", `${details.tree}^{tree}`])) === undefined) {
		throw new Error(
			`Workspace snapshot ${details.tree} is no longer available (it may have been garbage-collected).`,
		);
	}

	// Best-effort "changed" count, gathered before mutating the worktree.
	const changed = splitLines(await execShadowGit(gitdir, worktree, ["diff", "--name-only", details.tree, "--"]));

	// Reset tracked files to the snapshot tree (restores them and removes tracked files that did not
	// exist in the snapshot). Only proceed to clean if this succeeds, otherwise we would delete
	// post-snapshot files without having restored anything.
	const readTree = await execShadowGitWithLockRetry(gitdir, worktree, ["read-tree", "--reset", "-u", details.tree]);
	if (readTree.code !== 0) {
		throw new Error(`Failed to restore workspace snapshot: ${readTree.stderr.trim() || "git read-tree failed"}`);
	}

	// Count, then drop, files created after the snapshot. `-fd` (without `-x`) preserves gitignored
	// paths (node_modules etc.). Counting after read-tree reflects exactly what clean will remove.
	const removable = splitLines(await execShadowGit(gitdir, worktree, ["clean", "-nd"]));
	const cleaned = await execShadowGitWithLockRetry(gitdir, worktree, ["clean", "-fd"]);
	if (cleaned.code !== 0) {
		throw new Error(`Failed to clean workspace after restore: ${cleaned.stderr.trim() || "git clean failed"}`);
	}

	return { restoredFiles: changed.length, restoredSymlinks: 0, removedPaths: removable.length };
}

export async function restoreWorkspaceSnapshot(details: WorkspaceSnapshotDetails): Promise<WorkspaceRestoreResult> {
	if (details.version === 2) {
		return restoreGitShadowSnapshot(details);
	}
	return restoreFilesystemSnapshot(details);
}

async function restoreFilesystemSnapshot(details: WorkspaceSnapshotDetailsV1): Promise<WorkspaceRestoreResult> {
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
