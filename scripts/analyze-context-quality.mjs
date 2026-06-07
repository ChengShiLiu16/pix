#!/usr/bin/env node
/**
 * Offline context-quality analyzer (Phase 1 of the context-optimization plan).
 *
 * Reads persisted session JSONL files and reports, per session and in
 * aggregate, the three metrics that decide WHERE to spend optimization effort:
 *
 *   M1  token-by-source     — share of context tokens per tool / thinking / text
 *   M2  same-file scatter    — repeated, non-monotonic windowed reads of one file
 *                              (the "hunting" pattern), + exploration reads
 *                              issued before the first edit of a file
 *   M3  re-read overlap       — lines read more than once (the loss-free dedup
 *                              ceiling for readCovers); DIAGNOSTIC, not a gate
 *   + read_many tracking      — batch-read share, files-per-call, batch truncation
 *
 * It NEVER writes anything and does not touch the running agent. Token counts
 * use the same CJK-aware heuristic as the agent, good for relative shares.
 *
 * Usage:
 *   node scripts/analyze-context-quality.mjs [options]
 *     --sessions-dir <dir>     default: ~/.pix/agent/sessions
 *     --cwd-contains <text>    only sessions whose project dir matches (repeatable)
 *     --model-contains <text>  only sessions whose modelId matches
 *     --since <ISO date>       only sessions started on/after this date
 *     --min-turns <n>          skip sessions with fewer assistant turns (default 3)
 *     --top <n>                only the N most recent matching sessions
 *     --per-session            print a block per session (default: aggregate only)
 *     --json                   emit machine-readable JSON instead of text
 */

import { createReadStream, promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_SESSIONS_DIR = path.join(homedir(), ".pix/agent/sessions");
const MODELS_GENERATED_PATH = path.join(REPO_ROOT, "packages/ai/src/models.generated.ts");
const MODELS_CONFIG_PATH = path.join(homedir(), ".pix/agent/models.json");
const AGING_START_TRIGGER = 0.5;
const STALE_PRUNE_TRIGGER = 0.65;
const HEAVY_AGING_TRIGGER = 0.7;

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
	const o = {
		sessionsDir: DEFAULT_SESSIONS_DIR,
		cwdContains: [],
		modelContains: undefined,
		since: undefined,
		minTurns: 3,
		top: undefined,
		perSession: false,
		json: false,
		help: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--help" || a === "-h") o.help = true;
		else if (a === "--sessions-dir") o.sessionsDir = argv[++i];
		else if (a === "--cwd-contains") o.cwdContains.push(argv[++i]);
		else if (a === "--model-contains") o.modelContains = argv[++i];
		else if (a === "--since") o.since = argv[++i];
		else if (a === "--min-turns") o.minTurns = Number(argv[++i]);
		else if (a === "--top") o.top = Number(argv[++i]);
		else if (a === "--per-session") o.perSession = true;
		else if (a === "--json") o.json = true;
	}
	return o;
}

function printHelp() {
	process.stdout.write(
		`analyze-context-quality — offline context-quality baseline\n\n` +
			`  --sessions-dir <dir>     default ~/.pix/agent/sessions\n` +
			`  --cwd-contains <text>    filter by project dir (repeatable)\n` +
			`  --model-contains <text>  filter by modelId\n` +
			`  --since <ISO date>       sessions on/after date\n` +
			`  --min-turns <n>          skip short sessions (default 3)\n` +
			`  --top <n>                only N most recent matching sessions\n` +
			`  --per-session            print one block per session\n` +
			`  --json                   machine-readable output\n`,
	);
}

// ---------------------------------------------------------------------------
// context-window lookup (best-effort; only used for the ratio diagnostic)
// ---------------------------------------------------------------------------

