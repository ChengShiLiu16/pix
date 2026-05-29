#!/usr/bin/env node
/**
 * Extract thinking blocks around blind-scatter read operations.
 *
 * For sessions flagged with high scatter (M2), this extracts the thinking
 * content that immediately precedes each scatter read, helping a human
 * analyst classify whether the model was:
 *   A) hunting for a KNOWN symbol (should have used grep instead)
 *   B) exploring an UNKNOWN file (outline/overview would help)
 *   C) verifying after edit (edit feedback would eliminate the need)
 *
 * Usage:
 *   node scripts/extract-scatter-thinking.mjs --session <path> [--file <name>]
 *
 * Example:
 *   node scripts/extract-scatter-thinking.mjs \
 *     --session ~/.pix/agent/sessions/2026-05-27T11-40-56-666Z_019e6/session.jsonl \
 *     --file markdownToDocx.ts
 *
 * Output: per-file scatter blocks with surrounding thinking excerpts.
 */

import { createReadStream } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
	const o = { sessionFile: undefined, fileFilter: undefined, contextTurns: 1 };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--session") o.sessionFile = argv[++i];
		else if (a === "--file") o.fileFilter = argv[++i];
		else if (a === "--context") o.contextTurns = Number(argv[++i]) || 1;
		else if (a === "--help" || a === "-h") o.help = true;
	}
	return o;
}

// ---------------------------------------------------------------------------
// session parsing
// ---------------------------------------------------------------------------

function textOfContent(content) {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		let s = "";
		for (const b of content) {
			if (b && typeof b === "object" && b.type === "text" && typeof b.text === "string") s += b.text;
		}
		return s;
	}
	return "";
}

function getPath(args) {
	const p = args?.path ?? args?.file_path ?? args?.filePath;
	return typeof p === "string" && p.length > 0 ? p : undefined;
}

function readManyFiles(args) {
	const out = [];
	if (Array.isArray(args?.files)) {
		for (const f of args.files) {
			if (f && typeof f === "object" && typeof f.path === "string") out.push({ path: f.path, offset: f.offset, limit: f.limit });
		}
	} else if (Array.isArray(args?.paths)) {
		for (const p of args.paths) if (typeof p === "string") out.push({ path: p, offset: args.offset, limit: args.limit });
	}
	return out;
}

async function parseSession(file) {
	const session = {
		file,
		events: [], // ordered events with turn index
	};
	let turnIdx = 0;
	const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
	for await (const line of rl) {
		const t = line.trim();
		if (!t) continue;
		let o;
		try {
			o = JSON.parse(t);
		} catch {
			continue;
		}
		if (o.type === "model_change") {
			session.model = `${o.provider}/${o.modelId}`;
			continue;
		}
		if (o.type !== "message") continue;
		const m = o.message;
		if (!m) continue;
		if (m.role === "assistant") {
			const c = m.content;
			if (Array.isArray(c)) {
				let hasToolCall = false;
				let thinkingText = "";
				for (const b of c) {
					if (!b || typeof b !== "object") continue;
					if (b.type === "toolCall") {
						hasToolCall = true;
						const p = getPath(b.arguments);
						if (b.name === "read") {
							session.events.push({
								turn: turnIdx,
								kind: "call",
								name: "read",
								path: p,
								offset: b.arguments?.offset,
								limit: b.arguments?.limit,
								thinkingBefore: thinkingText,
							});
						} else if (b.name === "read_many") {
							const files = readManyFiles(b.arguments);
							for (const f of files) {
								session.events.push({
									turn: turnIdx,
									kind: "call",
									name: "read_many",
									path: f.path,
									offset: f.offset,
									limit: f.limit,
									thinkingBefore: thinkingText,
								});
							}
						}
						thinkingText = ""; // reset after each tool call
					} else if (b.type === "thinking") {
						thinkingText += (b.thinking || "");
					} else if (b.type === "text") {
						// text between thinking and tool calls; reset thinking if no tool call follows
						thinkingText = "";
					}
				}
				// Also track edits to determine exploration vs. verification
				for (const b of c) {
					if (b && typeof b === "object" && b.type === "toolCall" && b.name === "edit") {
						session.events.push({
							turn: turnIdx,
							kind: "edit",
							path: getPath(b.arguments),
						});
					}
				}
			}
			turnIdx++;
		}
	}
	return session;
}

// ---------------------------------------------------------------------------
// scatter detection
// ---------------------------------------------------------------------------

