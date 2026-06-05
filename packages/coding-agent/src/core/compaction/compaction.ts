/**
 * Context compaction for long sessions.
 *
 * Pure functions for compaction logic. The session manager handles I/O,
 * and after compaction the session is reloaded.
 */

import type { AgentMessage, StreamFn, ThinkingLevel } from "@earendil-works/pix-agent-core";
import type { AssistantMessage, Context, Model, SimpleStreamOptions, Usage } from "@earendil-works/pix-ai";
import { completeSimple } from "@earendil-works/pix-ai";
import { emitCompaction, emitCompactionQuality } from "../context-metrics.ts";
import {
	convertToLlm,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "../messages.ts";
import { buildSessionContext, type CompactionEntry, type SessionEntry } from "../session-manager.ts";
import {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	type FileOperations,
	formatFileOperations,
	SUMMARIZATION_SYSTEM_PROMPT,
	serializeConversation,
} from "./utils.ts";

// ============================================================================
// File Operation Tracking
// ============================================================================

/**
 * Stringify a value for token estimation, tolerating circular references.
 * Includes depth tracking and type/length info for better token estimates.
 * Mirrors the pix-agent-core harness implementation so the two compaction
 * copies do not diverge on circular/unserializable tool arguments.
 */
function safeJsonStringifyForTokens(value: unknown, maxDepth = 3): string {
	const seen = new WeakSet<object>();
	let truncated = false;

	function stringify(v: unknown, depth: number): string {
		if (v === null) return "null";
		if (typeof v !== "object") return JSON.stringify(v);
		if (depth >= maxDepth) {
			truncated = true;
			return typeTag(v);
		}
		if (seen.has(v)) {
			truncated = true;
			return `[Circular ${typeTag(v)}]`;
		}
		seen.add(v);
		try {
			if (Array.isArray(v)) {
				if (v.length === 0) return "[]";
				const items = v.slice(0, 50).map((x) => stringify(x, depth + 1));
				if (v.length > 50) {
					truncated = true;
					items.push("...");
				}
				return "[" + items.join(",") + "]";
			}
			const keys = Object.keys(v);
			if (keys.length === 0) return "{}";
			const entries = keys
				.slice(0, 30)
				.map((k) => JSON.stringify(k) + ":" + stringify((v as Record<string, unknown>)[k], depth + 1));
			if (keys.length > 30) {
				truncated = true;
				entries.push("...");
			}
			return "{" + entries.join(",") + "}";
		} finally {
			seen.delete(v);
		}
	}

	const result = stringify(value, 0);
	return truncated ? result + "⟪truncated⟫" : result;
}

function typeTag(v: object): string {
	const ctor = v.constructor?.name ?? "Object";
	if (Array.isArray(v)) return `Array[${v.length}]`;
	return ctor;
}

/** Details stored in CompactionEntry.details for file tracking */
export interface CompactionDetails {
	readFiles: string[];
	modifiedFiles: string[];
}

/**
 * Extract file operations from messages and previous compaction entries.
 */
function extractFileOperations(
	messages: AgentMessage[],
	entries: SessionEntry[],
	prevCompactionIndex: number,
): FileOperations {
	const fileOps = createFileOps();

	// Collect from previous compaction's details (if pi-generated)
	if (prevCompactionIndex >= 0) {
		const prevCompaction = entries[prevCompactionIndex] as CompactionEntry;
		if (!prevCompaction.fromHook && prevCompaction.details) {
			// fromHook field kept for session file compatibility
			const details = prevCompaction.details as CompactionDetails;
			if (Array.isArray(details.readFiles)) {
				for (const f of details.readFiles) fileOps.read.add(f);
			}
			if (Array.isArray(details.modifiedFiles)) {
				for (const f of details.modifiedFiles) fileOps.edited.add(f);
			}
		}
	}

	// Extract from tool calls in messages
	for (const msg of messages) {
		extractFileOpsFromMessage(msg, fileOps);
	}

	return fileOps;
}

// ============================================================================
// Message Extraction
// ============================================================================

/**
 * Extract AgentMessage from an entry if it produces one.
 * Returns undefined for entries that don't contribute to LLM context.
 */
function getMessageFromEntry(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "message") {
		return entry.message;
	}
	if (entry.type === "custom_message") {
		return createCustomMessage(entry.customType, entry.content, entry.display, entry.details, entry.timestamp);
	}
	if (entry.type === "branch_summary") {
		return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);
	}
	if (entry.type === "compaction") {
		return createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp);
	}
	return undefined;
}

