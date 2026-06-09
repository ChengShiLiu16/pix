import type { AgentMessage } from "@chengshiliu16/pix-agent-core";
import type { AssistantMessage, TextContent, ToolResultMessage } from "@chengshiliu16/pix-ai";
import type { BashExecutionMessage } from "../messages.ts";
import { formatSupersededEvidence } from "./git-format.ts";
import { createGitEvidenceResult, type GitEvidenceDetails } from "./git-store.ts";

type ToolResultWithDetails = ToolResultMessage & { details?: Record<string, unknown> };

function extractText(content: ToolResultMessage["content"]): string {
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function getBashFullOutputPath(message: ToolResultMessage): string | undefined {
	const details = (message as ToolResultWithDetails).details;
	const value = details?.fullOutputPath;
	return typeof value === "string" ? value : undefined;
}

function getGitEvidenceDetails(message: ToolResultWithDetails): GitEvidenceDetails | undefined {
	const value = message.details?.gitEvidence;
	if (!value || typeof value !== "object") return undefined;
	const details = value as Partial<GitEvidenceDetails>;
	if (
		typeof details.id === "string" &&
		typeof details.command === "string" &&
		typeof details.kind === "string" &&
		typeof details.rawBytes === "number" &&
		typeof details.rawLines === "number" &&
		typeof details.outputHash === "string"
	) {
		return {
			...details,
			rawIncomplete: details.rawIncomplete ?? false,
			rawStorageFailed: details.rawStorageFailed ?? false,
		} as GitEvidenceDetails;
	}
	return undefined;
}

function compactExistingEvidence(message: ToolResultWithDetails): ToolResultWithDetails {
	const details = getGitEvidenceDetails(message);
	if (details?.supersededBy) return message;
	if (!details?.compactText) return message;
	const text = extractText(message.content);
	if (text === details.compactText) return message;
	return { ...message, content: [{ type: "text", text: details.compactText }] };
}

function compactOlderGitEvidenceResults(messages: AgentMessage[]): { messages: AgentMessage[]; changed: boolean } {
	const evidenceResultIndexes: number[] = [];
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (message.role !== "toolResult") continue;
		const toolResult = message as ToolResultWithDetails;
		const details = getGitEvidenceDetails(toolResult);
		if (toolResult.toolName === "bash" && details && !details.supersededBy) evidenceResultIndexes.push(index);
	}

	const keepDetailed = new Set(evidenceResultIndexes.slice(-2));
	let changed = false;
	const compacted = messages.map((message, index) => {
		if (keepDetailed.has(index) || !evidenceResultIndexes.includes(index)) return message;
		const next = compactExistingEvidence(message as ToolResultWithDetails);
		if (next !== message) changed = true;
		return next;
	});
	return { messages: compacted, changed };
}

function supersedeSeriesMapKey(details: GitEvidenceDetails): string | undefined {
	if (details.volatility !== "dynamic" || !details.seriesKey || !details.gitContextKey) return undefined;
	return `${details.gitContextKey}\x00${details.seriesKey}`;
}

function supersedeOlderDynamicEvidence(messages: AgentMessage[]): { messages: AgentMessage[]; changed: boolean } {
	const latestBySeries = new Map<string, GitEvidenceDetails>();
	for (const message of messages) {
		if (message.role !== "toolResult") continue;
		const details = getGitEvidenceDetails(message as ToolResultWithDetails);
		if (!details) continue;
		const mapKey = supersedeSeriesMapKey(details);
		if (mapKey) latestBySeries.set(mapKey, details);
	}

	let changed = false;
	const next = messages.map((message) => {
		if (message.role !== "toolResult") return message;
		const toolResult = message as ToolResultWithDetails;
		if (toolResult.toolName !== "bash") return message;
		const details = getGitEvidenceDetails(toolResult);
		if (!details) return message;
		const mapKey = supersedeSeriesMapKey(details);
		if (!mapKey) return message;
		const latest = latestBySeries.get(mapKey);
		if (!latest || latest.id === details.id) return message;
		const text = extractText(toolResult.content);
		const supersededText = formatSupersededEvidence({
			id: details.id,
			command: details.command,
			kind: details.kind,
			scopeType: details.scope?.type,
			supersededBy: latest.id,
		});
		if (text === supersededText && details.supersededBy === latest.id) return message;
		changed = true;
		return {
			...toolResult,
			content: [{ type: "text", text: supersededText }],
			details: { ...(toolResult.details ?? {}), gitEvidence: { ...details, supersededBy: latest.id } },
		} satisfies ToolResultWithDetails;
	});
	return { messages: next, changed };
}

function visibleBashOutputIncomplete(message: ToolResultWithDetails): boolean {
	const details = message.details;
	const truncation = details?.truncation as { truncated?: unknown } | undefined;
	return truncation?.truncated === true && getBashFullOutputPath(message) === undefined;
}

export async function applyGitEvidenceTransform(
	messages: AgentMessage[],
	cwd: string,
	env?: NodeJS.ProcessEnv,
): Promise<AgentMessage[]> {
	const commandByToolCallId = new Map<string, string>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		const assistant = message as AssistantMessage;
		if (!("content" in assistant) || !Array.isArray(assistant.content)) continue;
		for (const block of assistant.content) {
			if (block.type !== "toolCall" || block.name !== "bash") continue;
			const command = (block.arguments as Record<string, unknown> | undefined)?.command;
			if (typeof command === "string") commandByToolCallId.set(block.id, command);
		}
	}

	let changed = false;
	const result: AgentMessage[] = [];
	for (const message of messages) {
		if (message.role === "toolResult" && (message as ToolResultMessage).toolName === "bash") {
			const toolResult = message as ToolResultWithDetails;
			if (getGitEvidenceDetails(toolResult)) {
				result.push(toolResult);
				continue;
			}
			const command = commandByToolCallId.get(toolResult.toolCallId);
			const originalText = extractText(toolResult.content);
			if (command && originalText && !toolResult.isError) {
				const evidence = await createGitEvidenceResult(
					command,
					cwd,
					originalText,
					getBashFullOutputPath(toolResult),
					env,
					visibleBashOutputIncomplete(toolResult),
				);
				if (evidence) {
					changed = true;
					result.push({
						...toolResult,
						content: [{ type: "text", text: evidence.text }],
						details: { ...(toolResult.details ?? {}), gitEvidence: evidence.details },
					} satisfies ToolResultWithDetails);
					continue;
				}
			}
		}

		if (message.role === "bashExecution") {
			const bashMessage = message as BashExecutionMessage;
			const evidence = await createGitEvidenceResult(
				bashMessage.command,
				cwd,
				bashMessage.output,
				bashMessage.fullOutputPath,
				env,
				bashMessage.truncated && !bashMessage.fullOutputPath,
			);
			if (evidence) {
				changed = true;
				result.push({
					...bashMessage,
					output: evidence.text,
					truncated: false,
					fullOutputPath: evidence.details.rawPath ?? bashMessage.fullOutputPath,
				});
				continue;
			}
		}

		result.push(message);
	}

	const superseded = supersedeOlderDynamicEvidence(result);
	const compacted = compactOlderGitEvidenceResults(superseded.messages);
	return changed || superseded.changed || compacted.changed ? compacted.messages : messages;
}
