/**
 * compaction 摘要质量的启发式检查。
 *
 * 这些指标只用于观测，不等同于语义等价证明。
 */

export interface SummaryQualityMetrics {
	compressionRatio: number;
	keyItemRetention: number;
	structurePreservation: number;
	anchorRetention: number;
	requiredSectionRetention: number;
	userConstraintRetention: number;
	nextStepRetention: number;
	criticalAnchorCount: number;
	lostCriticalAnchorCount: number;
}

const REQUIRED_SUMMARY_SECTIONS = [
	"Goal",
	"Constraints & Preferences",
	"Progress",
	"Key Decisions",
	"Next Steps",
	"Critical Context",
];

/** 使用词集合相似度判断短条目是否在重新摘要后保留。 */
function itemSimilarity(a: string, b: string): number {
	const words = (s: string): Set<string> =>
		new Set(
			s
				.toLowerCase()
				.split(/[^a-z0-9]+/u)
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

function anchorsMatch(a: string, b: string): boolean {
	if (a === b) return true;
	const [short, long] = a.length <= b.length ? [a, b] : [b, a];
	return short.length >= 4 && long.includes(short);
}

function parseSummarySectionMap(text: string): Map<string, string> {
	const result = new Map<string, string>();
	const lines = text.split("\n");
	let currentSection = "";
	let currentContent: string[] = [];

	for (const line of lines) {
		const sectionMatch = /^##\s+(.+)$/u.exec(line);
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

function extractSummaryItems(sectionText: string): string[] {
	return sectionText
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.startsWith("- ") || line.startsWith("- [") || /^\d+\./u.test(line))
		.map((line) =>
			line
				.replace(/^[-*]\s*\[?[x\s]?\]?\s*/u, "")
				.replace(/^\d+\.\s*/u, "")
				.trim(),
		)
		.filter((line) => line.length > 0 && line !== "(none)" && line !== "(none recorded)");
}

function itemRetention(prevItems: string[], newItems: string[]): number {
	if (prevItems.length === 0) return 1;
	let keptItems = 0;
	for (const prevItem of prevItems) {
		if (newItems.some((item) => itemSimilarity(prevItem, item) >= 0.5)) {
			keptItems++;
		}
	}
	return keptItems / prevItems.length;
}

function extractCriticalAnchors(text: string): string[] {
	const anchors: string[] = [];
	anchors.push(
		...(text.match(/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_\-/.]+\.(ts|js|tsx|jsx|py|rs|go|java|cpp|c|h|json|md|txt)/gu) ?? []),
	);
	anchors.push(...(text.match(/\b[a-z][a-zA-Z0-9]*\(\)/gu) ?? []));
	anchors.push(...(text.match(/"[^"]{10,}"/gu) ?? []));
	return [...new Set(anchors)].filter((anchor) => anchor.length >= 4);
}

/**
 * 用轻量启发式分析摘要质量。
 *
 * 注意：质量指标基于模型原始输出（raw summary）计算，不包含后处理恢复的锚点。
 * 这确保指标能真实反映模型的摘要能力，而不是被后处理掩盖的丢失。
 *
 * 结果适合看趋势，不能证明语义完全保留。
 */
export function analyzeSummaryQuality(
	previousSummary: string,
	newSummary: string,
	estimateTextTokens: (text: string) => number,
): SummaryQualityMetrics {
	const prevSections = parseSummarySectionMap(previousSummary);
	const newSections = parseSummarySectionMap(newSummary);

	const prevTokens = estimateTextTokens(previousSummary);
	const newTokens = estimateTextTokens(newSummary);
	const compressionRatio = prevTokens > 0 ? newTokens / prevTokens : 1;

	let totalItems = 0;
	let keptItems = 0;
	for (const section of REQUIRED_SUMMARY_SECTIONS) {
		const prevItems = extractSummaryItems(prevSections.get(section) ?? "");
		const newItems = extractSummaryItems(newSections.get(section) ?? "");
		totalItems += prevItems.length;
		for (const prevItem of prevItems) {
			if (newItems.some((n) => itemSimilarity(prevItem, n) >= 0.5)) {
				keptItems++;
			}
		}
	}
	const keyItemRetention = totalItems > 0 ? keptItems / totalItems : 1;

	const preservedSections = REQUIRED_SUMMARY_SECTIONS.filter((s) => newSections.has(s)).length;
	const structurePreservation = preservedSections / REQUIRED_SUMMARY_SECTIONS.length;

	const prevAnchors = extractCriticalAnchors(previousSummary);
	const newAnchors = extractCriticalAnchors(newSummary);
	let keptAnchors = 0;
	for (const anchor of prevAnchors) {
		if (newAnchors.some((newAnchor) => anchorsMatch(anchor, newAnchor))) keptAnchors++;
	}
	const anchorRetention = prevAnchors.length > 0 ? keptAnchors / prevAnchors.length : 1;
	const userConstraintRetention = itemRetention(
		extractSummaryItems(prevSections.get("Constraints & Preferences") ?? ""),
		extractSummaryItems(newSections.get("Constraints & Preferences") ?? ""),
	);
	const nextStepRetention = itemRetention(
		extractSummaryItems(prevSections.get("Next Steps") ?? ""),
		extractSummaryItems(newSections.get("Next Steps") ?? ""),
	);

	return {
		compressionRatio,
		keyItemRetention,
		structurePreservation,
		anchorRetention,
		requiredSectionRetention: structurePreservation,
		userConstraintRetention,
		nextStepRetention,
		criticalAnchorCount: prevAnchors.length,
		lostCriticalAnchorCount: prevAnchors.length - keptAnchors,
	};
}

/**
 * 恢复旧摘要中记录过、但本轮重新摘要遗漏的关键锚点。
 *
 * 这里不再补空章节；空章节会把结构缺失伪装成保留成功。恢复的锚点也
 * 不能当作模型原始保留质量，所以调用方必须先用 raw summary 计算指标。
 */
export function preserveCriticalAnchors(
	summary: string,
	previousSummary: string | undefined,
): { summary: string; restoredCriticalAnchorCount: number } {
	const next = summary.trim();
	if (!previousSummary) return { summary: next, restoredCriticalAnchorCount: 0 };
	const lostAnchors = extractCriticalAnchors(previousSummary).filter((anchor) => !next.includes(anchor));
	if (lostAnchors.length === 0) return { summary: next, restoredCriticalAnchorCount: 0 };
	const restored = lostAnchors.slice(0, 20);
	const lines = [
		next,
		"",
		"## Critical Context Anchors Preserved",
		"- Restored from the previous summary because the model output dropped these anchors; re-verify before treating them as current facts.",
		...restored.map((anchor) => `- ${anchor}`),
	];
	if (lostAnchors.length > restored.length) {
		lines.push(`- ... ${lostAnchors.length - restored.length} more anchors omitted`);
	}
	return { summary: lines.join("\n"), restoredCriticalAnchorCount: restored.length };
}