function getMessageFromEntryForCompaction(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "compaction") {
		return undefined;
	}
	return getMessageFromEntry(entry);
}

/** Result from compact() - SessionManager adds uuid/parentUuid when saving */
export interface CompactionResult<T = unknown> {
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	/** Extension-specific data (e.g., ArtifactIndex, version markers for structured compaction) */
	details?: T;
}

// ============================================================================
// Types
// ============================================================================

export interface CompactionSettings {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
};

// ============================================================================
// Token calculation
// ============================================================================

/**
 * Calculate total context tokens from usage.
 *
 * The context window holds the ENTIRE prompt regardless of caching. With prompt
 * caching, `input` only counts the uncached suffix; the bulk of the history is
 * reported under `cacheRead`. Excluding it would undercount the real window
 * occupancy by ~90% on a cache hit and effectively disable threshold-based
 * compaction/aging. So we count input + output + cacheRead + cacheWrite, using
 * the provider-supplied `totalTokens` when available.
 */
export function calculateContextTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/**
 * Get usage from an assistant message if available.
 * Skips aborted and error messages as they don't have valid usage data.
 */
function getAssistantUsage(msg: AgentMessage): Usage | undefined {
	if (msg.role === "assistant" && "usage" in msg) {
		const assistantMsg = msg as AssistantMessage;
		if (assistantMsg.stopReason !== "aborted" && assistantMsg.stopReason !== "error" && assistantMsg.usage) {
			return assistantMsg.usage;
		}
	}
	return undefined;
}

/**
 * Find the last non-aborted assistant message usage from session entries.
 */
export function getLastAssistantUsage(entries: SessionEntry[]): Usage | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "message") {
			const usage = getAssistantUsage(entry.message);
			if (usage) return usage;
		}
	}
	return undefined;
}

export interface ContextUsageEstimate {
	tokens: number;
	usageTokens: number;
	trailingTokens: number;
	lastUsageIndex: number | null;
}

function getLastAssistantUsageInfo(messages: AgentMessage[]): { usage: Usage; index: number } | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const usage = getAssistantUsage(messages[i]);
		if (usage) return { usage, index: i };
	}
	return undefined;
}

/**
 * Estimate context tokens from messages, using the last assistant usage when available.
 * If there are messages after the last usage, estimate their tokens with estimateTokens.
 */
export function estimateContextTokens(messages: AgentMessage[], baselineTokens = 0): ContextUsageEstimate {
	const usageInfo = getLastAssistantUsageInfo(messages);

	if (!usageInfo) {
		// No usage data (first turn / persistent errors): fold in the fixed
		// baseline (system prompt + tool schemas) the provider would also count.
		let estimated = baselineTokens;
		for (const message of messages) {
			estimated += estimateTokens(message);
		}
		return {
			tokens: estimated,
			usageTokens: 0,
			trailingTokens: estimated,
			lastUsageIndex: null,
		};
	}

	const usageTokens = calculateContextTokens(usageInfo.usage);
	let trailingTokens = 0;
	for (let i = usageInfo.index + 1; i < messages.length; i++) {
		trailingTokens += estimateTokens(messages[i]);
	}

	return {
		tokens: usageTokens + trailingTokens,
		usageTokens,
		trailingTokens,
		lastUsageIndex: usageInfo.index,
	};
}

/**
 * Check if compaction should trigger based on context usage.
 */
export function shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean {
	if (!settings.enabled) return false;
	return contextTokens > contextWindow - settings.reserveTokens;
}

/**
 * Clamp compaction settings into a window-safe band.
 *
 * The compaction threshold is `contextWindow - reserveTokens`, and after
 * compaction the retained tail is up to `keepRecentTokens`. On small-context
 * models the absolute defaults (reserve 16384, keepRecent 20000) can make the
 * retained tail exceed the threshold (e.g. window=32768 → threshold=16384 <
 * keepRecent=20000), so compaction immediately re-triggers and burns summary
 * calls without making progress. This clamps both values so the tail can never
 * exceed the threshold; large windows pass the defaults through unchanged.
 *
 * Idempotent. Returns settings unchanged when the window is unknown (<= 0).
 */
