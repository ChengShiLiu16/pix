/**
 * Prefix-cache continuity for outgoing-context rewrites.
 *
 * `transformContext` runs on EVERY provider request, and the aging / stale-prune
 * passes rewrite messages in the middle of the conversation. Providers cache the
 * prompt as one contiguous prefix (see packages/ai/src/api/anthropic-messages.ts,
 * which puts `cache_control` on the system prompt and on the last user-role
 * message — tool results included). Rewriting any message that the previous
 * request already sent therefore invalidates the cache from that point on: the
 * entire suffix is re-billed at the cache-WRITE price instead of the cache-READ
 * price, typically an order of magnitude more expensive for that request.
 *
 * This module keeps a small per-session ledger of what was actually emitted last
 * time and enforces three rules on top of it:
 *
 *   1. Cost gate — a rewrite inside the previously cached region is applied only
 *      when the tokens it removes repay the cache miss it causes
 *      (see requiredSavingsForCacheBreak). Otherwise the cached region is
 *      restored byte-for-byte and only the fresh tail keeps its rewrite.
 *   2. Monotonicity — a message that was already emitted in a reduced form is
 *      never restored to its fuller form. Restoring costs a cache break and has
 *      negative savings, so the gate rejects it; this falls out of rule 1 but is
 *      asserted explicitly by tests because it is the property that stops the
 *      aged/un-aged oscillation.
 *   3. Turn-stable focus — reachability targets accumulate within a user turn
 *      instead of being recomputed from scratch on every tool call, so a message
 *      cannot flip from "adjacent" (protected) to "unrelated" (aged) midway
 *      through a turn just because the model's attention moved on.
 *
 * State is keyed by session id and bounded; it is a pure optimization cache and
 * can be dropped at any time without affecting correctness.
 */

import type { AgentMessage } from "@chengshiliu16/pix-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@chengshiliu16/pix-ai";
import { estimateTokens } from "./compaction/index.ts";
import type { FocusContext } from "./context-reachability.ts";
import {
	ANTHROPIC_CACHE_SEMANTICS,
	CACHE_GATE_MIN_SAVED_TOKENS,
	CACHE_GATE_RELIEF_MARGIN,
	type CacheSemantics,
	NO_CACHE_SEMANTICS,
	OPENAI_AUTO_CACHE_SEMANTICS,
	requiredSavingsForCacheBreak,
} from "./context-thresholds.ts";

/** Maximum number of sessions tracked at once; oldest use is evicted first. */
const MAX_TRACKED_SESSIONS = 16;

interface EmittedEntry {
	/** Stable identity of the message slot (see messageKey). */
	key: string;
	/** Hash of the content actually sent to the provider. */
	hash: number;
	/**
	 * Hash of the untouched message.
	 *
	 * Alignment needs more than matching keys: after a compaction, a branch
	 * switch or a rewind, position N holds a different message that may still
	 * produce the same key. Matching the original content too means a replaced
	 * history simply fails to align instead of restoring bytes from a
	 * conversation that no longer exists.
	 */
	originalHash: number;
	/**
	 * The message exactly as emitted. Restoring this is what keeps the prefix
	 * byte-identical when a rewrite is rejected.
	 */
	emitted: AgentMessage;
	/** The untouched message it was derived from; used to reuse this entry as-is. */
	original: AgentMessage;
	/** Token estimate of the emitted form, cached to keep the gate cheap. */
	tokens: number;
}

interface SessionContinuityState {
	emitted: EmittedEntry[];
	/** Number of user-role turns observed when the focus accumulator was reset. */
	focusTurn: number;
	focusPaths: Set<string>;
	focusScopes: Set<string>;
	focusToolCallIds: Set<string>;
	lastUsed: number;
}

const sessions = new Map<string, SessionContinuityState>();
let clock = 0;

function getState(sessionId: string): SessionContinuityState {
	let state = sessions.get(sessionId);
	if (!state) {
		state = {
			emitted: [],
			focusTurn: -1,
			focusPaths: new Set(),
			focusScopes: new Set(),
			focusToolCallIds: new Set(),
			lastUsed: 0,
		};
		sessions.set(sessionId, state);
		if (sessions.size > MAX_TRACKED_SESSIONS) evictOldest();
	}
	state.lastUsed = ++clock;
	return state;
}