async function loadContextWindows() {
	const windows = { byProviderModel: new Map(), byModelId: new Map(), diagnostics: [] };
	const rememberWindow = (provider, modelId, contextWindow) => {
		if (!provider || !modelId || !Number.isFinite(contextWindow) || contextWindow <= 0) return;
		windows.byProviderModel.set(`${provider}/${modelId}`, contextWindow);
		const prev = windows.byModelId.get(modelId) ?? 0;
		if (contextWindow > prev) windows.byModelId.set(modelId, contextWindow);
	};

	let text = "";
	try {
		text = await fs.readFile(MODELS_GENERATED_PATH, "utf8");
	} catch (error) {
		windows.diagnostics.push(`models.generated.ts not loaded: ${error?.message || error}`);
	}

	const providerRegex = /\n\t"([^"]+)": \{([\s\S]*?\n\t)\},/g;
	let providerMatch;
	while ((providerMatch = providerRegex.exec(text)) !== null) {
		const provider = providerMatch[1];
		const body = providerMatch[2];
		const modelRegex = /\n\t\t"([^"]+)": \{[\s\S]*?contextWindow: (\d+),/g;
		let modelMatch;
		while ((modelMatch = modelRegex.exec(body)) !== null) {
			rememberWindow(provider, modelMatch[1], Number(modelMatch[2]));
		}
	}

	try {
		const config = JSON.parse(await fs.readFile(MODELS_CONFIG_PATH, "utf8"));
		const providers = config?.providers && typeof config.providers === "object" ? config.providers : {};
		for (const [providerName, provider] of Object.entries(providers)) {
			const overrides = provider?.modelOverrides && typeof provider.modelOverrides === "object" ? provider.modelOverrides : {};
			for (const [modelId, override] of Object.entries(overrides)) {
				if (typeof override?.contextWindow === "number") rememberWindow(providerName, modelId, override.contextWindow);
			}
			if (Array.isArray(provider?.models)) {
				for (const model of provider.models) {
					if (typeof model?.id === "string" && typeof model.contextWindow === "number") rememberWindow(providerName, model.id, model.contextWindow);
				}
			}
		}
	} catch (error) {
		windows.diagnostics.push(`models.json not loaded: ${error?.message || error}`);
	}

	return windows;
}

function resolveSessionWindow(windows, session) {
	const provider = session.model?.provider;
	const modelId = session.model?.modelId;
	if (!modelId) return { window: 0, source: "unknown" };

	if (provider) {
		const exact = windows.byProviderModel.get(`${provider}/${modelId}`);
		if (exact) return { window: exact, source: "provider-model" };
	}

	const fallback = windows.byModelId.get(modelId);
	if (fallback) return { window: fallback, source: "model-id-fallback" };

	return { window: 0, source: "unknown" };
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

function countLines(s) {
	if (!s) return 0;
	return s.split("\n").length;
}

/**
 * 估算文本的 token 数量，支持 CJK 字符。
 * 
 * CJK 字符的 token 比率基于实际测试：
 * - 英文/数字/符号：约 4 字符 = 1 token
 * - 中日韩字符：约 1.7 字符 = 1 token
 * 
 * 这个比率来自对 Claude 模型的实验观察，用于相对份额估算。
 * 对于精确计费，应使用 provider 返回的实际 token 数。
 */
function estimateTextTokens(text) {
	let cjk = 0;
	for (const ch of text) {
		const c = ch.codePointAt(0) ?? 0;
		if ((c >= 0x3000 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0xff00 && c <= 0xffef)) {
			cjk++;
		}
	}
	const other = text.length - cjk;
	return Math.ceil(cjk / 1.7 + other / 4);
}

async function parseSession(file) {
	const session = {
		file,
		model: undefined,
		events: [], // ordered: {kind:'call'|'result'|'thinking'|'asstText'|'user', ...}
		usages: [], // per assistant message usage objects
	};
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
			session.model = { provider: o.provider, modelId: o.modelId };
			continue;
		}
		if (o.type !== "message") continue;
		const m = o.message;
		if (!m) continue;
		const role = m.role;
		if (role === "assistant") {
			if (typeof m.provider === "string" && typeof m.model === "string") session.model = { provider: m.provider, modelId: m.model };
			if (m.usage) session.usages.push(m.usage);
			const c = m.content;
			if (Array.isArray(c)) {
				for (const b of c) {
					if (!b || typeof b !== "object") continue;
					if (b.type === "toolCall") {
						session.events.push({ kind: "call", id: b.id, name: b.name, args: b.arguments || {} });
					} else if (b.type === "thinking") {
						const text = b.thinking || "";
						session.events.push({ kind: "thinking", chars: text.length, tokens: estimateTextTokens(text) });
					} else if (b.type === "text") {
						const text = b.text || "";
						session.events.push({ kind: "asstText", chars: text.length, tokens: estimateTextTokens(text) });
					}
				}
			}
		} else if (role === "user") {
			const text = textOfContent(m.content);
			session.events.push({ kind: "user", chars: text.length, tokens: estimateTextTokens(text) });
		} else if (role === "toolResult" || role === "tool") {
			const txt = textOfContent(m.content);
			session.events.push({
				kind: "result",
				id: m.toolCallId,
				name: m.toolName,
				chars: txt.length,
				tokens: estimateTextTokens(txt),
				lines: countLines(txt),
				truncated: /Use offset=|to continue\.\]/.test(txt),
				isError: !!m.isError,
			});
		}
	}
	return session;
}

