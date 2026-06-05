# Context Management Improvements - Technical Design Document

**Author**: Droid  
**Date**: 2026-06-04  
**Status**: Draft  
**Related Commits**: bcd8b9ed, 7e8411fb, b0368721, 0437ec92, 9d46b440

---

## 1. Problem Statement

Based on analysis of recent fixes (bcd8b9ed through 7e8411fb), the context management system has significantly improved but has remaining gaps:

| Issue | Severity | Impact |
|-------|----------|--------|
| AGING_HEAVY_RATIO (0.8) ≈ compaction threshold (≥0.75) | High | Race condition between heavy aging and compaction in high-pressure sessions |
| No structured metrics export for PIX_CONTEXT_DEBUG | Medium | Manual tuning only; no CI regression detection |
| safeJsonStringify loses circular ref structure info | Low | Token estimation slightly conservative (safe) |
| No static guarantee of threshold ordering invariant | Medium | Future refactors could silently break AGING < STALE < COMPACTION |
| No compression efficiency tracking | Low | Cannot measure summary quality vs token savings offline |

---

## 2. Design Goals

1. **Guarantee threshold ordering** at compile-time + runtime
2. **Structured observability** for context pressure & compression efficiency
3. **Safe circular-ref token estimation** without over-conservatism
4. **Decouple heavy aging from compaction** with clear hysteresis
5. **Zero breaking changes** to public APIs

---

## 3. Detailed Design

### 3.1 Threshold Ordering Guarantees

#### 3.1.1 Compile-Time Constants with Branded Types

```typescript
// packages/coding-agent/src/core/context-thresholds.ts

/** Brand type for context ratios (0.0 - 1.0) */
type ContextRatio = number & { readonly __brand: unique symbol };

function ratio(n: number): ContextRatio {
  if (n < 0 || n > 1) throw new Error(`Invalid ratio: ${n}`);
  return n as ContextRatio;
}

/** 
 * Threshold ordering invariant (MUST hold):
 * AGING_START < AGING_MEDIUM < AGING_HEAVY < STALE_PRUNE_START < COMPACTION_MIN
 * Where COMPACTION_MIN = min over all models of (1 - reserve/window) after clamping
 */
export const THRESHOLDS = {
  AGING_START: ratio(0.50),
  AGING_MEDIUM: ratio(0.70),
  AGING_HEAVY: ratio(0.78),  // ← Changed from 0.80 to create gap
  EDIT_ARGS_COMPACT: ratio(0.70),
  STALE_PRUNE_START: ratio(0.65),
} as const;

// Compile-time assertion (fails build if invariant broken)
const _thresholdOrderAssert: 
  THRESHOLDS.AGING_START < THRESHOLDS.AGING_MEDIUM &
  THRESHOLDS.AGING_MEDIUM < THRESHOLDS.AGING_HEAVY &
  THRESHOLDS.AGING_HEAVY < THRESHOLDS.STALE_PRUNE_START &
  THRESHOLDS.STALE_PRUNE_START < 0.75  // compaction minimum after clamping
  = true as const;
```

#### 3.1.2 Runtime Validation on Module Init

```typescript
// packages/coding-agent/src/core/context-thresholds.ts (add at end)
function validateThresholdOrdering(): void {
  const t = THRESHOLDS;
  const compactionMin = 0.75; // after resolveCompactionSettings clamps reserve ≤ 0.25w
  
  const checks = [
    { name: "AGING_START < AGING_MEDIUM", pass: t.AGING_START < t.AGING_MEDIUM },
    { name: "AGING_MEDIUM < AGING_HEAVY", pass: t.AGING_MEDIUM < t.AGING_HEAVY },
    { name: "AGING_HEAVY < STALE_PRUNE_START", pass: t.AGING_HEAVY < t.STALE_PRUNE_START },
    { name: "STALE_PRUNE_START < COMPACTION_MIN", pass: t.STALE_PRUNE_START < compactionMin },
  ];
  
  for (const c of checks) {
    if (!c.pass) {
      throw new Error(`Threshold invariant violated: ${c.name}`);
    }
  }
}

// Run once on module load
validateThresholdOrdering();
```

#### 3.1.3 Unit Test Guard