function evictOldest(): void {
	let oldestKey: string | undefined;
	let oldestUse = Number.POSITIVE_INFINITY;
	for (const [key, state] of sessions) {
		if (state.lastUsed < oldestUse) {
			oldestUse = state.lastUsed;
			oldestKey = key;
		}
	}
	if (oldestKey !== undefined) sessions.delete(oldestKey);
}

/** Drop tracked state. Without an id, drops everything (used by tests). */
export function resetContinuityState(sessionId?: string): void {
	if (sessionId === undefined) {
		sessions.clear();
		clock = 0;
		return;
	}
	sessions.delete(sessionId);
}

// ---------------------------------------------------------------------------
// Message identity and content hashing
// ---------------------------------------------------------------------------

/**
 * Stable identity for a message slot.
 *
 * The conversation is append-only between compactions, so position is a valid
 * component; tool ids are folded in so that a shifted history (after compaction
 * or a branch switch) fails to align instead of silently matching by position.
 */
function messageKey(message: AgentMessage, index: number): string {
	if (message.role === "toolResult") {
		return `${index}:tr:${(message as ToolResultMessage).toolCallId}`;
	}
	if (message.role === "assistant") {
		const assistant = message as AssistantMessage;
		const firstCall = Array.isArray(assistant.content)
			? assistant.content.find((block) => block.type === "toolCall")
			: undefined;
		return `${index}:as:${firstCall && firstCall.type === "toolCall" ? firstCall.id : ""}`;
	}
	return `${index}:${message.role}`;
}