// ---------------------------------------------------------------------------
// metric computation
// ---------------------------------------------------------------------------

function getPath(args) {
	const p = args.path ?? args.file_path ?? args.filePath;
	return typeof p === "string" && p.length > 0 ? p : undefined;
}

function readManyFiles(args) {
	const out = [];
	if (Array.isArray(args.files)) {
		for (const f of args.files) {
			if (f && typeof f === "object" && typeof f.path === "string") {
				out.push({ path: f.path, offset: f.offset, limit: f.limit });
			}
		}
	} else if (Array.isArray(args.paths)) {
		for (const p of args.paths) if (typeof p === "string") out.push({ path: p, offset: args.offset, limit: args.limit });
	}
	return out;
}

function analyze(session) {
	const callById = new Map();
	for (const e of session.events) if (e.kind === "call") callById.set(e.id, e);

	// M1: chars/tokens by source
	const bySource = {}; // name -> {count, chars, tokens}
	const add = (name, chars, tokens, n = 1) => {
		const e = (bySource[name] ??= { count: 0, chars: 0, tokens: 0 });
		e.count += n;
		e.chars += chars;
		e.tokens += tokens;
	};

	// read pattern tracking
	const readsByFile = new Map(); // path -> [{seq, offset, limit, lines}]
	const editSeqByFile = new Map(); // path -> first edit seq
	let seq = 0;

	// read_many tracking
	const readManyCalls = []; // {files:n, truncated:bool, chars}
	let singleReadChars = 0;
	let readManyChars = 0;
	let readManyTokens = 0;

	for (const e of session.events) {
		if (e.kind === "thinking") add("thinking", e.chars, e.tokens);
		else if (e.kind === "asstText") add("assistant_text", e.chars, e.tokens);
		else if (e.kind === "user") add("user", e.chars, e.tokens);
		else if (e.kind === "call") {
			seq++;
			if (e.name === "edit" || e.name === "write") {
				const p = getPath(e.args);
				if (p && !editSeqByFile.has(p)) editSeqByFile.set(p, seq);
			}
			if (e.name === "read") {
				const p = getPath(e.args);
				if (p) {
					const arr = readsByFile.get(p) ?? [];
					arr.push({ seq, offset: typeof e.args.offset === "number" ? e.args.offset : 1, limit: e.args.limit });
					readsByFile.set(p, arr);
				}
			} else if (e.name === "read_many") {
				const files = readManyFiles(e.args);
				for (const f of files) {
					const p = f.path;
					const arr = readsByFile.get(p) ?? [];
					arr.push({ seq, offset: typeof f.offset === "number" ? f.offset : 1, limit: f.limit });
					readsByFile.set(p, arr);
				}
				readManyCalls.push({ files: files.length, _seq: seq });
			}
		} else if (e.kind === "result") {
			const call = callById.get(e.id);
			const name = e.name || call?.name || "unknown";
			add(name, e.chars, e.tokens);
			if (name === "read") singleReadChars += e.chars;
			if (name === "read_many") {
				readManyChars += e.chars;
				readManyTokens += e.tokens;
				const rc = readManyCalls.find((c) => callById.get(e.id) && c._seq && true && c._truncated === undefined);
				if (rc) rc._truncated = e.truncated;
				// attach result line count to the most recent read entries lacking it is non-trivial;
				// for overlap we use limit when present and fall back to a fixed window.
			}
		}
	}

	// M2: same-file scatter
	let scatterFiles = 0;
	let explorationReads = 0;
	const scatterDetail = [];
	for (const [p, reads] of readsByFile) {
		if (reads.length >= 2) {
			// direction reversals in the offset sequence
			let reversals = 0;
			let prevDir = 0;
			for (let i = 1; i < reads.length; i++) {
				const d = Math.sign(reads[i].offset - reads[i - 1].offset);
				if (d !== 0 && prevDir !== 0 && d !== prevDir) reversals++;
				if (d !== 0) prevDir = d;
			}
			const isScatter = reads.length >= 3 && reversals >= 2;
			if (isScatter) {
				scatterFiles++;
				scatterDetail.push({ path: p, reads: reads.length, reversals });
			}
		}
		// exploration reads issued before the file's first edit
		const editSeq = editSeqByFile.get(p);
		if (editSeq !== undefined) {
			for (const r of reads) if (r.seq < editSeq) explorationReads++;
		}
	}

	// M3: re-read overlap (redundant lines) per file, summed
	let redundantLines = 0;
	let totalReadLines = 0;
	for (const reads of readsByFile.values()) {
		// build coverage counts over a sparse line map
		const cover = new Map(); // line -> count
		for (const r of reads) {
			const start = r.offset || 1;
			// span: prefer explicit limit; otherwise assume a typical window so we
			// do not over-credit whole-file reads. Whole-file (no limit) reads are
			// the strongest readCovers case but we cannot know their length here,
			// so cap the assumed span to keep the ceiling conservative.
			const span = typeof r.limit === "number" ? r.limit : 60;
			for (let ln = start; ln < start + span; ln++) {
				cover.set(ln, (cover.get(ln) || 0) + 1);
			}
		}
		for (const c of cover.values()) {
			totalReadLines += 1;
			if (c >= 2) redundantLines += c - 1;
		}
	}

	// totals
	let totalChars = 0;
	let sourceTotalTokens = 0;
	for (const v of Object.values(bySource)) {
		totalChars += v.chars;
		sourceTotalTokens += v.tokens;
	}

	const readManyFilesCounts = readManyCalls.map((c) => c.files).filter((n) => n > 0);
	const readManyTruncated = readManyCalls.filter((c) => c._truncated).length;

	return {
		bySource,
		totalChars,
		sourceTotalTokens,
		assistantTurns: session.usages.length,
		scatterFiles,
		scatterDetail,
		explorationReads,
		redundantLines,
		totalReadLines,
		singleReadChars,
		readManyChars,
		readManyTokens,
		readManyCalls: readManyCalls.length,
		readManyFilesCounts,
		readManyTruncated,
	};
}

