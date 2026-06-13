import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHistoryStore } from "../src/modes/interactive/components/custom-editor.ts";

describe("persistent input history store", () => {
	let dir: string;
	let historyPath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pix-history-"));
		historyPath = join(dir, "input-history.json");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function fileEntries(): string[] {
		return JSON.parse(readFileSync(historyPath, "utf8")).entries;
	}

	it("records a new entry at the front", () => {
		const store = createHistoryStore(historyPath);
		store.record("hello", []);
		expect(fileEntries()).toEqual(["hello"]);
		store.record("world", []);
		expect(fileEntries()).toEqual(["world", "hello"]);
	});

	it("does not lose entries written by another session between records", () => {
		// Two stores point at the same shared file, mimicking two sessions /
		// processes. Each starts from the same on-disk state.
		const sessionA = createHistoryStore(historyPath);
		const sessionB = createHistoryStore(historyPath);

		sessionA.record("from A", []);
		// B records *after* A wrote the file. B must merge A's entry, not clobber it.
		sessionB.record("from B", []);

		const entries = fileEntries();
		expect(entries).toContain("from A");
		expect(entries).toContain("from B");

		// Now A records again. Without a fresh read, A's stale snapshot would
		// overwrite the file and drop "from B" — the reported data-loss bug.
		sessionA.record("from A again", []);

		const after = fileEntries();
		expect(after).toContain("from A");
		expect(after).toContain("from B");
		expect(after).toContain("from A again");
		expect(after[0]).toBe("from A again");
	});

	it("load() reflects entries written by other sessions", () => {
		const sessionA = createHistoryStore(historyPath);
		const sessionB = createHistoryStore(historyPath);

		sessionA.record("a1", []);
		// B should see A's entry on a fresh load, even though B existed before it.
		expect(sessionB.load()).toContain("a1");
	});

	it("deduplicates entries on record", () => {
		const store = createHistoryStore(historyPath);
		store.record("dup", []);
		store.record("dup", []);
		expect(fileEntries()).toEqual(["dup"]);
	});
});