/** FNV-1a, 32-bit. Cheap and good enough to detect rewritten content. */
function hashString(text: string, seed = 0x811c9dc5): number {
	let hash = seed;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

/**
 * Hash the parts of a message that actually reach the provider and that our
 * rewrite passes can change: tool-result text, assistant text, and tool-call
 * arguments (compactEditArguments rewrites those).
 */
function contentHash(message: AgentMessage): number {
	let hash = 0x811c9dc5;
	if (message.role === "toolResult") {
		const result = message as ToolResultMessage;
		for (const block of result.content) {
			if (block.type === "text") hash = hashString(block.text, hash);
			else hash = hashString(block.type, hash);
		}
		return hash >>> 0;
	}
	if (message.role === "assistant") {
		const assistant = message as AssistantMessage;
		if (!Array.isArray(assistant.content)) return hash >>> 0;
		for (const block of assistant.content) {
			if (block.type === "text") hash = hashString(block.text, hash);
			else if (block.type === "thinking") hash = hashString(block.thinking, hash);
			else if (block.type === "toolCall") {
				hash = hashString(block.name, hash);
				hash = hashString(safeArgs(block.arguments), hash);
			}
		}
		return hash >>> 0;
	}
	if (message.role === "user" || message.role === "custom") {
		const content = (message as { content: unknown }).content;
		if (typeof content === "string") return hashString(content, hash) >>> 0;
		if (Array.isArray(content)) {
			for (const block of content as Array<{ type: string; text?: string }>) {
				hash = hashString(block.type === "text" && block.text ? block.text : block.type, hash);
			}
		}
		return hash >>> 0;
	}
	return hash >>> 0;
}

function safeArgs(args: unknown): string {
	try {
		return JSON.stringify(args) ?? "";
	} catch {
		return "";
	}
}

// ---------------------------------------------------------------------------
// Turn-stable focus accumulation (rule 3)
// ---------------------------------------------------------------------------

/** Count user-role turns; matches computeAges/buildFocusContext's notion of a turn. */
export function countUserTurns(messages: AgentMessage[]): number {
	let count = 0;
	for (const message of messages) {
		if (message.role === "user" || message.role === "bashExecution" || message.role === "custom") count++;
	}
	return count;
}

/**
 * Union this request's focus with everything focused earlier in the same user
 * turn, resetting when a new turn starts.
 *
 * Within one turn the model issues many tool calls, each producing another
 * provider request. Recomputing the focus from scratch lets an old result flip
 * from protected to unprotected mid-turn, which rewrites history (cache break)
 * and can strip context the model is still using. Accumulating means protection
 * only ever grows during a turn: decisions are stable and never retract
 * evidence the model just demonstrated it cares about.
 */
export function accumulateTurnFocus(sessionId: string, messages: AgentMessage[], focus: FocusContext): FocusContext {
	const state = getState(sessionId);
	const turn = countUserTurns(messages);
	if (turn !== state.focusTurn) {
		state.focusTurn = turn;
		state.focusPaths = new Set(focus.targetPaths);
		state.focusScopes = new Set(focus.targetScopes);
		state.focusToolCallIds = new Set(focus.focusToolCallIds);
	} else {
		for (const path of focus.targetPaths) state.focusPaths.add(path);
		for (const scope of focus.targetScopes) state.focusScopes.add(scope);
		for (const id of focus.focusToolCallIds) state.focusToolCallIds.add(id);
	}
	return {
		targetPaths: state.focusPaths,
		targetScopes: state.focusScopes,
		focusToolCallIds: state.focusToolCallIds,
	};
}

// ---------------------------------------------------------------------------
// Cache gate (rules 1 and 2)
// ---------------------------------------------------------------------------

/** How many recent assistant messages to inspect for cache activity. */
const CACHE_DETECTION_LOOKBACK = 6;

/**
 * Cache pricing semantics for the current session.
 *
 * Gating rewrites only pays off against a provider that caches the prompt
 * prefix; where nothing is cached, every request re-sends the whole history at
 * full price and shrinking it is an unconditional win. Rather than maintaining a
 * provider allowlist that silently rots, we read it off the usage the provider
 * itself reported:
 *
 *   - `cacheWrite > 0`      → Anthropic-style explicit cache (hits cheap, writes
 *                             at a premium): the Anthropic arithmetic applies.
 *                             Write evidence wins even when a more recent
 *                             read-only usage is visible, so a session that ever
 *                             paid for cache writes keeps Anthropic pricing.
 *   - `cacheRead > 0` only  → OpenAI-style auto caching: hits are billed from
 *                             the model's cacheRead rate and writes are free,
 *                             so a break only re-bills the suffix at full input
 *                             price once (writeMultiplier = 1).
 *   - neither reported      → no prefix caching; rewrites are unconditional.
 *
 * With no usage yet (first request of a session) we fall back to the model's
 * API protocol — anthropic-messages gets the Anthropic arithmetic, everything
 * else (openai-completions, openai-responses, …) the auto-cache arithmetic.
 * The ledger is empty then anyway, so the fallback cannot suppress a rewrite
 * that would have paid off under the true pricing.
 */
export function detectCacheSemantics(
	messages: AgentMessage[],
	model?: { cost?: { input?: number; cacheRead?: number } },
): CacheSemantics {
	let inspected = 0;
	let sawCacheRead = false;
	for (let i = messages.length - 1; i >= 0 && inspected < CACHE_DETECTION_LOOKBACK; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		const usage = (message as { usage?: { cacheRead?: number; cacheWrite?: number } }).usage;
		if (!usage) continue;
		inspected++;
		// Write evidence wins over read evidence: a provider that bills cache
		// writes at a premium is Anthropic-style regardless of what a more
		// recent read-only usage reports, and mixing the two arithmetic models
		// would systematically misprice the gate.
		if ((usage.cacheWrite ?? 0) > 0) return ANTHROPIC_CACHE_SEMANTICS;
		if ((usage.cacheRead ?? 0) > 0) sawCacheRead = true;
	}
	if (sawCacheRead) return autoCacheSemantics(model);
	if (inspected > 0) return NO_CACHE_SEMANTICS;
	return protocolSemantics(messages, model);
}

/**
 * OpenAI-style auto-cache pricing from the model's cost metadata.
 *
 * The read multiplier is `cacheRead / input` from the model's rates (e.g. kimi
 * k2.6 on opencode-go bills cache hits at 0.16 vs 0.95 input ≈ 0.17x). When the
 * metadata is missing or degenerate, fall back to the conservative OpenAI
 * default (0.5x) — overestimating the hit price keeps the gate from breaking
 * the cache for too little savings, which is the safe direction.
 */
function autoCacheSemantics(model?: { cost?: { input?: number; cacheRead?: number } }): CacheSemantics {
	const input = model?.cost?.input;
	const cacheRead = model?.cost?.cacheRead;
	if (typeof input === "number" && typeof cacheRead === "number" && input > 0 && cacheRead > 0) {
		const ratio = cacheRead / input;
		if (Number.isFinite(ratio) && ratio > 0 && ratio < 1) {
			return { kind: "auto", readMultiplier: ratio, writeMultiplier: 1 };
		}
	}
	return OPENAI_AUTO_CACHE_SEMANTICS;
}

/**
 * Protocol fallback for the first request of a session, when no usage has been
 * reported yet. anthropic-messages is the only API with explicit write-priced
 * cache entries; every other protocol uses automatic caching at worst. Without
 * any assistant message to read the api from, treat the session as uncached.
 */
function protocolSemantics(
	messages: AgentMessage[],
	model?: { cost?: { input?: number; cacheRead?: number } },
): CacheSemantics {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		const api = (message as { api?: string }).api;
		if (api === "anthropic-messages") return ANTHROPIC_CACHE_SEMANTICS;
		if (api) return autoCacheSemantics(model);
	}
	return NO_CACHE_SEMANTICS;
}

