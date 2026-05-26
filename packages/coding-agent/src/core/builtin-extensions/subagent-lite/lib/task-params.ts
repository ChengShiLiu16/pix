/** Raw task tool args as models sometimes send alternate field names. */
export type RawTaskParams = {
	prompt?: string;
	task?: string;
	instruction?: string;
	instructions?: string;
	description?: string;
	agent?: string;
	background?: boolean;
	tasks?: Array<{
		prompt?: string;
		task?: string;
		instruction?: string;
		instructions?: string;
		description?: string;
		agent?: string;
	}>;
};

/** Resolve worker prompt from common aliases (prompt, task, instruction, …). */
export function resolveTaskPrompt(
	params: Pick<RawTaskParams, "prompt" | "task" | "instruction" | "instructions">,
): string | undefined {
	for (const key of ["prompt", "task", "instruction", "instructions"] as const) {
		const value = params[key]?.trim();
		if (value) return value;
	}
	return undefined;
}

export function normalizeTaskItem(item: NonNullable<RawTaskParams["tasks"]>[number]) {
	const prompt = resolveTaskPrompt(item);
	return {
		prompt: prompt ?? "",
		agent: item.agent,
		description: item.description ?? prompt?.slice(0, 40),
	};
}

export function buildMissingPromptError(params: RawTaskParams): string {
	const keys = Object.keys(params).filter((k) => params[k as keyof RawTaskParams] != null);
	const desc = params.description?.trim();
	const hint = desc
		? `Each parallel task() call needs its own \`prompt\` with full worker instructions — \`description\` ("${desc}") is only the widget label.`
		: "Pass `prompt` (full worker instructions) or `tasks[]` (each item needs `prompt`).";
	const received = keys.length ? `Received keys: ${keys.join(", ")}.` : "Received empty arguments.";
	return `Error: prompt or tasks[] required. ${hint} ${received}`;
}
