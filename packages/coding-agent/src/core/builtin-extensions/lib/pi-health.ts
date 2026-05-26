import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export type HealthLevel = "ok" | "warn" | "error";

export interface HealthItem {
	level: HealthLevel;
	label: string;
	detail: string;
}

export interface HealthReport {
	agentRoot: string;
	items: HealthItem[];
}

const SKIP_DIRS = new Set(["auth.json", "sessions", "node_modules"]);

function existsFile(filePath: string): boolean {
	try {
		return existsSync(filePath) && statSync(filePath).isFile();
	} catch {
		return false;
	}
}

function existsDir(dirPath: string): boolean {
	try {
		return existsSync(dirPath) && statSync(dirPath).isDirectory();
	} catch {
		return false;
	}
}

function readJson(filePath: string): Record<string, unknown> | undefined {
	try {
		return JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

function listDirs(dirPath: string, prefix: string): string[] {
	if (!existsDir(dirPath)) return [];
	return readdirSync(dirPath)
		.filter((name) => name.startsWith(prefix))
		.filter((name) => existsDir(path.join(dirPath, name)))
		.sort();
}

function containsTsFiles(dirPath: string): boolean {
	if (!existsDir(dirPath)) return false;
	for (const name of readdirSync(dirPath)) {
		if (SKIP_DIRS.has(name)) continue;
		const fullPath = path.join(dirPath, name);
		const stat = statSync(fullPath);
		if (stat.isFile() && name.endsWith(".ts")) return true;
		if (stat.isDirectory() && containsTsFiles(fullPath)) return true;
	}
	return false;
}

function pushExists(items: HealthItem[], filePath: string, label: string): void {
	items.push({
		level: existsFile(filePath) ? "ok" : "error",
		label,
		detail: filePath,
	});
}

export function collectPiHealth(agentRoot: string): HealthReport {
	const items: HealthItem[] = [];
	const extensionsDir = path.join(agentRoot, "extensions");
	const thinkingDir = path.join(extensionsDir, "pi-thinking-steps");
	const thinkingPackagePath = path.join(thinkingDir, "package.json");

	pushExists(items, path.join(agentRoot, "settings.json"), "agent settings");
	pushExists(items, path.join(agentRoot, "models.json"), "custom models");
	pushExists(items, path.join(extensionsDir, "lib", "tsconfig.test.json"), "extension lib test tsconfig");
	pushExists(items, path.join(thinkingDir, "tsconfig.json"), "thinking-steps tsconfig");
	pushExists(items, path.join(thinkingDir, "test", "thinking-steps.test.ts"), "thinking-steps unit test");
	pushExists(items, path.join(thinkingDir, "test", "summarizer-challenger.test.ts"), "thinking-steps summarizer test");

	const pkg = readJson(thinkingPackagePath);
	if (pkg) {
		const scripts = typeof pkg.scripts === "object" && pkg.scripts ? (pkg.scripts as Record<string, unknown>) : {};
		items.push({
			level: typeof scripts.build === "string" && typeof scripts.test === "string" ? "ok" : "warn",
			label: "thinking-steps package scripts",
			detail: `${thinkingPackagePath} build=${String(scripts.build ?? "missing")} test=${String(scripts.test ?? "missing")}`,
		});
	} else {
		items.push({
			level: "error",
			label: "thinking-steps package",
			detail: `${thinkingPackagePath} missing or invalid`,
		});
	}

	const backupDirs = [...listDirs(extensionsDir, ".backup-"), ...listDirs(extensionsDir, ".revert-")];
	if (backupDirs.length === 0) {
		items.push({
			level: "ok",
			label: "extension backup/revert dirs",
			detail: "none under active extensions directory",
		});
	} else {
		const risky = backupDirs.filter((name) => containsTsFiles(path.join(extensionsDir, name)));
		items.push({
			level: risky.length > 0 ? "warn" : "ok",
			label: "extension backup/revert dirs",
			detail:
				risky.length > 0
					? `${risky.length}/${backupDirs.length} contain .ts files: ${risky.slice(0, 8).join(", ")}${risky.length > 8 ? ", ..." : ""}`
					: `${backupDirs.length} dirs without .ts files`,
		});
	}

	const archiveDir = path.join(path.dirname(agentRoot), "agent-extension-archives");
	const archived = existsDir(archiveDir)
		? readdirSync(archiveDir).filter((name) => name.startsWith(".backup-") || name.startsWith(".revert-")).length
		: 0;
	items.push({
		level: archived > 0 ? "ok" : "warn",
		label: "extension archive directory",
		detail: archived > 0 ? `${archiveDir} (${archived} archived dirs)` : `${archiveDir} missing or empty`,
	});

	return { agentRoot, items };
}

export function formatPiHealth(report: HealthReport): string {
	const icon: Record<HealthLevel, string> = { ok: "✓", warn: "!", error: "✗" };
	const lines = [`Pi health · ${report.agentRoot}`];
	for (const item of report.items) {
		lines.push(`${icon[item.level]} ${item.label}: ${item.detail}`);
	}
	return lines.join("\n");
}