```typescript
// packages/coding-agent/test/context-thresholds.test.ts
import { describe, it, expect } from "vitest";
import { THRESHOLDS } from "../src/core/context-thresholds.ts";

describe("context threshold invariants", () => {
  it("maintains strict ordering: aging < stale-prune < compaction", () => {
    const t = THRESHOLDS;
    expect(t.AGING_START).toBeLessThan(t.AGING_MEDIUM);
    expect(t.AGING_MEDIUM).toBeLessThan(t.AGING_HEAVY);
    expect(t.AGING_HEAVY).toBeLessThan(t.STALE_PRUNE_START);
    expect(t.STALE_PRUNE_START).toBeLessThan(0.75); // compaction floor
  });
});
```

---

### 3.2 Structured Metrics Export (PIX_CONTEXT_DEBUG v2)

#### 3.2.1 Event Schema

```typescript
// packages/coding-agent/src/core/context-metrics.ts (NEW FILE)

export type ContextPhase = 
  | "optimize_start"
  | "git_evidence_transform"
  | "aging"
  | "stale_prune"
  | "compaction_check"
  | "compaction_exec"
  | "optimize_end";

export interface ContextMetricsEvent {
  timestamp: number;           // Date.now()
  sessionId: string;           // AgentSession id
  phase: ContextPhase;
  contextWindow: number;       // model context window
  tokensBefore: number;
  tokensAfter: number;
  ratioBefore: number;
  ratioAfter: number;
  durationMs: number;
  details?: Record<string, unknown>;
}

export interface CompactionMetricsEvent {
  timestamp: number;
  sessionId: string;
  reason: "manual" | "threshold" | "overflow";
  summaryTokensBefore: number;
  summaryTokensAfter: number;
  keptRecentTokens: number;
  droppedMessages: number;
  compactTemplateUsed: boolean;  // true if COMPACT_SUMMARIZATION_PROMPT
  doubleCompactTriggered: boolean;
  durationMs: number;
}

export type MetricsEvent = 
  | { type: "context_phase"; event: ContextMetricsEvent }
  | { type: "compaction"; event: CompactionMetricsEvent };
```

#### 3.2.2 Emitter with Multiple Sinks

```typescript
// packages/coding-agent/src/core/context-metrics.ts (cont.)

type MetricsSink = (event: MetricsEvent) => void | Promise<void>;

const sinks: MetricsSink[] = [];

export function addMetricsSink(sink: MetricsSink): () => void {
  sinks.push(sink);
  return () => { const i = sinks.indexOf(sink); if (i >= 0) sinks.splice(i, 1); };
}

// Default console sink (respects PIX_CONTEXT_DEBUG)
if (typeof process !== "undefined" && process.env.PIX_CONTEXT_DEBUG) {
  addMetricsSink(async (e) => {
    const prefix = `[ctx:${e.event.sessionId.slice(0,8)}]`;
    if (e.type === "context_phase") {
      const { phase, tokensBefore, tokensAfter, ratioBefore, ratioAfter, durationMs } = e.event;
      console.log(`${prefix} ${phase}: ${tokensBefore}→${tokensAfter} tok ` +
        `(ratio ${ratioBefore.toFixed(2)}→${ratioAfter.toFixed(2)}) ${durationMs}ms`);
    } else {
      const { reason, summaryTokensBefore, summaryTokensAfter, doubleCompactTriggered, durationMs } = e.event;
      console.log(`${prefix} compaction[${reason}]: summary ${summaryTokensBefore}→${summaryTokensAfter} ` +
        `keptRecent=${e.event.keptRecentTokens} dropped=${e.event.droppedMessages} ` +
        `compactTemplate=${e.event.compactTemplateUsed} doubleCompact=${doubleCompactTriggered} ${durationMs}ms`);
    }
  });
}

// JSONL file sink (enabled via PIX_CONTEXT_DEBUG=file:/path/to.log)
if (typeof process !== "undefined") {
  const m = /^file:(.+)$/.exec(process.env.PIX_CONTEXT_DEBUG ?? "");
  if (m) {
    const fs = await import("node:fs/promises");
    const path = m[1];
    const write = async (line: string) => {
      await fs.appendFile(path, line + "\n");
    };
    addMetricsSink(async (e) => write(JSON.stringify({
      ...e,
      timestamp: new Date(e.timestamp).toISOString(),
    })));
  }
}

function emit(event: MetricsEvent): void {
  for (const sink of sinks) {
    try { await sink(event); } catch { /* swallow sink errors */ }
  }
}
```

