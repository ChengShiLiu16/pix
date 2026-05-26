/**
 * Tiered scoring for when to inject a todo_manage hint before agent start.
 * Conservative by design — prefer missing multi-task hints over false triggers.
 */

export type TodoTriggerResult = {
	shouldTrigger: boolean;
	score: number;
	threshold: number;
	signals: string[];
};

export const TODO_TRIGGER_THRESHOLD = 5;

const MIN_LENGTH = 24;

/** Hard suppress — never trigger regardless of score. */
const HARD_SUPPRESSORS: RegExp[] = [
	/^(?:什么是|解释|说明|为什么|怎么理解|帮我看看|阅读|查看|读取)\b/u,
	/^(?:分析|了解|梳理).{0,40}(?:项目|代码库).{0,40}(?:快速上手|全景图)/u,
	/^(?:这个|这段|这行|这里)/u,
	/(?:方案|思路|选择|比较|区别|优缺点|利弊|是否可以|能不能)(?!.*(?:实现|修复|添加|删除|更新|创建|重构|编写|改|跑|运行|测试|部署|安装|配置|迁移|优化|排查|检查|整理|提交|合并|拉取|推送|下载|上传|导出|导入|解决|完成|处理|执行|搭建|构建|生成|移除|清理|验证|确认|设置|修改|调整|翻译|总结|对比|搜索|查找|备份|恢复))/u,
	/(?:有\s*哪些|包含什么|由.*组成|结构是|架构是)/u,
	/^(?:你好|谢谢|感谢|好的|ok|okay|hi|hello)\b/i,
	/(?:举个例子|比如说|例如说|假如|假设|如果只是|要是.*的话)/u,
];

const ACTION_VERB =
	/(?:实现|修复|添加|删除|更新|创建|重构|编写|写|改|跑|运行|测试|部署|安装|配置|迁移|优化|排查|检查|整理|提交|合并|拉取|推送|读取|查看|下载|上传|导出|导入|解决|完成|处理|执行|搭建|构建|生成|移除|清理|验证|确认|设置|修改|调整|翻译|总结|对比|搜索|查找|备份|恢复|refactor|implement|fix|add|create|update|write|run|test|deploy|install|configure|migrate|build|remove|verify|check)/iu;

const NUMBERED_ITEM = /(?:^|[\s：:\n])\d+[.)）、]\s+|(?:^|\n)\s*第[一二三四五六七八九十百千\d]+步[：:、]?\s*/gu;

const BULLET_LINE = /(?:^|\n)\s*[-*•·]\s*(.+)/gu;

const MULTI_TASK_PHRASES: Array<{ pattern: RegExp; label: string; weight: number }> = [
	{
		pattern:
			/(?:多个任务|分别(?:做|处理|完成|执行)|并行(?:做|处理|完成|执行)?|同时(?:做|处理|完成|执行)|依次|分步|逐个(?:做|完成|处理)|一件事.{0,12}另一件)/u,
		label: "多任务词",
		weight: 3,
	},
	{ pattern: /(?:首先|第一步).{0,40}(?:然后|接着|第二步|其次|最后)/u, label: "步骤链", weight: 3 },
	{ pattern: /(?:first.{0,20}then|step\s*1.{0,20}step\s*[23])/iu, label: "steps", weight: 3 },
	{
		pattern: /(?:帮我|请(?:你|帮忙)?|需要(?:你|帮忙)?).{0,6}(?:做|完成|处理|实现|修复|改|写)/u,
		label: "执行请求",
		weight: 1,
	},
];

function countMatches(text: string, pattern: RegExp): number {
	const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
	return [...text.matchAll(re)].length;
}

function countNumberedItems(text: string): number {
	return countMatches(text, NUMBERED_ITEM);
}

function countActionBulletLines(text: string): number {
	let count = 0;
	for (const match of text.matchAll(BULLET_LINE)) {
		const line = match[1]?.trim() ?? "";
		if (line.length >= 4 && ACTION_VERB.test(line)) count++;
	}
	return count;
}

function countCommaEnumerations(text: string): { segments: number; actionSegments: number } {
	const parts = text
		.split(/[、，,;；]+/u)
		.map((p) => p.trim())
		.filter((p) => p.length >= 2);
	if (parts.length < 3) return { segments: 0, actionSegments: 0 };
	const actionSegments = parts.filter((p) => ACTION_VERB.test(p)).length;
	return { segments: parts.length, actionSegments };
}