export type CacheGateRegime =
	| "no_history" // nothing emitted before; every byte is new
	| "no_break" // cached region is untouched
	| "relief" // near the compaction threshold, breaking beats compacting
	| "economic_pass" // savings repay the cache miss
	| "economic_reject"; // savings do not repay it — cached region restored

export interface CacheContinuityDecision {
	messages: AgentMessage[];
	/** First index whose bytes changed inside the previously cached region, or -1. */
	breakIndex: number;
	/** Previously cached tokens invalidated by that break. */
	brokenSuffixTokens: number;
	/** Tokens the rewrite removes from the cached region (can be negative). */
	savedTokens: number;
	requiredSavedTokens: number;
	regime: CacheGateRegime;
	/** Whether the rewrite of the cached region was kept. */
	applied: boolean;
}

export interface CacheContinuityOptions {
	sessionId: string;
	/** Current context pressure (estimated tokens / window). */
	ratio: number;
	/** Ratio at/above which compaction would fire. */
	compactionRatio: number;
	/**
	 * Provider cache pricing for the gate's arithmetic. Defaults to Anthropic
	 * semantics; pass the detected semantics for OpenAI-style auto caching.
	 */
	semantics?: CacheSemantics;
	/**
	 * Whether to record the outcome as "what we sent".
	 *
	 * False for dry runs — the compaction decision probes the optimizer without
	 * sending anything, and recording that probe would leave the ledger
	 * describing a request the provider never saw.
	 */
	commit?: boolean;
}

/** Reference check first: identical objects cannot have different content. */
function sameOriginal(entry: EmittedEntry, original: AgentMessage): boolean {
	return entry.original === original || entry.originalHash === contentHash(original);
}

/**
 * Longest prefix where the ledger describes the same messages as this request:
 * same slot identity and same untouched content.
 */
function alignedLength(entries: EmittedEntry[], keys: string[], original: AgentMessage[]): number {
	const max = Math.min(entries.length, keys.length);
	let i = 0;
	while (i < max && entries[i].key === keys[i] && sameOriginal(entries[i], original[i])) i++;
	return i;
}

/**
 * Decide whether this request may rewrite history, and produce the message list
 * to actually send.
 *
 * `original` is the untouched conversation, `candidate` the output of the
 * rewrite passes. Messages beyond the previously emitted region were never
 * cached, so their rewrites are always free and always kept.
 */