export function resolveCompactionSettings(settings: CompactionSettings, contextWindow: number): CompactionSettings {
	if (contextWindow <= 0) return settings;
	// Math.min outermost: when hi < lo (tiny windows) this yields hi, not lo.
	const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
	const reserveTokens = clamp(settings.reserveTokens, 4096, Math.floor(contextWindow * 0.25));
	const maxKeep = Math.floor((contextWindow - reserveTokens) * 0.6);
	const keepRecentTokens = clamp(settings.keepRecentTokens, 2048, maxKeep);
	// Guarantees: reserve <= 0.25w, keepRecent <= 0.6*(w-reserve) <= 0.45w, so
	// keepRecent + reserve <= 0.7w < 0.85w, and keepRecent < threshold = w-reserve.
	return { ...settings, reserveTokens, keepRecentTokens };
}

// ============================================================================
// Cut point detection
// ============================================================================

/**
 * Estimate tokens for a text string, accounting for CJK density.
 *
 * CJK characters encode at ~1.5-1.7 chars/token, far denser than the ~4
 * chars/token of ASCII-ish text. A flat chars/4 therefore underestimates
 * CJK-heavy content by ~2.5x, which makes downstream budget math (e.g.
 * findCutPoint's keepRecentTokens accumulation) retain far more than intended.
 */
export function estimateTextTokens(text: string): number {
	let cjk = 0;
	for (const ch of text) {
		const c = ch.codePointAt(0) ?? 0;
		// CJK ideographs/punctuation/kana (0x3000-0x9fff), Hangul (0xac00-0xd7af),
		// fullwidth & halfwidth forms (0xff00-0xffef).
		if ((c >= 0x3000 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0xff00 && c <= 0xffef)) {
			cjk++;
		}
	}
	const other = text.length - cjk;
	return Math.ceil(cjk / 1.7 + other / 4);
}

/**
 * Estimate token count for a message. Uses estimateTextTokens so CJK-heavy
 * content is not underestimated; images count as a fixed ~1200 tokens.
 */
export function estimateTokens(message: AgentMessage): number {
	let tokens = 0;

	switch (message.role) {
		case "user": {
			const content = (message as { content: string | Array<{ type: string; text?: string }> }).content;
			if (typeof content === "string") {
				tokens += estimateTextTokens(content);
			} else if (Array.isArray(content)) {
				for (const block of content) {
					if (block.type === "text" && block.text) {
						tokens += estimateTextTokens(block.text);
					}
				}
			}
			return tokens;
		}
		case "assistant": {
			const assistant = message as AssistantMessage;
			for (const block of assistant.content) {
				if (block.type === "text") {
					tokens += estimateTextTokens(block.text);
				} else if (block.type === "thinking") {
					tokens += estimateTextTokens(block.thinking);
				} else if (block.type === "toolCall") {
					tokens +=
						estimateTextTokens(block.name) + estimateTextTokens(safeJsonStringifyForTokens(block.arguments));
				}
			}
			return tokens;
		}
		case "custom":
		case "toolResult": {
			if (typeof message.content === "string") {
				tokens += estimateTextTokens(message.content);
			} else {
				for (const block of message.content) {
					if (block.type === "text" && block.text) {
						tokens += estimateTextTokens(block.text);
					}
					if (block.type === "image") {
						tokens += 1200; // Estimate images as ~1200 tokens
					}
				}
			}
			return tokens;
		}
		case "bashExecution": {
			return estimateTextTokens(message.command) + estimateTextTokens(message.output);
		}
		case "branchSummary":
		case "compactionSummary": {
			return estimateTextTokens(message.summary);
		}
	}

	return 0;
}

/**
 * Find valid cut points: indices of user, assistant, custom, or bashExecution messages.
 * Never cut at tool results (they must follow their tool call).
 * When we cut at an assistant message with tool calls, its tool results follow it
 * and will be kept.
 * BashExecutionMessage is treated like a user message (user-initiated context).
 */
function findValidCutPoints(entries: SessionEntry[], startIndex: number, endIndex: number): number[] {
	const cutPoints: number[] = [];
	for (let i = startIndex; i < endIndex; i++) {
		const entry = entries[i];
		switch (entry.type) {
			case "message": {
				const role = entry.message.role;
				switch (role) {
					case "bashExecution":
					case "custom":
					case "branchSummary":
					case "compactionSummary":
					case "user":
					case "assistant":
						cutPoints.push(i);
						break;
					case "toolResult":
						break;
				}
				break;
			}
			case "thinking_level_change":
			case "model_change":
			case "compaction":
			case "branch_summary":
			case "custom":
			case "custom_message":
			case "label":
			case "session_info":
				break;
		}

		// branch_summary and custom_message are user-role messages, valid cut points
		if (entry.type === "branch_summary" || entry.type === "custom_message") {
			cutPoints.push(i);
		}
	}
	return cutPoints;
}

