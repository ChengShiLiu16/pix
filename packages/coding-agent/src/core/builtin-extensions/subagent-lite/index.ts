/**
 * subagent-lite — minimal Cursor-style multitask for Pi.
 * Toggle: /multitask | Reload: /reload
 */
import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "../../../index.ts";
import { findAgent, loadAgents } from "./lib/agents.ts";
import {
	buildBlockedToolReason,
	buildCoordinatorHint,
	buildTaskDisabledReason,
	buildToggleMessage,
	buildWorkerCompleteFollowUp,
	COORDINATOR_BLOCKED_TOOLS,
	MAX_BACKGROUND,
	TASK_DESCRIPTION,
	TASK_PROMPT_GUIDELINES,
} from "./lib/multitask-prompt.ts";
import {
	assessWorkerSuccess,
	buildSpawnArgs,
	FAST_FAIL_MS,
	formatDuration,
	formatSessionModel,
	formatWorkerFailure,
	summarizeOutput,
	WIDGET_SUMMARY_MAX,
	type WorkerRunMetrics,
} from "./lib/spawn.ts";
import {
	buildMissingPromptError,
	normalizeTaskItem,
	type RawTaskParams,
	resolveTaskPrompt,
} from "./lib/task-params.ts";
import {
	isParallelTaskDetails,
	type ParallelTaskDetails,
	resolveTaskDetails,
	type TaskDetails,
} from "./lib/task-render.ts";
import { createWorkerStreamParser, getFinalOutput } from "./lib/worker-stream.ts";

const WIDGET_ID = "subagent-lite";
const STATE_TYPE = "subagent-lite-state";
const WORKER_COMPLETE_TYPE = "subagent-lite-worker-complete";

type WorkerStatus = "running" | "done" | "failed";
interface WorkerRecord {
	id: string;
	agent: string;
	description: string;
	status: WorkerStatus;
	toolCallId?: string;
	output?: string;
	stderr?: string;
	exitCode?: number;
	summary?: string;
	durationMs?: number;
	toolCalls?: number;
	subResults?: TaskDetails["subResults"];
	proc?: ChildProcess;
}

interface SubprocessResult {
	exitCode: number;
	output: string;
	stderr: string;
	metrics: WorkerRunMetrics;
	subResults: TaskDetails["subResults"];
}

const TaskItem = Type.Object({
	prompt: Type.Optional(
		Type.String({
			description: "REQUIRED unless task/instruction/instructions is provided. Full instructions for this worker.",
		}),
	),
	task: Type.Optional(Type.String({ description: "Alias for prompt (deprecated)." })),
	instruction: Type.Optional(Type.String({ description: "Alias for prompt." })),
	instructions: Type.Optional(Type.String({ description: "Alias for prompt." })),
	agent: Type.Optional(Type.String()),
	description: Type.Optional(Type.String({ description: "Short widget label only — not a substitute for prompt." })),
});

const TaskParams = Type.Object({
	prompt: Type.Optional(
		Type.String({
			description:
				"REQUIRED for single-task mode. Full worker instructions. Every parallel task() call must include its own prompt — description alone is not enough.",
		}),
	),
	task: Type.Optional(Type.String({ description: "Alias for prompt." })),
	instruction: Type.Optional(Type.String({ description: "Alias for prompt." })),
	instructions: Type.Optional(Type.String({ description: "Alias for prompt." })),
	agent: Type.Optional(Type.String()),
	background: Type.Optional(Type.Boolean()),
	description: Type.Optional(
		Type.String({
			description: "Short widget label (e.g. '目录结构分析'). Does NOT replace prompt.",
		}),
	),
	tasks: Type.Optional(
		Type.Array(TaskItem, {
			description: "Batch mode: array of workers, each with its own prompt.",
		}),
	),
});

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const script = process.argv[1];
	if (script && !script.startsWith("/$bunfs/root/") && fs.existsSync(script)) {
		return { command: process.execPath, args: [script, ...args] };
	}
	const base = path.basename(process.execPath).toLowerCase();
	return /^(node|bun)(\.exe)?$/.test(base) ? { command: "pi", args } : { command: process.execPath, args };
}