function findScatterFiles(session) {
	const readsByFile = new Map(); // path -> [{turn, offset, limit, thinkingBefore}]
	const editTurnByFile = new Map(); // path -> first edit turn

	for (const e of session.events) {
		if (e.kind === "edit" && e.path) {
			if (!editTurnByFile.has(e.path)) editTurnByFile.set(e.path, e.turn);
		}
		if ((e.kind === "call" && e.name === "read") || e.name === "read_many") {
			if (!e.path) continue;
			const arr = readsByFile.get(e.path) ?? [];
			arr.push(e);
			readsByFile.set(e.path, arr);
		}
	}

	const scatter = [];
	for (const [filePath, reads] of readsByFile) {
		if (reads.length < 3) continue;
		// Count direction reversals
		let reversals = 0;
		let prevDir = 0;
		for (let i = 1; i < reads.length; i++) {
			const d = Math.sign((reads[i].offset || 1) - (reads[i - 1].offset || 1));
			if (d !== 0 && prevDir !== 0 && d !== prevDir) reversals++;
			if (d !== 0) prevDir = d;
		}
		if (reversals >= 2) {
			scatter.push({
				file: filePath,
				reads,
				reversals,
				firstEditTurn: editTurnByFile.get(filePath),
			});
		}
	}
	return scatter;
}

// ---------------------------------------------------------------------------
// output
// ---------------------------------------------------------------------------

function printScatterAnalysis(scatter, fileFilter) {
	for (const s of scatter) {
		const fileName = path.basename(s.file);
		if (fileFilter && !fileName.includes(fileFilter)) continue;

		const editNote = s.firstEditTurn != null
			? `first edit at turn ${s.firstEditTurn}`
			: "no edit in session";

		console.log(`\n======================================================================`);
		console.log(`FILE: ${s.file}`);
		console.log(`       ${s.reads.length} reads, ${s.reversals} reversals, ${editNote}`);
		console.log(`======================================================================`);

		for (const r of s.reads) {
			const offsetStr = r.offset ? `offset=${r.offset}` : "";
			const limitStr = r.limit ? ` lim=${r.limit}` : "";
			const beforeEdit = s.firstEditTurn != null && r.turn < s.firstEditTurn;
			const afterEdit = s.firstEditTurn != null && r.turn >= s.firstEditTurn;
			const nearbyEdit = afterEdit ? " [AFTER-EDIT]" : beforeEdit ? " [PRE-EDIT]" : "";
			console.log(`\n--- turn ${r.turn} | read off=${r.offset || 1}${limitStr}${nearbyEdit} ---`);

			const thinking = r.thinkingBefore?.trim();
			if (thinking) {
				// Truncate long thinking blocks for readability
				const lines = thinking.split("\n");
				let displayed = thinking;
				if (lines.length > 12) {
					displayed = lines.slice(0, 10).join("\n") + `\n   ... (${lines.length - 10} more lines)`;
				}
				// Cap at 2000 chars
				if (displayed.length > 2000) {
					displayed = displayed.slice(0, 1997) + "...";
				}
				console.log(`  ${displayed}`);
			} else {
				console.log("  (no thinking captured before this read)");
			}
		}
	}
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	if (opts.help || !opts.sessionFile) {
		console.log(`Extract thinking content around scatter read operations.

Usage:
  node scripts/extract-scatter-thinking.mjs --session <jsonl> [options]

Options:
  --session <path>     Path to session JSONL file
  --file <name>        Filter to files whose name contains this text
  --context <n>        Turns of context before each scatter read (default: 1)
  --help, -h           Show this help

Example:
  node scripts/extract-scatter-thinking.mjs \\
    --session ~/.pix/agent/sessions/2026-05/session.jsonl \\
    --file markdownToDocx.ts
`);
		return;
	}

	const session = await parseSession(opts.sessionFile);
	console.log(`Model: ${session.model || "?"}`);
	console.log(`Total assistant turns: ${session.events.filter((e) => e.kind === "call" || e.kind === "edit").length}`);

	const scatter = findScatterFiles(session);
	if (scatter.length === 0) {
		console.log("\nNo scatter patterns found in this session.");
		return;
	}

	printScatterAnalysis(scatter, opts.fileFilter || null);
}

main().catch((e) => {
	process.stderr.write(`Error: ${e?.stack || e}\n`);
	process.exit(1);
});