/**
 * Find the user message (or bashExecution) that starts the turn containing the given entry index.
 * Returns -1 if no turn start found before the index.
 * BashExecutionMessage is treated like a user message for turn boundaries.
 */
export function findTurnStartIndex(entries: SessionEntry[], entryIndex: number, startIndex: number): number {
	for (let i = entryIndex; i >= startIndex; i--) {
		const entry = entries[i];
		// branch_summary and custom_message are user-role messages, can start a turn
		if (entry.type === "branch_summary" || entry.type === "custom_message") {
			return i;
		}
		if (entry.type === "message") {
			const role = entry.message.role;
			if (role === "user" || role === "bashExecution") {
				return i;
			}
		}
	}
	return -1;
}

export interface CutPointResult {
	/** Index of first entry to keep */
	firstKeptEntryIndex: number;
	/** Index of user message that starts the turn being split, or -1 if not splitting */
	turnStartIndex: number;
	/** Whether this cut splits a turn (cut point is not a user message) */
	isSplitTurn: boolean;
}

/**
 * Find the cut point in session entries that keeps approximately `keepRecentTokens`.
 *
 * Algorithm: Walk backwards from newest, accumulating estimated message sizes.
 * Stop when we've accumulated >= keepRecentTokens. Cut at that point.
 *
 * Can cut at user OR assistant messages (never tool results). When cutting at an
 * assistant message with tool calls, its tool results come after and will be kept.
 *
 * Returns CutPointResult with:
 * - firstKeptEntryIndex: the entry index to start keeping from
 * - turnStartIndex: if cutting mid-turn, the user message that started that turn
 * - isSplitTurn: whether we're cutting in the middle of a turn
 *
 * Only considers entries between `startIndex` and `endIndex` (exclusive).
 */
export function findCutPoint(
	entries: SessionEntry[],
	startIndex: number,
	endIndex: number,
	keepRecentTokens: number,
): CutPointResult {
	const cutPoints = findValidCutPoints(entries, startIndex, endIndex);

	if (cutPoints.length === 0) {
		return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
	}

	// Walk backwards from newest, accumulating estimated message sizes
	let accumulatedTokens = 0;
	let cutIndex = cutPoints[0]; // Default: keep from first message (not header)

	for (let i = endIndex - 1; i >= startIndex; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;

		// Estimate this message's size
		const messageTokens = estimateTokens(entry.message);
		accumulatedTokens += messageTokens;

		// Check if we've exceeded the budget
		if (accumulatedTokens >= keepRecentTokens) {
			// Find the closest valid cut point at or after this entry
			for (let c = 0; c < cutPoints.length; c++) {
				if (cutPoints[c] >= i) {
					cutIndex = cutPoints[c];
					break;
				}
			}
			break;
		}
	}

	// Scan backwards from cutIndex to include any non-message entries (bash, settings, etc.)
	while (cutIndex > startIndex) {
		const prevEntry = entries[cutIndex - 1];
		// Stop at session header or compaction boundaries
		if (prevEntry.type === "compaction") {
			break;
		}
		if (prevEntry.type === "message") {
			// Stop if we hit any message
			break;
		}
		// Include this non-message entry (bash, settings change, etc.)
		cutIndex--;
	}

	// Determine if this is a split turn
	const cutEntry = entries[cutIndex];
	const isUserMessage = cutEntry.type === "message" && cutEntry.message.role === "user";
	const turnStartIndex = isUserMessage ? -1 : findTurnStartIndex(entries, cutIndex, startIndex);

	return {
		firstKeptEntryIndex: cutIndex,
		turnStartIndex,
		isSplitTurn: !isUserMessage && turnStartIndex !== -1,
	};
}

// ============================================================================
// Summarization
// ============================================================================

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

// Used instead of UPDATE_SUMMARIZATION_PROMPT once the previous summary itself
// grows large. "PRESERVE all" makes summaries grow monotonically across
// compactions until they consume the reserve; this template instead compacts.
const COMPACT_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags. The existing summary has grown large and MUST be compacted while merging in the new messages.

RULES:
- PRESERVE the Goal, Constraints & Preferences, Key Decisions, Blocked items, and Next Steps.
- COMPACT the Progress/Done list: merge related completed items into concise single lines; drop intermediate steps that have been superseded by later work.
- Drop low-value historical detail that is not needed to continue the work.
- PRESERVE exact file paths, function names, and error messages that are still relevant.
- The result MUST be shorter than the previous summary.