function quotedRatio(text: string): number {
	const quoted = text.match(/["'「『""''"].*?["'」』""''"]/gu)?.join("") ?? "";
	if (!text.length) return 0;
	return quoted.length / text.length;
}

function isQuestionOnly(text: string, numbered: number, bullets: number): boolean {
	if (!/[?？]\s*$/.test(text)) return false;
	return numbered < 2 && bullets < 2;
}

function isAnalysisOnly(text: string, numbered: number, bullets: number): boolean {
	if (!/(?:分析一下|帮我分析|分析下|分析一下这个)/u.test(text)) return false;
	return numbered < 2 && bullets < 2;
}

function isSingleShortImperative(text: string, numbered: number, bullets: number, enumCount: number): boolean {
	if (numbered >= 2 || bullets >= 2 || enumCount >= 3) return false;
	const lines = text
		.split(/\n/u)
		.map((l) => l.trim())
		.filter(Boolean);
	if (lines.length > 1) return false;
	if (countNumberedItems(text) >= 2) return false;
	return text.length < 48 && ACTION_VERB.test(text);
}

/** Score user prompt; trigger when score >= TODO_TRIGGER_THRESHOLD. */
export function scoreTodoTrigger(input: string): TodoTriggerResult {
	const text = input.trim();
	const signals: string[] = [];
	let score = 0;

	if (!text) {
		return { shouldTrigger: false, score: 0, threshold: TODO_TRIGGER_THRESHOLD, signals: [] };
	}

	if (HARD_SUPPRESSORS.some((p) => p.test(text))) {
		return { shouldTrigger: false, score: 0, threshold: TODO_TRIGGER_THRESHOLD, signals: ["硬抑制"] };
	}

	const numbered = countNumberedItems(text);
	if (numbered >= 2) {
		const pts = Math.min(numbered * 2, 6);
		score += pts;
		signals.push(`编号项×${numbered}(+${pts})`);
	}

	const bullets = countActionBulletLines(text);
	if (bullets >= 2) {
		const pts = Math.min(bullets * 2, 6);
		score += pts;
		signals.push(`动作列表×${bullets}(+${pts})`);
	}

	for (const { pattern, label, weight } of MULTI_TASK_PHRASES) {
		if (pattern.test(text)) {
			score += weight;
			signals.push(`${label}(+${weight})`);
		}
	}

	const { segments, actionSegments } = countCommaEnumerations(text);
	const strongEnumeration = segments >= 3 && actionSegments >= 2;
	if (strongEnumeration) {
		score += 4;
		signals.push(`枚举任务×${segments}(+4)`);
	} else if (segments >= 3 && actionSegments >= 1 && numbered >= 1) {
		score += 2;
		signals.push(`弱枚举×${segments}(+2)`);
	}

	if (text.length < MIN_LENGTH && numbered < 2 && bullets < 2 && !strongEnumeration) {
		score -= 3;
		signals.push("过短(-3)");
	}

	if (isQuestionOnly(text, numbered, bullets)) {
		score -= 5;
		signals.push("纯提问(-5)");
	}

	if (isAnalysisOnly(text, numbered, bullets)) {
		score -= 4;
		signals.push("仅分析(-4)");
	}

	if (isSingleShortImperative(text, numbered, bullets, segments)) {
		score -= 3;
		signals.push("单步指令(-3)");
	}

	if (quotedRatio(text) > 0.55 && numbered < 2 && bullets < 2) {
		score -= 4;
		signals.push("引用示例(-4)");
	}

	const shouldTrigger = score >= TODO_TRIGGER_THRESHOLD;
	return {
		shouldTrigger,
		score,
		threshold: TODO_TRIGGER_THRESHOLD,
		signals,
	};
}

export function buildTodoTriggerHint(result: TodoTriggerResult): string {
	const signalSummary = result.signals.length ? result.signals.join("，") : "多步任务";
	return [
		`用户消息包含多个可执行的独立任务（${signalSummary}，得分 ${result.score}/${result.threshold}）。`,
		"请用 todo_manage 跟踪进度：",
		"1. 先用 add 把所有步骤加入列表",
		"2. 执行某步时用 start 标记进行中（同时只能有一个 in_progress）",
		"3. 完成后用 done 标记",
		"若实际只是单步操作、问答或讨论，忽略此提示，不要创建 todo。",
	].join("\n");
}