async function writePromptFile(name: string, text: string): Promise<string | undefined> {
	if (!text) return undefined;
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-lite-"));
	const file = path.join(dir, `${name.replace(/[^\w.-]+/g, "_")}.md`);
	await fs.promises.writeFile(file, text, "utf-8");
	return file;
}

async function cleanupPromptFile(file?: string): Promise<void> {
	if (!file) return;
	try {
		await fs.promises.unlink(file);
		await fs.promises.rmdir(path.dirname(file));
	} catch {
		/* ignore */
	}
}

function startSubprocess(cwd: string, spawnArgs: string[], signal?: AbortSignal) {
	const { command, args } = getPiInvocation(spawnArgs);
	const proc = spawn(command, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
	const stream = createWorkerStreamParser();
	let buffer = "";
	let stderr = "";
	let aborted = false;
	const startedAt = Date.now();

	proc.stdout.on("data", (d) => {
		buffer += d.toString();
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		lines.forEach(stream.onLine);
	});
	proc.stderr.on("data", (d) => {
		stderr += d.toString();
	});

	const result = new Promise<SubprocessResult>((resolve) => {
		proc.on("close", (code) => {
			if (buffer.trim()) stream.onLine(buffer);
			const { messages, toolCalls, subResults } = stream.snapshot();
			const exitCode = aborted ? 130 : (code ?? 0);
			const assistant = getFinalOutput(messages).trim();
			const err = stderr.trim();
			const output = assistant || err || "(no output)";
			resolve({
				exitCode,
				output,
				stderr: err,
				metrics: { durationMs: Date.now() - startedAt, toolCalls },
				subResults,
			});
		});
		proc.on("error", () => {
			const { toolCalls, subResults } = stream.snapshot();
			resolve({
				exitCode: 1,
				output: stderr.trim() || "(spawn failed)",
				stderr: stderr.trim(),
				metrics: { durationMs: Date.now() - startedAt, toolCalls },
				subResults,
			});
		});
	});

	if (signal) {
		const kill = () => {
			aborted = true;
			proc.kill("SIGTERM");
			setTimeout(() => {
				if (!proc.killed) proc.kill("SIGKILL");
			}, 3000);
		};
		if (signal.aborted) kill();
		else signal.addEventListener("abort", kill, { once: true });
	}
	return { proc, result };
}

async function runWorkerWithRetry(
	cwd: string,
	args: string[],
	signal?: AbortSignal,
	onProc?: (proc: ChildProcess) => void,
): Promise<SubprocessResult> {
	const first = startSubprocess(cwd, args, signal);
	onProc?.(first.proc);
	let result = await first.result;
	const firstCheck = assessWorkerSuccess(result.exitCode, result.output, result.metrics);
	if (!firstCheck.ok && result.metrics.durationMs < FAST_FAIL_MS && !signal?.aborted) {
		const retry = startSubprocess(cwd, args, signal);
		onProc?.(retry.proc);
		result = await retry.result;
	}
	return result;
}

function hydrateTaskDetails(details: TaskDetails): TaskDetails {
	if (!details.subResults?.length) return details;
	const subResults = details.subResults.map((sr) => {
		const content = sr.content?.trim();
		const summary = sr.summary?.trim();
		if (!content && summary) {
			return { ...sr, content: summary };
		}
		return sr;
	});
	return { ...details, subResults };
}

function buildTaskDetails(rec: WorkerRecord): TaskDetails {
	return {
		workerId: rec.id,
		status: rec.status,
		output: rec.output,
		stderr: rec.stderr,
		exitCode: rec.exitCode,
		summary: rec.summary,
		description: rec.description,
		durationMs: rec.durationMs,
		toolCalls: rec.toolCalls,
		subResults: rec.subResults,
	};
}

export function builtin(pi: ExtensionAPI) {
	let agents = loadAgents();
	let workers = new Map<string, WorkerRecord>();
	const completedWorkers = new Map<string, TaskDetails>();
	const toolCallInvalidators = new Map<string, () => void>();
	let widgetCtx: ExtensionContext | null = null;
	let multitaskEnabled = true;
	let backgroundRunning = 0;

	const persistWorkerCompletion = (details: TaskDetails) => {
		const hydrated = hydrateTaskDetails(details);
		completedWorkers.set(hydrated.workerId, hydrated);
		pi.appendEntry(WORKER_COMPLETE_TYPE, hydrated);
	};

	const invalidateToolCall = (toolCallId?: string) => {
		if (!toolCallId) return;
		try {
			toolCallInvalidators.get(toolCallId)?.();
		} catch {
			/* never crash Pi from async worker completion */
		}
	};

	/** Keep coordinator prompts/tool schema out of the model when Multitask is OFF. */
	const syncTaskToolAvailability = () => {
		const active = pi.getActiveTools();
		const hasTask = active.includes("task");
		if (multitaskEnabled && !hasTask) {
			pi.setActiveTools([...active, "task"]);
		} else if (!multitaskEnabled && hasTask) {
			pi.setActiveTools(active.filter((name) => name !== "task"));
		}
	};

	const updateWidget = () => {
		if (!widgetCtx) return;
		const list = [...workers.values()].slice(-5);
		const running = list.filter((w) => w.status === "running").length;
		if (!list.length) {
			widgetCtx.ui.setWidget(WIDGET_ID, multitaskEnabled ? [`⚡ 0 running · Multitask ON`] : []);
			return;
		}
		const modeLabel = multitaskEnabled ? "Multitask ON" : "Multitask OFF";
		const lines = [`⚡ ${running} running · ${modeLabel}`];
		for (const w of list) {
			const icon = w.status === "running" ? "●" : w.status === "done" ? "✓" : "✗";
			let line = `┃ ${icon} ${(w.description || w.agent).slice(0, 48)}`;
			if (w.status !== "running" && w.durationMs != null) {
				const timing =
					w.status === "failed" ? `failed in ${formatDuration(w.durationMs)}` : formatDuration(w.durationMs);
				line += ` · ${timing}`;
				if (w.toolCalls != null) line += ` · ${w.toolCalls} tools`;
			}
			if (w.status !== "running" && w.summary) {
				const hint = summarizeOutput(w.summary, WIDGET_SUMMARY_MAX);
				if (hint && hint !== "(no output)") line += ` — ${hint}`;
			}
			lines.push(line);
		}
		widgetCtx.ui.setWidget(WIDGET_ID, lines.slice(0, 6));
	};

	async function runTask(
		cwd: string,
		prompt: string,
		agentName: string,
		desc: string,
		background: boolean,
		sessionModel: string | undefined,
		toolCallId?: string,
		signal?: AbortSignal,
		onUpdate?: (partial: AgentToolResult<TaskDetails>) => void,
	) {
		const agent = findAgent(agents, agentName);
		if (!agent) throw new Error(`Unknown agent "${agentName}"`);
		if (!sessionModel && !agent.model) {
			throw new Error("Worker spawn requires a model: configure parent session model or agent frontmatter `model:`");
		}
		const id = crypto.randomUUID().slice(0, 8);
		const rec: WorkerRecord = {
			id,
			agent: agentName,
			description: desc || agentName,
			status: "running",
			toolCallId,
		};
		workers.set(id, rec);
		updateWidget();
		const promptFile = await writePromptFile(agent.name, agent.systemPrompt);
		const args = buildSpawnArgs(agent, prompt, { systemPromptFile: promptFile, sessionModel });

		const finish = (r: SubprocessResult) => {
			const assessment = assessWorkerSuccess(r.exitCode, r.output, r.metrics);
			const ok = assessment.ok;
			rec.durationMs = r.metrics.durationMs;
			rec.toolCalls = r.metrics.toolCalls;
			rec.subResults = r.subResults;
			rec.status = ok ? "done" : "failed";
			rec.exitCode = r.exitCode;
			rec.stderr = r.stderr;
			rec.output = ok
				? r.output
				: `${formatWorkerFailure(r.exitCode, r.stderr, r.output)}${assessment.reason ? `\n\nDiagnosis: ${assessment.reason}` : ""}`;
			rec.summary = summarizeOutput(rec.output);
			rec.proc = undefined;
			updateWidget();
			const details = buildTaskDetails(rec);
			const followUp = buildWorkerCompleteFollowUp(
				id,
				rec.description,
				ok,
				rec.output,
				r.exitCode,
				r.metrics,
				assessment.reason,
			);
			if (background) {
				persistWorkerCompletion(details);
				invalidateToolCall(rec.toolCallId);
			} else {
				onUpdate?.({ content: [{ type: "text", text: followUp }], details });
			}
			return { followUp, details, ok };
		};

		const notifyBackgroundComplete = (followUp: string, details: TaskDetails) => {
			// Subprocess `close` runs outside Pi's agent run. Defer sendMessage so the
			// session is idle before we inject a follow-up and trigger a coordinator turn.
			setTimeout(() => {
				try {
					pi.sendMessage(
						{
							customType: "subagent-lite-complete",
							content: followUp,
							display: true,
							details,
						},
						{ triggerTurn: true, deliverAs: "followUp" },
					);
				} catch {
					/* never crash Pi from async worker completion */
				}
			}, 0);
		};

		if (background) {
			backgroundRunning++;
			runWorkerWithRetry(cwd, args, undefined, (proc) => {
				rec.proc = proc;
				updateWidget();
			})
				.then((r) => {
					const { followUp, details } = finish(r);
					notifyBackgroundComplete(followUp, details);
				})
				.finally(async () => {
					backgroundRunning = Math.max(0, backgroundRunning - 1);
					await cleanupPromptFile(promptFile);
				});
			return { workerId: id, status: "running" as const };
		}

		try {
			const r = await runWorkerWithRetry(cwd, args, signal);
			finish(r);
			return {
				workerId: id,
				status: rec.status,
				output: rec.output,
				stderr: rec.stderr,
				exitCode: rec.exitCode,
				summary: rec.summary,
				description: rec.description,
				durationMs: rec.durationMs,
				toolCalls: rec.toolCalls,
				subResults: rec.subResults,
			};
		} finally {
			await cleanupPromptFile(promptFile);
		}
	}

	pi.on("session_start", async (_e, ctx) => {
		agents = loadAgents();
		workers = new Map();
		completedWorkers.clear();
		toolCallInvalidators.clear();
		backgroundRunning = 0;
		widgetCtx = ctx;
		multitaskEnabled = false;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === STATE_TYPE && (entry.data as any)?.multitaskEnabled) {
				multitaskEnabled = true;
			}
			if (entry.type === "custom" && entry.customType === WORKER_COMPLETE_TYPE) {
				const details = hydrateTaskDetails(entry.data as TaskDetails);
				if (details?.workerId) completedWorkers.set(details.workerId, details);
			}
		}
		syncTaskToolAvailability();
		updateWidget();
	});

	pi.on("session_shutdown", async (_e, ctx) => {
		for (const w of workers.values()) w.proc?.kill("SIGTERM");
		workers.clear();
		ctx.ui.setWidget(WIDGET_ID, []);
		widgetCtx = null;
	});

	pi.on("before_agent_start", async () => {
		if (!multitaskEnabled) return;
		return { message: { customType: "subagent-lite-hint", content: buildCoordinatorHint(), display: false } };
	});

	pi.on("tool_call", async (event) => {
		if (event.toolName === "task" && !multitaskEnabled) {
			return { block: true, reason: buildTaskDisabledReason() };
		}
		if (!multitaskEnabled || event.toolName === "task" || !COORDINATOR_BLOCKED_TOOLS.has(event.toolName)) return;
		return { block: true, reason: buildBlockedToolReason(event.toolName) };
	});

	pi.registerCommand("multitask", {
		description: "Toggle multitask coordinator mode",
		handler: async (_a, ctx) => {
			multitaskEnabled = !multitaskEnabled;
			pi.appendEntry(STATE_TYPE, { multitaskEnabled });
			syncTaskToolAvailability();
			widgetCtx = ctx;
			updateWidget();
			const text = buildToggleMessage(multitaskEnabled);
			if (ctx.hasUI) ctx.ui.notify(multitaskEnabled ? "Multitask ON" : "Multitask OFF", "info");
			else console.info(text);
			pi.sendMessage({ customType: "subagent-lite-status", content: text, display: true }, { triggerTurn: false });
		},
	});

	pi.registerTool({
		name: "task",
		label: "Task Worker",
		description: TASK_DESCRIPTION,
		promptSnippet: "Delegate work to isolated workers; prefer background:true for async single workers",
		promptGuidelines: TASK_PROMPT_GUIDELINES,
		parameters: TaskParams,
		renderCall(args, theme) {
			if (Array.isArray(args.tasks) && args.tasks.length > 0) {
				const text =
					theme.fg("toolTitle", theme.bold("task ")) +
					theme.fg("accent", "parallel") +
					theme.fg("muted", ` · ${args.tasks.length} workers`);
				return new Text(text, 0, 0);
			}
			const desc = args.description ?? resolveTaskPrompt(args)?.slice(0, 60) ?? "worker";
			const mode = args.background ? "bg" : "fg";
			const text =
				theme.fg("toolTitle", theme.bold("task ")) +
				theme.fg("accent", desc) +
				theme.fg("muted", ` · ${mode}`);
			return new Text(text, 0, 0);
		},
		renderResult(result, _opts, theme, context) {
			if (context.toolCallId) {
				toolCallInvalidators.set(context.toolCallId, context.invalidate);
			}

			const stored = (context as { result?: AgentToolResult<TaskDetails | ParallelTaskDetails> }).result ?? result;
			const storedDetails = stored.details as TaskDetails | ParallelTaskDetails | undefined;

			// Simple status display: "worked" or "working" + description
			if (isParallelTaskDetails(storedDetails)) {
				const allDone = storedDetails.results.every((r) => r.status === "done" || r.status === "failed");
				const failed = storedDetails.results.some((r) => r.status === "failed");
				const label = allDone
					? (failed ? theme.fg("error", "worked") : theme.fg("success", "worked"))
					: theme.fg("warning", "working");
				const count = `${storedDetails.results.length} workers`;
				return new Text(theme.fg("toolTitle", theme.bold("task ")) + label + theme.fg("muted", ` · ${count}`), 0, 0);
			}

			if (!storedDetails?.workerId) {
				const body = stored.content?.[0]?.type === "text" ? stored.content[0].text : "";
				return new Text(body, 0, 0);
			}

			const live = workers.get(storedDetails.workerId);
			const completed = completedWorkers.get(storedDetails.workerId);
			const details = resolveTaskDetails(storedDetails, live ? buildTaskDetails(live) : undefined, completed);
			if (!details) return new Text("", 0, 0);

			const isRunning = details.status === "running";
			const isFailed = details.status === "failed";
			const statusLabel = isRunning
				? theme.fg("warning", "working")
				: (isFailed ? theme.fg("error", "worked") : theme.fg("success", "worked"));
			const desc = details.description || storedDetails.workerId;
			const duration = details.durationMs ? theme.fg("dim", ` · ${formatDuration(details.durationMs)}`) : "";
			return new Text(
				theme.fg("toolTitle", theme.bold("task ")) + statusLabel + theme.fg("muted", ` · ${desc}`) + duration,
				0, 0,
			);
		},
		async execute(_id, params: RawTaskParams, signal, onUpdate, ctx) {
			if (!multitaskEnabled) {
				return { content: [{ type: "text", text: buildTaskDisabledReason() }], isError: true, details: undefined };
			}
			widgetCtx = ctx;
			agents = loadAgents();
			const sessionModel = formatSessionModel(ctx.model);
			if (params.tasks?.length) {
				const normalized = params.tasks.map(normalizeTaskItem);
				if (normalized.length > MAX_BACKGROUND) {
					return {
						content: [{ type: "text", text: `Error: max ${MAX_BACKGROUND} parallel workers in tasks[]` }],
						isError: true,
						details: undefined,
					};
				}
				const missing = normalized.findIndex((t) => !t.prompt);
				if (missing >= 0) {
					return {
						content: [
							{ type: "text", text: `Error: tasks[${missing}].prompt is required (full worker instructions).` },
						],
						isError: true,
						details: undefined,
					};
				}
				const results = await Promise.all(
					normalized.map((t) =>
						runTask(
							ctx.cwd,
							t.prompt,
							t.agent ?? "worker",
							t.description ?? t.prompt.slice(0, 40),
							false,
							sessionModel,
							_id,
							signal,
						),
					),
				);
				const taskResults: TaskDetails[] = results.map((r) => {
					const rec = workers.get(r.workerId);
					if (rec) return buildTaskDetails(rec);
					return {
						workerId: r.workerId,
						status: r.status,
						output: r.output,
						stderr: r.stderr,
						exitCode: r.exitCode,
						summary: r.summary,
						description: r.description,
						durationMs: r.durationMs,
						toolCalls: r.toolCalls,
						subResults: r.subResults,
					};
				});
				return {
					content: [
						{
							type: "text",
							text: taskResults.map((r, i) => `${i + 1}. #${r.workerId}\n${r.output ?? ""}`).join("\n\n---\n\n"),
						},
					],
					details: { parallel: true as const, results: taskResults },
					isError: taskResults.some((r) => r.status === "failed"),
				};
			}
			const prompt = resolveTaskPrompt(params);
			if (!prompt) {
				return {
					content: [{ type: "text", text: buildMissingPromptError(params) }],
					isError: true,
					details: undefined,
				};
			}
			if (params.background && backgroundRunning >= MAX_BACKGROUND) {
				return {
					content: [{ type: "text", text: `Error: max ${MAX_BACKGROUND} background workers` }],
					isError: true,
					details: undefined,
				};
			}
			try {
				const desc = params.description ?? prompt.slice(0, 40);
				const r = await runTask(
					ctx.cwd,
					prompt,
					params.agent ?? "worker",
					desc,
					Boolean(params.background),
					sessionModel,
					_id,
					signal,
					onUpdate,
				);
				if (params.background) {
					return {
						content: [{ type: "text", text: `Worker #${r.workerId} running in background` }],
						details: { workerId: r.workerId, status: "running", description: desc },
					};
				}
				const rec = workers.get(r.workerId);
				const failed = r.status === "failed";
				return {
					content: [{ type: "text", text: r.summary ?? summarizeOutput(r.output ?? "", 160) }],
					details: rec
						? buildTaskDetails(rec)
						: {
								workerId: r.workerId,
								status: r.status,
								output: r.output,
								stderr: r.stderr,
								exitCode: r.exitCode,
								summary: r.summary,
								description: desc,
								subResults: r.subResults,
							},
					isError: failed,
				};
			} catch (err) {
				return {
					content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
					isError: true,
					details: undefined,
				};
			}
		},
	});
}