Use this EXACT format:

## Goal
[Preserve existing goals]

## Constraints & Preferences
- [Preserve existing]

## Progress
### Done
- [x] [Merged, compacted completed items]

### In Progress
- [ ] [Current work]

### Blocked
- [Current blockers]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Update based on current state]

## Critical Context
- [Only context still needed to continue]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

function createSummarizationOptions(
	model: Model<any>,
	maxTokens: number,
	apiKey: string | undefined,
	headers: Record<string, string> | undefined,
	signal: AbortSignal | undefined,
	thinkingLevel: ThinkingLevel | undefined,
): SimpleStreamOptions {
	const options: SimpleStreamOptions = { maxTokens, signal, apiKey, headers };
	if (model.reasoning && thinkingLevel && thinkingLevel !== "off") {
		options.reasoning = thinkingLevel;
	}
	return options;
}

async function completeSummarization(
	model: Model<any>,
	context: Context,
	options: SimpleStreamOptions,
	streamFn?: StreamFn,
): Promise<AssistantMessage> {
	if (!streamFn) {
		return completeSimple(model, context, options);
	}
	const stream = await streamFn(model, context, options);
	return stream.result();
}

/**
 * Generate a summary of the conversation using the LLM.
 * If previousSummary is provided, uses the update prompt to merge.
 */
