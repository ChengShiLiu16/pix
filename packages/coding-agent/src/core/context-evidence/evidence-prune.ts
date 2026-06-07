import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

export interface EvidencePruneLimits {
	maxFiles: number;
	maxBytes: number;
	protectWindowMs: number;
	extension?: string;
}

interface EvidenceFile {
	path: string;
	size: number;
	mtimeMs: number;
	protected: boolean;
}

async function listEvidenceFiles(dir: string, limits: EvidencePruneLimits): Promise<EvidenceFile[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	const now = Date.now();
	const files: EvidenceFile[] = [];
	const extension = limits.extension ?? ".txt";

	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(extension)) continue;
		const path = join(dir, entry.name);
		const fileStat = await stat(path);
		files.push({
			path,
			size: fileStat.size,
			mtimeMs: fileStat.mtimeMs,
			protected: now - fileStat.mtimeMs <= limits.protectWindowMs,
		});
	}

	files.sort((a, b) => a.mtimeMs - b.mtimeMs);
	return files;
}

export async function pruneEvidenceFiles(dir: string, limits: EvidencePruneLimits): Promise<void> {
	try {
		const files = await listEvidenceFiles(dir, limits);
		const candidates = files.filter((file) => !file.protected);
		let candidateBytes = candidates.reduce((sum, file) => sum + file.size, 0);
		if (candidates.length <= limits.maxFiles && candidateBytes <= limits.maxBytes) return;

		// candidates are oldest-first. Phase 1 enforces the record-count cap by
		// evicting the oldest down to 80% of maxFiles; phase 2 then evicts more
		// oldest files (skipping those already removed) until the byte budget holds.
		const keepCount = Math.ceil(limits.maxFiles * 0.8);
		const targetRemoveCount = Math.max(0, candidates.length - keepCount);
		let removed = 0;
		const removedPaths = new Set<string>();
		for (const file of candidates) {
			if (removed >= targetRemoveCount) break;
			await rm(file.path, { force: true });
			removedPaths.add(file.path);
			candidateBytes -= file.size;
			removed++;
		}

		for (const file of candidates) {
			if (candidateBytes <= limits.maxBytes) break;
			if (removedPaths.has(file.path)) continue;
			await rm(file.path, { force: true });
			candidateBytes -= file.size;
		}
	} catch {
		// Evidence cleanup is best-effort.
	}
}