function peakContext(session) {
	let peak = 0;
	for (const u of session.usages) {
		const tot = u.totalTokens || (u.input || 0) + (u.output || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
		if (tot > peak) peak = tot;
	}
	return peak;
}

/**
 * Per-turn token burn and per-turn prompt sizes.
 * Provider usage is per request. Summing it estimates spend/burn, not context growth.
 */
function perTurnTokenBurn(session) {
	const cumulativeBurn = [];
	const deltas = [];
	let cum = 0;
	for (const u of session.usages) {
		const tokens = u.totalTokens || (u.input || 0) + (u.output || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
		cum += tokens;
		cumulativeBurn.push(cum);
		deltas.push(tokens);
	}
	const meanTurnTokens = deltas.length > 0 ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0;
	return { cumulativeBurn, deltas, meanTurnTokens, totalBurnTokens: cum };
}

// ---------------------------------------------------------------------------
// reporting helpers
// ---------------------------------------------------------------------------

function median(arr) {
	if (arr.length === 0) return 0;
	const s = [...arr].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function bar(pct, width = 24) {
	const n = Math.round((pct / 100) * width);
	return "━".repeat(n) + " ".repeat(Math.max(0, width - n));
}

function fmtSourceTable(bySource, totalTokens) {
	const rows = Object.entries(bySource).sort((a, b) => (b[1].tokens ?? b[1].chars / 4) - (a[1].tokens ?? a[1].chars / 4));
	let out = "";
	for (const [name, v] of rows) {
		const tokens = v.tokens ?? v.chars / 4;
		const tok = Math.round(tokens);
		const pct = totalTokens ? (tokens / totalTokens) * 100 : 0;
		out += `    ${name.padEnd(16)}${String(v.count).padStart(5)}  ${String(tok).padStart(8)}t  ${pct.toFixed(1).padStart(5)}%  ${bar(pct)}\n`;
	}
	return out;
}

async function* walkSessions(dir) {
	let entries;
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const e of entries) {
		const full = path.join(dir, e.name);
		if (e.isDirectory()) yield* walkSessions(full);
		else if (e.isFile() && e.name.endsWith(".jsonl")) yield full;
	}
}

function sessionStartMs(file) {
	const m = path.basename(file).match(/^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)/);
	if (!m) return 0;
	return Date.parse(m[1].replace(/-(\d{2})-(\d{2})-(\d{3})Z$/, ":$1:$2.$3Z").replace(/T(\d{2})-(\d{2})/, "T$1:$2"));
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	if (opts.help) {
		printHelp();
		return;
	}
	const windows = await loadContextWindows();

	let files = [];
	for await (const f of walkSessions(opts.sessionsDir)) files.push(f);
	// filters
	if (opts.cwdContains.length) files = files.filter((f) => opts.cwdContains.some((c) => f.includes(c)));
	if (opts.since) {
		const sinceMs = Date.parse(opts.since);
		files = files.filter((f) => sessionStartMs(f) >= sinceMs);
	}
	files.sort((a, b) => sessionStartMs(b) - sessionStartMs(a));

	const perSession = [];
	for (const f of files) {
		const session = await parseSession(f);
		if (opts.modelContains && !(session.model?.modelId || "").includes(opts.modelContains)) continue;
		const a = analyze(session);
		if (a.assistantTurns < opts.minTurns) continue;
		const peak = peakContext(session);
		const resolvedWindow = resolveSessionWindow(windows, session);
		const win = resolvedWindow.window;
		const burn = perTurnTokenBurn(session);
		perSession.push({
			file: f,
			project: path.basename(path.dirname(f)),
			model: session.model,
			peak,
			window: win,
			windowSource: resolvedWindow.source,
			ratio: win ? peak / win : null,
			meanTurnTokens: burn.meanTurnTokens,
			cumulativeBurn: burn.cumulativeBurn,
			turnRequestTokens: burn.deltas,
			totalBurnTokens: burn.totalBurnTokens,
			...a,
		});
		if (opts.top && perSession.length >= opts.top) break;
	}

	if (perSession.length === 0) {
		process.stdout.write("No matching sessions.\n");
		return;
	}

	// aggregate
	const agg = aggregate(perSession);

	if (opts.json) {
		process.stdout.write(JSON.stringify({ sessions: perSession, aggregate: agg, diagnostics: windows.diagnostics }, null, 2));
		return;
	}

	renderText(perSession, agg, opts, windows.diagnostics);
}

function aggregate(perSession) {
	const sourceTotals = {};
	let grandChars = 0;
	let grandTokens = 0;
	const readManyShareArr = [];
	const scatterPerSession = [];
	const explorationArr = [];
	const rereadPctArr = [];
	const ratios = [];
	const filesPerReadMany = [];
	const meanTurnTokensArr = [];
	const totalBurnTokensArr = [];
	for (const s of perSession) {
		for (const [name, v] of Object.entries(s.bySource)) {
			const e = (sourceTotals[name] ??= { count: 0, chars: 0, tokens: 0 });
			e.count += v.count;
			e.chars += v.chars;
			e.tokens += v.tokens ?? v.chars / 4;
			grandChars += v.chars;
			grandTokens += v.tokens ?? v.chars / 4;
		}
		const readTokens = (s.bySource.read?.tokens || 0) + (s.bySource.read_many?.tokens || 0);
		if (readTokens > 0) readManyShareArr.push((s.readManyTokens / readTokens) * 100);
		scatterPerSession.push(s.scatterFiles);
		explorationArr.push(s.explorationReads);
		if (s.totalReadLines > 0) rereadPctArr.push((s.redundantLines / s.totalReadLines) * 100);
		if (s.ratio != null) ratios.push(s.ratio * 100);
		filesPerReadMany.push(...s.readManyFilesCounts);
		if (s.meanTurnTokens != null) meanTurnTokensArr.push(s.meanTurnTokens);
		if (s.totalBurnTokens != null) totalBurnTokensArr.push(s.totalBurnTokens);
	}
	return {
		nSessions: perSession.length,
		sourceTotals,
		grandChars,
		grandTokens,
		readManyShareMedian: median(readManyShareArr),
		scatterMedian: median(scatterPerSession),
		scatterMax: Math.max(...scatterPerSession),
		explorationMedian: median(explorationArr),
		rereadPctMedian: median(rereadPctArr),
		ratioMedian: median(ratios),
		ratioMax: ratios.length ? Math.max(...ratios) : null,
		filesPerReadManyMedian: median(filesPerReadMany),
		meanTurnTokensMedian: median(meanTurnTokensArr),
		totalBurnTokensMedian: median(totalBurnTokensArr),
	};
}

function renderText(perSession, agg, opts, diagnostics) {
	let out = "";
	out += `\n=== Context-quality baseline — ${agg.nSessions} sessions ===\n`;
	if (diagnostics.length > 0) {
		out += `\n--- diagnostics ---\n`;
		for (const diagnostic of diagnostics) out += `    ${diagnostic}\n`;
	}

	if (opts.perSession) {
		for (const s of perSession) {
			const ratioStr = s.ratio != null ? `${(s.ratio * 100).toFixed(1)}%` : "n/a";
			const modelStr = `${s.model?.provider || "?"}/${s.model?.modelId || "?"}`;
			const windowStr = s.window ? `${s.window}(${s.windowSource})` : `unknown(${s.windowSource})`;
			out += `\n• ${s.project}  ${modelStr}  turns=${s.assistantTurns}  peak=${s.peak}t  window=${windowStr}  ratio=${ratioStr}  ${s.ratio != null && s.ratio >= AGING_START_TRIGGER ? "[AGING WOULD START]" : ""}\n`;
			out += fmtSourceTable(s.bySource, s.sourceTotalTokens);
			out += `    scatter-probed files=${s.scatterFiles}  exploration-reads-before-edit=${s.explorationReads}  reread-overlap=${s.totalReadLines ? ((s.redundantLines / s.totalReadLines) * 100).toFixed(1) : 0}%\n`;
			if (s.scatterDetail.length) {
				for (const d of s.scatterDetail.slice(0, 4))
					out += `      hunt: ${path.basename(d.path)} reads=${d.reads} reversals=${d.reversals}\n`;
			}
		}
	}

	out += `\n--- M1: token-by-source (aggregate) ---\n`;
	out += fmtSourceTable(agg.sourceTotals, agg.grandTokens);

	out += `\n--- M2: read-pattern ---\n`;
	out += `    scatter-probed files / session : median ${agg.scatterMedian}  (max ${agg.scatterMax})\n`;
	out += `    exploration reads before edit  : median ${agg.explorationMedian}\n`;
	out += `    read_many share of read tokens : median ${agg.readManyShareMedian.toFixed(1)}%\n`;
	out += `    files per read_many call       : median ${agg.filesPerReadManyMedian}\n`;

	out += `\n--- M3 (diagnostic): re-read overlap ---\n`;
	out += `    redundant (re-read) lines      : median ${agg.rereadPctMedian.toFixed(1)}% of read lines  [readCovers ceiling]\n`;

	out += `\n--- context pressure ---\n`;
	out += `    peak ratio vs window           : median ${agg.ratioMedian.toFixed(1)}%  max ${agg.ratioMax != null ? agg.ratioMax.toFixed(1) + "%" : "n/a"}\n`;
	out += `    thresholds                     : aging start ${AGING_START_TRIGGER * 100}%, stale prune ${STALE_PRUNE_TRIGGER * 100}%, heavy/edit compact ${HEAVY_AGING_TRIGGER * 100}%\n`;

	out += `\n--- token burn ---\n`;
	out += `    request tokens per session : median ${agg.totalBurnTokensMedian.toFixed(0)}t\n`;
	out += `    request tokens per turn    : median ${agg.meanTurnTokensMedian.toFixed(0)}t\n`;

	out += `\n--- decision hints ---\n`;
	const src = agg.sourceTotals;
	const share = (name) => (agg.grandTokens ? (((src[name]?.tokens || 0) / agg.grandTokens) * 100) : 0);
	const bashShare = share("bash");
	const readShare = share("read") + share("read_many");
	out += `    bash share=${bashShare.toFixed(1)}%  read share=${readShare.toFixed(1)}%  thinking share=${share("thinking").toFixed(1)}%\n`;
	const hints = [];
	if (bashShare > 30) hints.push(`Gate A (bash governance): bash is ${bashShare.toFixed(1)}% — biggest sink for these tasks.`);
	if (readShare > 25 && agg.scatterMedian >= 1) hints.push(`Gate B candidate (outline): reads ${readShare.toFixed(1)}% with median ${agg.scatterMedian} scatter-probed file(s)/session → run perfect-outline experiment.`);
	if (agg.rereadPctMedian > 5) hints.push(`Gate C (readCovers eager): ~${agg.rereadPctMedian.toFixed(1)}% of read lines are re-read — loss-free dedup ceiling.`);
	if (agg.ratioMax != null && agg.ratioMax < AGING_START_TRIGGER * 100) hints.push(`Note: max context ratio ${agg.ratioMax.toFixed(1)}% never reached the ${AGING_START_TRIGGER * 100}% aging-start trigger — aging/stale-prune/compaction inert in this corpus.`);
	if (hints.length === 0) hints.push("No gate clearly triggered at default thresholds — inspect per-session with --per-session.");
	for (const h of hints) out += `    • ${h}\n`;
	out += `\n`;
	process.stdout.write(out);
}

main().catch((e) => {
	process.stderr.write(`error: ${e?.stack || e}\n`);
	process.exit(1);
});