export async function generateSummary(
	currentMessages: AgentMessage[],
	model: Model<any>,
	reserveTokens: number,
	apiKey: string | undefined,
	headers?: Record<string, string>,
	signal?: AbortSignal,
	customInstructions?: string,
	previousSummary?: string,
	thinkingLevel?: ThinkingLevel,
	streamFn?: StreamFn,
): Promise<string> {
	const maxTokens = Math.min(
		Math.floor(0.8 * reserveTokens),
		model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
	);

	// Pick the base prompt: initial when there is no previous summary; otherwise
	// the update prompt, switching to the compaction prompt once the previous
	// summary itself has grown past a soft cap (half the reserve budget).
	const prevSummaryTokens = previousSummary ? estimateTextTokens(previousSummary) : 0;
	let basePrompt: string;
	if (!previousSummary) {
		basePrompt = SUMMARIZATION_PROMPT;
	} else if (prevSummaryTokens > reserveTokens * 0.5) {
		basePrompt = COMPACT_SUMMARIZATION_PROMPT;
	} else {
		basePrompt = UPDATE_SUMMARIZATION_PROMPT;
	}
	if (customInstructions) {
		basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`;
	}

	// Serialize conversation to text so model doesn't try to continue it
	// Convert to LLM messages first (handles custom types like bashExecution, custom, etc.)
	const llmMessages = convertToLlm(currentMessages);
	const conversationText = serializeConversation(llmMessages);

	// Build the prompt with conversation wrapped in tags
	let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
	if (previousSummary) {
		promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
	}
	promptText += basePrompt;

	const summarizationMessages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: promptText }],
			timestamp: Date.now(),
		},
	];

	const completionOptions = createSummarizationOptions(model, maxTokens, apiKey, headers, signal, thinkingLevel);

	const response = await completeSummarization(
		model,
		{ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages },
		completionOptions,
		streamFn,
	);

	if (response.stopReason === "error") {
		throw new Error(`Summarization failed: ${response.errorMessage || "Unknown error"}`);
	}

	let textContent = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");

	// Hard cap: if the produced summary still exceeds the reserve budget, collapse
	// it once by re-summarizing it from scratch (no previous-summary preservation).
	if (textContent && estimateTextTokens(textContent) > reserveTokens * 0.8) {
		const collapsePrompt = `<conversation>\n${textContent}\n</conversation>\n\n${SUMMARIZATION_PROMPT}`;
		const collapseResponse = await completeSummarization(
			model,
			{
				systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
				messages: [
					{
						role: "user" as const,
						content: [{ type: "text" as const, text: collapsePrompt }],
						timestamp: Date.now(),
					},
				],
			},
			completionOptions,
			streamFn,
		);
		if (collapseResponse.stopReason !== "error") {
			const collapsed = collapseResponse.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");
			if (collapsed.trim()) textContent = collapsed;
		}
	}

	return textContent;
}

// ============================================================================
// Compaction Preparation (for extensions)
// ============================================================================

export interface CompactionPreparation {
	/** UUID of first entry to keep */
	firstKeptEntryId: string;
	/** Messages that will be summarized and discarded */
	messagesToSummarize: AgentMessage[];
	/** Messages that will be turned into turn prefix summary (if splitting) */
	turnPrefixMessages: AgentMessage[];
	/** Whether this is a split turn (cut point in middle of turn) */
	isSplitTurn: boolean;
	tokensBefore: number;
	/** Summary from previous compaction, for iterative update */
	previousSummary?: string;
	/** File operations extracted from messagesToSummarize */
	fileOps: FileOperations;
	/** Compaction settions from settings.jsonl	*/
	settings: CompactionSettings;
}

export function prepareCompaction(
	pathEntries: SessionEntry[],
	settings: CompactionSettings,
): CompactionPreparation | undefined {
	if (pathEntries.length > 0 && pathEntries[pathEntries.length - 1].type === "compaction") {
		return undefined;
	}

	let prevCompactionIndex = -1;
	for (let i = pathEntries.length - 1; i >= 0; i--) {
		if (pathEntries[i].type === "compaction") {
			prevCompactionIndex = i;
			break;
		}
	}

	let previousSummary: string | undefined;
	let boundaryStart = 0;
	if (prevCompactionIndex >= 0) {
		const prevCompaction = pathEntries[prevCompactionIndex] as CompactionEntry;
		previousSummary = prevCompaction.summary;
		const firstKeptEntryIndex = pathEntries.findIndex((entry) => entry.id === prevCompaction.firstKeptEntryId);
		boundaryStart = firstKeptEntryIndex >= 0 ? firstKeptEntryIndex : prevCompactionIndex + 1;
	}
	const boundaryEnd = pathEntries.length;

	const tokensBefore = estimateContextTokens(buildSessionContext(pathEntries).messages).tokens;

	const cutPoint = findCutPoint(pathEntries, boundaryStart, boundaryEnd, settings.keepRecentTokens);

	// Get UUID of first kept entry
	const firstKeptEntry = pathEntries[cutPoint.firstKeptEntryIndex];
	if (!firstKeptEntry?.id) {
		return undefined; // Session needs migration
	}
	const firstKeptEntryId = firstKeptEntry.id;

	const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;

	// Messages to summarize (will be discarded after summary)
	const messagesToSummarize: AgentMessage[] = [];
	for (let i = boundaryStart; i < historyEnd; i++) {
		const msg = getMessageFromEntryForCompaction(pathEntries[i]);
		if (msg) messagesToSummarize.push(msg);
	}

	// Messages for turn prefix summary (if splitting a turn)
	const turnPrefixMessages: AgentMessage[] = [];
	if (cutPoint.isSplitTurn) {
		for (let i = cutPoint.turnStartIndex; i < cutPoint.firstKeptEntryIndex; i++) {
			const msg = getMessageFromEntryForCompaction(pathEntries[i]);
			if (msg) turnPrefixMessages.push(msg);
		}
	}

	// Extract file operations from messages and previous compaction
	const fileOps = extractFileOperations(messagesToSummarize, pathEntries, prevCompactionIndex);

	// Also extract file ops from turn prefix if splitting
	if (cutPoint.isSplitTurn) {
		for (const msg of turnPrefixMessages) {
			extractFileOpsFromMessage(msg, fileOps);
		}
	}

	return {
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn: cutPoint.isSplitTurn,
		tokensBefore,
		previousSummary,
		fileOps,
		settings,
	};
}

/**
 * Word-set Jaccard similarity of two short strings, used to decide whether a
 * key item or anchor survived re-summarization. Naive substring matching
 * over-counts (a short item like "done" matches many lines); comparing the
 * normalized word sets is more robust to reordering and minor edits.
 */
function itemSimilarity(a: string, b: string): number {
	const words = (s: string): Set<string> =>
		new Set(
			s
				.toLowerCase()
				.split(/[^a-z0-9]+/)
				.filter((w) => w.length > 0),
		);
	const wa = words(a);
	const wb = words(b);
	if (wa.size === 0 || wb.size === 0) return 0;
	let intersection = 0;
	for (const w of wa) {
		if (wb.has(w)) intersection++;
	}
	return intersection / (wa.size + wb.size - intersection);
}

/** Two anchors are considered the same if equal or one contains the other (guarding tiny strings). */
function anchorsMatch(a: string, b: string): boolean {
	if (a === b) return true;
	const [short, long] = a.length <= b.length ? [a, b] : [b, a];
	return short.length >= 4 && long.includes(short);
}

/**
 * Analyze summary quality by comparing previous and new summaries.
 * Returns metrics for compression ratio, key-item retention, structure
 * preservation, and anchor retention (all ratios in [0, 1] except
 * compressionRatio which is newTokens/prevTokens).
 */
function analyzeSummaryQuality(
	previousSummary: string,
	newSummary: string,
): {
	compressionRatio: number;
	keyItemRetention: number;
	structurePreservation: number;
	anchorRetention: number;
} {
	const sections = [
		"Goal",
		"Constraints & Preferences",
		"Progress",
		"Key Decisions",
		"Next Steps",
		"Critical Context",
	];

	function parseSections(text: string): Map<string, string> {
		const result = new Map<string, string>();
		const lines = text.split("\n");
		let currentSection = "";
		let currentContent: string[] = [];

		for (const line of lines) {
			const sectionMatch = line.match(/^##\s+(.+)$/);
			if (sectionMatch) {
				if (currentSection) {
					result.set(currentSection, currentContent.join("\n"));
				}
				currentSection = sectionMatch[1].trim();
				currentContent = [];
			} else if (currentSection) {
				currentContent.push(line);
			}
		}
		if (currentSection) {
			result.set(currentSection, currentContent.join("\n"));
		}
		return result;
	}

	function extractItems(sectionText: string): string[] {
		return sectionText
			.split("\n")
			.map((l) => l.trim())
			.filter(
				(l) =>
					l.startsWith("- ") ||
					l.startsWith("- [") ||
					l.startsWith("1.") ||
					l.startsWith("2.") ||
					l.startsWith("3."),
			)
			.map((l) =>
				l
					.replace(/^[-*]\s*\[?[x\s]?\]?\s*/, "")
					.replace(/^\d+\.\s*/, "")
					.trim(),
			)
			.filter((l) => l.length > 0);
	}

	function extractAnchors(text: string): string[] {
		// Extract file paths, function names, error messages as "anchors"
		const anchors: string[] = [];
		// File paths
		anchors.push(
			...(text.match(/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_\-/.]+\.(ts|js|tsx|jsx|py|rs|go|java|cpp|c|h|json|md|txt)/g) ?? []),
		);
		// Function names (camelCase/PascalCase)
		anchors.push(...(text.match(/\b[a-z][a-zA-Z0-9]*\(\)/g) ?? []));
		// Error messages in quotes
		anchors.push(...(text.match(/"[^"]{10,}"/g) ?? []));
		return [...new Set(anchors)];
	}

	const prevSections = parseSections(previousSummary);
	const newSections = parseSections(newSummary);

	// Compression ratio: output tokens / input tokens
	const prevTokens = estimateTextTokens(previousSummary);
	const newTokens = estimateTextTokens(newSummary);
	const compressionRatio = prevTokens > 0 ? newTokens / prevTokens : 1;

	// Key-item retention: of the previous summary's key items, how many survive
	// in the new one. Iterating over prev items keeps the ratio bounded to [0, 1]
	// even when the new summary adds items.
	let totalItems = 0;
	let keptItems = 0;
	for (const section of sections) {
		const prevItems = extractItems(prevSections.get(section) ?? "");
		const newItems = extractItems(newSections.get(section) ?? "");
		totalItems += prevItems.length;
		for (const prevItem of prevItems) {
			if (newItems.some((n) => itemSimilarity(prevItem, n) >= 0.5)) {
				keptItems++;
			}
		}
	}
	const keyItemRetention = totalItems > 0 ? keptItems / totalItems : 1;

	// Structure preservation: sections preserved / total sections
	const preservedSections = sections.filter((s) => newSections.has(s)).length;
	const structurePreservation = sections.length > 0 ? preservedSections / sections.length : 1;

	// Anchor retention: anchors preserved / total anchors
	const prevAnchors = extractAnchors(previousSummary);
	const newAnchors = extractAnchors(newSummary);
	let keptAnchors = 0;
	for (const a of prevAnchors) {
		if (newAnchors.some((n) => anchorsMatch(a, n))) keptAnchors++;
	}
	const anchorRetention = prevAnchors.length > 0 ? keptAnchors / prevAnchors.length : 1;

	return {
		compressionRatio,
		keyItemRetention,
		structurePreservation,
		anchorRetention,
	};
}

// ============================================================================
// Main compaction function
// ============================================================================

const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`;

/**
 * Generate summaries for compaction using prepared data.
 * Returns CompactionResult - SessionManager adds uuid/parentUuid when saving.
 *
 * @param preparation - Pre-calculated preparation from prepareCompaction()
 * @param customInstructions - Optional custom focus for the summary
 * @param sessionId - Optional session UUID for metrics emission
 * @param reason - What triggered this compaction (for metrics). Defaults to "threshold".
 */
export async function compact(
	preparation: CompactionPreparation,
	model: Model<any>,
	apiKey: string | undefined,
	headers?: Record<string, string>,
	customInstructions?: string,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
	streamFn?: StreamFn,
	sessionId?: string,
	reason: "manual" | "threshold" | "overflow" = "threshold",
): Promise<CompactionResult> {
	const compactStartTime = performance.now();
	const {
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn,
		tokensBefore,
		previousSummary,
		fileOps,
		settings,
	} = preparation;

	// Generate summaries (can be parallel if both needed) and merge into one
	let summary: string;

	if (isSplitTurn && turnPrefixMessages.length > 0) {
		// Generate both summaries in parallel
		const [historyResult, turnPrefixResult] = await Promise.all([
			messagesToSummarize.length > 0
				? generateSummary(
						messagesToSummarize,
						model,
						settings.reserveTokens,
						apiKey,
						headers,
						signal,
						customInstructions,
						previousSummary,
						thinkingLevel,
						streamFn,
					)
				: Promise.resolve("No prior history."),
			generateTurnPrefixSummary(
				turnPrefixMessages,
				model,
				settings.reserveTokens,
				apiKey,
				headers,
				signal,
				thinkingLevel,
				streamFn,
			),
		]);
		// Merge into single summary
		summary = `${historyResult}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixResult}`;
	} else {
		// Just generate history summary
		summary = await generateSummary(
			messagesToSummarize,
			model,
			settings.reserveTokens,
			apiKey,
			headers,
			signal,
			customInstructions,
			previousSummary,
			thinkingLevel,
			streamFn,
		);
	}

	// Compute file lists and append to summary
	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	summary += formatFileOperations(readFiles, modifiedFiles);

	if (!firstKeptEntryId) {
		throw new Error("First kept entry has no UUID - session may need migration");
	}

	// Emit compaction metrics if sessionId provided
	const summaryTokensAfter = estimateTextTokens(summary);
	const compactTemplateUsed: boolean = Boolean(
		previousSummary && estimateTextTokens(previousSummary) > settings.reserveTokens * 0.5,
	);
	const doubleCompactTriggered: boolean = summaryTokensAfter > settings.reserveTokens * 0.8;
	const droppedMessages = messagesToSummarize.length + turnPrefixMessages.length;

	if (sessionId) {
		emitCompaction({
			sessionId,
			reason,
			summaryTokensBefore: previousSummary ? estimateTextTokens(previousSummary) : 0,
			summaryTokensAfter,
			keptRecentTokens: settings.keepRecentTokens,
			droppedMessages,
			compactTemplateUsed,
			doubleCompactTriggered,
			durationMs: performance.now() - compactStartTime,
		});

		// Emit quality metrics if we have a previous summary
		if (previousSummary) {
			const quality = analyzeSummaryQuality(previousSummary, summary);
			emitCompactionQuality({
				sessionId,
				compressionRatio: quality.compressionRatio,
				keyItemRetention: quality.keyItemRetention,
				structurePreservation: quality.structurePreservation,
				anchorRetention: quality.anchorRetention,
				compactTemplateUsed,
				doubleCompactTriggered,
			});
		}
	}

	return {
		summary,
		firstKeptEntryId,
		tokensBefore,
		details: { readFiles, modifiedFiles } as CompactionDetails,
	};
}

/**
 * Generate a summary for a turn prefix (when splitting a turn).
 */
async function generateTurnPrefixSummary(
	messages: AgentMessage[],
	model: Model<any>,
	reserveTokens: number,
	apiKey: string | undefined,
	headers?: Record<string, string>,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
	streamFn?: StreamFn,
): Promise<string> {
	const maxTokens = Math.min(
		Math.floor(0.5 * reserveTokens),
		model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
	); // Smaller budget for turn prefix
	const llmMessages = convertToLlm(messages);
	const conversationText = serializeConversation(llmMessages);
	const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`;
	const summarizationMessages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: promptText }],
			timestamp: Date.now(),
		},
	];

	const response = await completeSummarization(
		model,
		{ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages },
		createSummarizationOptions(model, maxTokens, apiKey, headers, signal, thinkingLevel),
		streamFn,
	);

	if (response.stopReason === "error") {
		throw new Error(`Turn prefix summarization failed: ${response.errorMessage || "Unknown error"}`);
	}

	return response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}