export function enforceCacheContinuity(
	original: AgentMessage[],
	candidate: AgentMessage[],
	options: CacheContinuityOptions,
): CacheContinuityDecision {
	const noop = (regime: CacheGateRegime): CacheContinuityDecision => ({
		messages: candidate,
		breakIndex: -1,
		brokenSuffixTokens: 0,
		savedTokens: 0,
		requiredSavedTokens: 0,
		regime,
		applied: true,
	});

	const commit = options.commit !== false;
	const semantics = options.semantics ?? ANTHROPIC_CACHE_SEMANTICS;
	if (semantics.kind === "none") return noop("no_break");
	// Rewrite passes never add or drop messages; a length change means the
	// caller handed us mismatched arrays, in which case alignment is meaningless.
	if (candidate.length !== original.length) return noop("no_break");

	const state = getState(options.sessionId);
	const keys = original.map(messageKey);
	const aligned = alignedLength(state.emitted, keys, original);

	if (aligned === 0) {
		if (commit) record(state, keys, original, candidate);
		return noop("no_history");
	}

	let breakIndex = -1;
	for (let i = 0; i < aligned; i++) {
		if (contentHash(candidate[i]) !== state.emitted[i].hash) {
			breakIndex = i;
			break;
		}
	}

	if (breakIndex === -1) {
		if (commit) record(state, keys, original, candidate);
		return noop("no_break");
	}

	// Everything from the break to the end of the cached region gets re-billed.
	let brokenSuffixTokens = 0;
	let candidateTokens = 0;
	for (let i = breakIndex; i < aligned; i++) {
		brokenSuffixTokens += state.emitted[i].tokens;
		candidateTokens += estimateTokens(candidate[i]);
	}
	const savedTokens = brokenSuffixTokens - candidateTokens;

	const reliefRatio = options.compactionRatio - CACHE_GATE_RELIEF_MARGIN;
	const inRelief = options.compactionRatio > 0 && options.ratio >= reliefRatio;
	const requiredSavedTokens = inRelief
		? CACHE_GATE_MIN_SAVED_TOKENS
		: Math.max(CACHE_GATE_MIN_SAVED_TOKENS, requiredSavingsForCacheBreak(brokenSuffixTokens, semantics));

	if (savedTokens >= requiredSavedTokens) {
		if (commit) record(state, keys, original, candidate);
		return {
			messages: candidate,
			breakIndex,
			brokenSuffixTokens,
			savedTokens,
			requiredSavedTokens,
			regime: inRelief ? "relief" : "economic_pass",
			applied: true,
		};
	}

	// Rejected: restore the previously emitted bytes for the cached region so the
	// prefix stays identical, and keep the (free) rewrites past it.
	const restored = candidate.slice();
	let differsFromOriginal = false;
	for (let i = breakIndex; i < aligned; i++) {
		restored[i] = state.emitted[i].emitted;
	}
	for (let i = 0; i < restored.length; i++) {
		if (restored[i] !== original[i]) {
			differsFromOriginal = true;
			break;
		}
	}
	// Callers treat an unchanged array by identity ("nothing to do"), so hand back
	// the input itself when the rollback left nothing rewritten.
	const messages = differsFromOriginal ? restored : original;
	if (commit) record(state, keys, original, messages);
	return {
		messages,
		breakIndex,
		brokenSuffixTokens,
		savedTokens,
		requiredSavedTokens,
		regime: "economic_reject",
		applied: false,
	};
}

function record(
	state: SessionContinuityState,
	keys: string[],
	original: AgentMessage[],
	emitted: AgentMessage[],
): void {
	const entries: EmittedEntry[] = new Array(keys.length);
	const previous = state.emitted;
	for (let i = 0; i < keys.length; i++) {
		const message = emitted[i];
		const source = original[i];
		// Hashing and token-estimating the whole history on every request is pure
		// waste when nothing about a message changed. Most requests only append,
		// so the overwhelming majority of entries are reused by reference here.
		const prior = previous[i];
		if (prior !== undefined && prior.key === keys[i] && prior.emitted === message && prior.original === source) {
			entries[i] = prior;
			continue;
		}
		const originalHash = contentHash(source);
		entries[i] = {
			key: keys[i],
			hash: message === source ? originalHash : contentHash(message),
			originalHash,
			emitted: message,
			original: source,
			tokens: estimateTokens(message),
		};
	}
	state.emitted = entries;
}
