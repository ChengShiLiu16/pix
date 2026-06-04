import type { AgentMessage } from "@earendil-works/pix-agent-core";
import type { TextContent } from "@earendil-works/pix-ai";
import { estimateContextTokens } from "./compaction/index.ts";
import { ageToolResults, compactEditArguments } from "./context-aging.ts";
import { CONTEXT_DEBUG, contextDebug } from "./context-debug.ts";
import { applyGitEvidenceTransform } from "./context-git-evidence.ts";
import { pruneStaleReads, pruneThinkingForNonAnthropic } from "./context-prune.ts";
import { computeReachability } from "./context-reachability.ts";
import { AGING_START_RATIO, STALE_PRUNE_START_RATIO } from "./context-thresholds.ts";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from "./tools/truncate.ts";

function capAssistantTextBlocks(messages: AgentMessage[]): AgentMessage[] {
	const MAX_ASSISTANT_TEXT_BYTES = DEFAULT_MAX_BYTES * 2; // 100KB
	if (messages.length === 0) return messages;

	let changed = false;
	const next = messages.map((msg) => {
		if (msg.role !== "assistant") return msg;
		const content = msg.content;
		if (!content || !Array.isArray(content)) return msg;

		let messageChanged = false;
		const newContent = content.map((block) => {
			if (block.type !== "text") return block;
			const bytes = Buffer.byteLength(block.text, "utf-8");
			if (bytes <= MAX_ASSISTANT_TEXT_BYTES) return block;

			messageChanged = true;
			const truncated = truncateHead(block.text, { maxBytes: MAX_ASSISTANT_TEXT_BYTES });
			if (truncated.firstLineExceedsLimit) {
				return {
					type: "text",
					text: `[Assistant text block (${formatSize(bytes)}) exceeds limit. Truncated.]`,
				} satisfies TextContent;
			}

			const totalSize = formatSize(truncated.totalBytes);
			return {
				type: "text",
				text: `${truncated.content}\n\n[Truncated: ${formatSize(MAX_ASSISTANT_TEXT_BYTES)} of ${totalSize} shown.]`,
			} satisfies TextContent;
		});

		if (!messageChanged) return msg;
		changed = true;
		return { ...msg, content: newContent };
	});

	return changed ? next : messages;
}

export interface OptimizeOutgoingContextOptions {
	cwd: string;
	contextWindow: number;
	provider: string;
}

export async function optimizeOutgoingContext(
	messages: AgentMessage[],
	options: OptimizeOutgoingContextOptions,
): Promise<AgentMessage[]> {
	let next = capAssistantTextBlocks(messages);

	// 先把大块 git 检查输出替换为结构化 evidence 摘要和原始 evidence 引用。
	next = await applyGitEvidenceTransform(next, options.cwd);

	// 在更具破坏性的 stale-read 剪枝前，先渐进压缩旧工具结果。
	// 压力计算放在 git evidence 压缩后，避免大块 git 输出触发过度 aging。
	const contextTokens = options.contextWindow > 0 ? estimateContextTokens(next).tokens : 0;
	const contextRatio = options.contextWindow > 0 ? contextTokens / options.contextWindow : 0;

	if (contextRatio >= AGING_START_RATIO) {
		const reachability = computeReachability(next, 2, options.cwd);
		next = ageToolResults(next, contextRatio, reachability);
	}

	// stale-read 剪枝会重写中段历史，并让 Anthropic 前缀缓存从该点失效。
	// 仅在上下文足够高时执行，确保 token 节省能抵消一次性 cache miss。
	const nextTokens = options.contextWindow > 0 ? estimateContextTokens(next).tokens : 0;
	if (options.contextWindow > 0 && nextTokens > options.contextWindow * STALE_PRUNE_START_RATIO) {
		next = pruneStaleReads(next, options.cwd);
	}

	next = pruneThinkingForNonAnthropic(next, options.provider);
	const result = compactEditArguments(next, contextRatio);

	// Measure aging+prune yield (excludes git-evidence, which ran before the
	// baseline). The extra estimate only runs under PIX_CONTEXT_DEBUG.
	if (CONTEXT_DEBUG && options.contextWindow > 0) {
		const finalTokens = estimateContextTokens(result).tokens;
		contextDebug(
			`optimize ${contextTokens}->${finalTokens} tok ` +
				`(ratio ${contextRatio.toFixed(2)}->${(finalTokens / options.contextWindow).toFixed(2)}, ` +
				`saved ${contextTokens - finalTokens})`,
		);
	}
	return result;
}