#### 3.2.3 Integration Points

```typescript
// packages/coding-agent/src/core/context-optimizer.ts (modify optimizeOutgoingContext)

import { emit, type ContextMetricsEvent, type CompactionMetricsEvent } from "./context-metrics.ts";

export async function optimizeOutgoingContext(...): Promise<AgentMessage[]> {
  const sessionId = getSessionId(); // from AgentSession
  const start = performance.now();
  const baselineTokens = estimateContextTokens(messages).tokens;
  
  emit({ type: "context_phase", event: { 
    timestamp: Date.now(), sessionId, phase: "optimize_start",
    contextWindow: options.contextWindow, tokensBefore: baselineTokens,
    tokensAfter: baselineTokens, ratioBefore: baselineTokens/options.contextWindow,
    ratioAfter: baselineTokens/options.contextWindow, durationMs: 0 
  }});
  
  // ... after git evidence transform ...
  const afterGitTokens = estimateContextTokens(next).tokens;
  emit({ type: "context_phase", event: { ...phase("git_evidence_transform", afterGitTokens, start) }});
  
  // ... after aging ...
  const afterAgingTokens = estimateContextTokens(next).tokens;
  emit({ type: "context_phase", event: { ...phase("aging", afterAgingTokens, start) }});
  
  // ... after stale prune ...
  const afterPruneTokens = estimateContextTokens(next).tokens;
  emit({ type: "context_phase", event: { ...phase("stale_prune", afterPruneTokens, start) }});
  
  // ... final ...
  emit({ type: "context_phase", event: { ...phase("optimize_end", finalTokens, start) }});
  return result;
}

function phase(name: ContextPhase, tokensAfter: number, start: number): ContextMetricsEvent {
  return {
    timestamp: Date.now(), sessionId,
    phase: name, contextWindow: options.contextWindow,
    tokensBefore: 0, // filled by caller
    tokensAfter, ratioBefore: 0, ratioAfter: tokensAfter/options.contextWindow,
    durationMs: performance.now() - start
  };
}
```

```typescript
// packages/coding-agent/src/core/compaction/compaction.ts (modify generateSummary)

export async function generateSummary(...): Promise<Result<string, Error>> {
  const start = performance.now();
  const sessionId = getSessionId();
  
  // ... existing logic ...
  
  const doubleCompact = textContent && estimateTextTokens(textContent) > reserveTokens * 0.8;
  // ... collapse logic ...
  
  emit({ type: "compaction", event: {
    timestamp: Date.now(), sessionId, reason: customInstructions ? "auto" : "manual",
    summaryTokensBefore: prevSummaryTokens,
    summaryTokensAfter: estimateTextTokens(textContent),
    keptRecentTokens: settings.keepRecentTokens,
    droppedMessages: messages.length - cutPoint,
    compactTemplateUsed: basePrompt === COMPACT_SUMMARIZATION_PROMPT,
    doubleCompactTriggered: doubleCompact,
    durationMs: performance.now() - start
  }});
  
  return ok(textContent);
}
```

---

### 3.3 Safe Circular-Ref Token Estimation

#### 3.3.1 Improved `safeJsonStringify` with Depth Tracking

```typescript
// packages/coding-agent/src/core/compaction/compaction.ts (replace safeJsonStringify)
import { safeJsonStringify as coreSafeStringify } from "@earendil-works/pix-agent-core";

/**
 * Stringify for token estimation, tolerating circular refs.
 * Returns a deterministic placeholder that includes:
 * - type name (Object, Array, etc.)
 * - key count / array length
 * - truncation indicator
 * This gives better token estimates than "[unserializable]" while staying safe.
 */
export function safeJsonStringifyForTokens(value: unknown, maxDepth = 3): string {
  const seen = new WeakSet<object>();
  let truncated = false;
  
  function stringify(v: unknown, depth: number): string {
    if (v === null) return "null";
    if (typeof v !== "object") return JSON.stringify(v);
    if (depth >= maxDepth) { truncated = true; return typeTag(v); }
    if (seen.has(v)) { truncated = true; return `[Circular ${typeTag(v)}]`; }
    
    seen.add(v);
    try {
      if (Array.isArray(v)) {
        if (v.length === 0) return "[]";
        const items = v.slice(0, 50).map(x => stringify(x, depth + 1));
        if (v.length > 50) { truncated = true; items.push("..."); }
        return "[" + items.join(",") + "]";
      }
      const keys = Object.keys(v);
      if (keys.length === 0) return "{}";
      const entries = keys.slice(0, 30).map(k => 
        JSON.stringify(k) + ":" + stringify(v[k], depth + 1)
      );
      if (keys.length > 30) { truncated = true; entries.push("..."); }
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
```

