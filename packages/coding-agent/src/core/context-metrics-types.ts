/**
 * Event types for structured context metrics.
 */

export type ContextPhase = "optimize_start" | "git_evidence_transform" | "aging" | "stale_prune" | "optimize_end";

export interface ContextPhaseEvent {
	timestamp: number;
	sessionId: string;
	phase: ContextPhase;
	contextWindow: number;
	tokensBefore: number;
	tokensAfter: number;
	ratioBefore: number;
	ratioAfter: number;
	durationMs: number;
}

export interface CompactionEvent {
	timestamp: number;
	sessionId: string;
	reason: "manual" | "threshold" | "overflow";
	summaryTokensBefore: number;
	summaryTokensAfter: number;
	keptRecentTokens: number;
	droppedMessages: number;
	compactTemplateUsed: boolean;
	doubleCompactTriggered: boolean;
	durationMs: number;
}

export interface CompactionQualityEvent {
	timestamp: number;
	sessionId: string;
	compressionRatio: number; // outputTokens / inputTokens
	keyItemRetention: number; // keptKeyItems / totalKeyItems (of previous summary)
	structurePreservation: number; // sectionsPreserved / totalSections
	anchorRetention: number; // anchorsPreserved / totalAnchors
	requiredSectionRetention: number; // 已保留必需章节 / 必需章节总数
	userConstraintRetention: number; // 已保留用户约束 / 旧约束总数
	nextStepRetention: number; // 已保留下一步 / 旧下一步总数
	criticalAnchorCount: number;
	lostCriticalAnchorCount: number;
	compactTemplateUsed: boolean;
	doubleCompactTriggered: boolean;
}

export interface TokenEstimationEvent {
	timestamp: number;
	sessionId: string;
	contextWindow: number;
	estimatedTokens: number;
	messageCount: number;
	hasUsageData: boolean;
}

export type MetricsEvent =
	| { type: "context_phase"; event: ContextPhaseEvent }
	| { type: "compaction"; event: CompactionEvent }
	| { type: "compaction_quality"; event: CompactionQualityEvent }
	| { type: "token_estimation"; event: TokenEstimationEvent };