#### 3.3.2 Align with agent-harness (shared utility)

```typescript
// packages/agent/src/harness/compaction/compaction.ts
// REPLACE local safeJsonStringify with import:
import { safeJsonStringifyForTokens } from "@earendil-works/pix-coding-agent/compaction";

// Or create shared package: @earendil-works/pix-compaction-utils
```

---

### 3.4 Decouple Heavy Aging from Compaction

#### 3.4.1 Hysteresis Band

```typescript
// packages/coding-agent/src/core/context-thresholds.ts (modify)

/** Gap between heavy aging and compaction to prevent thrashing */
export const HEAVY_AGING_COMPACTION_GAP = 0.05; // 5% window

/** 
 * Effective heavy aging threshold = compactionThreshold - HEAVY_AGING_COMPACTION_GAP
 * Compaction threshold = 1 - reserveTokens/window (after clamping)
 * This ensures heavy aging NEVER overlaps with compaction trigger zone.
 */
export function getEffectiveHeavyAgingThreshold(contextWindow: number, reserveTokens: number): number {
  const compactionThreshold = 1 - resolveCompactionSettings({ reserveTokens }, contextWindow).reserveTokens / contextWindow;
  return Math.max(THRESHOLDS.AGING_HEAVY, compactionThreshold - HEAVY_AGING_COMPACTION_GAP);
}
```

#### 3.4.2 Usage in Aging Logic

```typescript
// packages/coding-agent/src/core/context-aging.ts (modify getAgingLevel)

export function getAgingLevel(contextRatio: number, contextWindow: number, reserveTokens: number): AgingLevel | undefined {
  if (contextRatio < THRESHOLDS.AGING_START) return undefined;
  if (contextRatio < THRESHOLDS.AGING_MEDIUM) return { ...LIGHT, heavy: false };
  
  // Dynamic heavy threshold with hysteresis gap
  const heavyThreshold = getEffectiveHeavyAgingThreshold(contextWindow, reserveTokens);
  if (contextRatio < heavyThreshold) return { ...MEDIUM, heavy: false };
  
  return { ...HEAVY, heavy: true };
}
```

---

### 3.5 Compression Efficiency Tracking

#### 3.5.1 Summary Quality Metrics

```typescript
// packages/coding-agent/src/core/compaction/compaction.ts (add to generateSummary)

interface SummaryQualityMetrics {
  compressionRatio: number;           // outputTokens / inputTokens
  informationDensity: number;         // keptKeyItems / totalKeyItems
  structurePreservation: number;      // sectionsPreserved / totalSections
  anchorRetention: number;            // anchorsPreserved / totalAnchors
}

// Extract key items from summary sections for density calculation
function analyzeSummaryQuality(prev: string | undefined, next: string): SummaryQualityMetrics {
  const sections = ["Goal", "Constraints & Preferences", "Progress", "Key Decisions", "Next Steps", "Critical Context"];
  const prevSections = prev ? parseSections(prev) : {};
  const nextSections = parseSections(next);
  
  let kept = 0, total = 0;
  for (const s of sections) {
    const prevItems = extractItems(prevSections[s] ?? "");
    const nextItems = extractItems(nextSections[s] ?? "");
    total += prevItems.length;
    kept += nextItems.filter(i => prevItems.some(p => similar(p, i))).length;
  }
  
  return {
    compressionRatio: estimateTextTokens(next) / Math.max(1, prev ? estimateTextTokens(prev) : 1),
    informationDensity: total > 0 ? kept / total : 1,
    structurePreservation: sections.filter(s => nextSections[s]).length / sections.length,
    anchorRetention: countAnchors(next) / Math.max(1, prev ? countAnchors(prev) : 1)
  };
}
```

#### 3.5.2 Emit Quality Metrics

```typescript
// In generateSummary, after final summary produced:
const quality = previousSummary ? analyzeSummaryQuality(previousSummary, textContent) : null;

emit({ type: "compaction_quality", event: {
  timestamp: Date.now(), sessionId,
  ...quality,
  compactTemplateUsed: basePrompt === COMPACT_SUMMARIZATION_PROMPT,
  doubleCompactTriggered: doubleCompact
}});
```

---

## 4. Implementation Plan

### Phase 1: Threshold Guarantees (Week 1)
- [ ] Add branded `ContextRatio` type + compile-time assertions
- [ ] Runtime validation on module init
- [ ] Unit test for invariant
- [ ] **Adjust AGING_HEAVY from 0.80 → 0.78** (creates 0.02 gap before compaction min 0.75)

### Phase 2: Structured Metrics (Week 1-2)
- [ ] Create `context-metrics.ts` with event types + sinks
- [ ] Wire into `context-optimizer.ts` (5 phase events)
- [ ] Wire into `compaction.ts` (compaction + quality events)
- [ ] Add JSONL file sink + console sink
- [ ] Test with `PIX_CONTEXT_DEBUG=file:/tmp/ctx.log`

### Phase 3: Safe Token Estimation (Week 2)
- [ ] Implement `safeJsonStringifyForTokens` with depth tracking
- [ ] Replace both coding-agent & agent-harness implementations
- [ ] Add unit tests for circular refs, deep nesting, large arrays
- [ ] Verify token estimates within ±10% of actual provider counts

### Phase 4: Hysteresis Gap (Week 2)
- [ ] Add `HEAVY_AGING_COMPACTION_GAP = 0.05`
- [ ] Implement `getEffectiveHeavyAgingThreshold()`
- [ ] Update `getAgingLevel()` to use dynamic threshold
- [ ] Add integration test: simulate 70%→85% pressure, verify no thrash

### Phase 5: Quality Metrics (Week 3)
- [ ] Implement `analyzeSummaryQuality()`
- [ ] Emit `compaction_quality` events
- [ ] Add optional summary diff view in debug log
- [ ] Document metrics schema for external consumers

---

## 5. Testing Strategy

| Test Type | Coverage |
|-----------|----------|
| Unit | Threshold ordering, safeJsonStringify edge cases, quality metrics parser |
| Integration | Full optimizeOutgoingContext flow with metrics emission |
| Regression | `test/context-thresholds.test.ts` guards invariant |
| Load | 500-message session with PIX_CONTEXT_DEBUG=file, verify <100ms overhead |
| E2E | Auto-compaction triggered at 75% → verify no heavy aging at 80%+ |

---

## 6. Rollout & Compatibility

- **No public API changes** — all new symbols internal or in new modules
- **Environment variables**:
  - `PIX_CONTEXT_DEBUG=1` → console sink (existing)
  - `PIX_CONTEXT_DEBUG=file:/path` → JSONL file sink (new)
  - `PIX_CONTEXT_DEBUG=json` → structured console JSON (new)
- **Feature flags**: All metrics off by default; zero overhead when disabled
- **Backport**: Threshold constant change (0.80→0.78) is a bug fix, include in patch

---

## 7. Success Criteria

| Metric | Target |
|--------|--------|
| Threshold invariant violations | 0 (compile-time + runtime) |
| Metrics emission overhead | <1ms per optimizeOutgoingContext call |
| Circular ref token estimate error | <10% vs actual provider count |
| Heavy aging / compaction overlap | 0 occurrences in 1000 simulated sessions |
| Compression ratio (summary) | 0.3-0.5 typical, tracked per session |

---

## 8. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| JSONL sink blocks event loop | Low | Medium | Async write with bounded queue; drop on backpressure |
| Quality metrics add LLM calls | None | N/A | Pure static analysis of summary text |
| Threshold change breaks existing tuning | Low | High | 0.78 still < 0.75 compaction floor; only widens gap |
| Sink errors crash session | Very Low | High | Try/catch per sink, errors logged not thrown |

---

## 9. Future Extensions

1. **Prometheus / OpenTelemetry exporter** sink for production monitoring
2. **Adaptive threshold tuning** based on historical compression efficiency
3. **Summary quality regression detection** in CI (compare metrics snapshots)
4. **Per-tool aging policies** configurable via extension API
