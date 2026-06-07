# Context Management Improvements - Design Rationale

**Author**: Droid (initial draft, c67b1c28)
**Date**: 2026-06-04 (initial)
**Status**: Living doc — narrative only; code is authoritative
**Related Commits**: bcd8b9ed, 7e8411fb, b0368721, 0437ec92, 9d46b440, c67b1c28, eda7cef0, 5e7adf34, ff762984

> This document captures *why* the context management subsystem was redesigned
> and *what* remains for future work. For *how* it works, read the code.
> The "Detailed Design" subsections (formerly 3.1 - 3.5) were removed; the code
> in `packages/coding-agent/src/core/` and `packages/agent/src/harness/compaction/`
> is the authoritative reference.

---

## 1. Problem Statement

Based on analysis of recent fixes (bcd8b9ed through 7e8411fb), the context management system has significantly improved but had remaining gaps:

| Issue | Severity | Impact | Resolution |
|-------|----------|--------|------------|
| AGING_HEAVY_RATIO (0.8) ≈ compaction threshold (≥0.75) | High | Race condition between heavy aging and compaction in high-pressure sessions | **Resolved** (c67b1c28): AGING_HEAVY lowered to 0.70, `HEAVY_AGING_COMPACTION_GAP=0.05` in `context-thresholds.ts` |
| No structured metrics export for PIX_CONTEXT_DEBUG | Medium | Manual tuning only; no CI regression detection | **Resolved** (c67b1c28): human/json/file sinks in `context-metrics.ts` |
| safeJsonStringify loses circular ref structure info | Low | Token estimation slightly conservative (safe) | **Resolved** (c67b1c28): `safeJsonStringifyForTokens` in `compaction.ts`; not yet shared with agent-harness |
| No static guarantee of threshold ordering invariant | Medium | Future refactors could silently break AGING < STALE < COMPACTION | **Partial** (c67b1c28): runtime check via `validateThresholdInvariants()`; no compile-time check yet |
| No compression efficiency tracking | Low | Cannot measure summary quality vs token savings offline | **Resolved** (c67b1c28 + 5e7adf34): `analyzeSummaryQuality` in `compaction/summary-quality.ts` + `compaction_quality` event |

---

## 2. Design Goals

| Goal | Status | Where |
|------|--------|-------|
| 1. **Guarantee threshold ordering** at compile-time + runtime | Partial (runtime only) | `context-thresholds.ts:validateThresholdInvariants()` |
| 2. **Structured observability** for context pressure & compression efficiency | Done | `context-metrics.ts` + `context-metrics-types.ts` |
| 3. **Safe circular-ref token estimation** without over-conservatism | Partial (not shared across packages) | `compaction.ts:safeJsonStringifyForTokens` |
| 4. **Decouple heavy aging from compaction** with clear hysteresis | Done | `context-thresholds.ts:getEffectiveHeavyAgingThreshold` |
| 5. **Zero breaking changes** to public APIs | Done | All new symbols module-internal; see 5e7adf34 module split |

---

## 3. Testing Strategy

| Test Type | Coverage |
|-----------|----------|
| Unit | Threshold ordering, safeJsonStringify edge cases, quality metrics parser |
| Integration | Full optimizeOutgoingContext flow with metrics emission |
| Regression | `test/context-thresholds.test.ts` guards invariant |
| Load | 500-message session with PIX_CONTEXT_DEBUG=file, verify <100ms overhead |
| E2E | Auto-compaction triggered at 75% → verify no heavy aging at 80%+ |

> **Note**: The original design proposed a dedicated `test/context-thresholds.test.ts`
> file with a `THRESHOLDS` aggregate object. The runtime invariant check
> (`validateThresholdInvariants()`) provides equivalent protection at module-load
> time. If a compile-time check is added later (see Future Extensions), a regression
> test should accompany it.

---

## 4. Rollout & Compatibility

- **No public API changes** — all new symbols internal or in new modules
- **Environment variables**:
  - `PIX_CONTEXT_DEBUG=1` → console sink (existing)
  - `PIX_CONTEXT_DEBUG=file:/path` → JSONL file sink (new)
  - `PIX_CONTEXT_DEBUG=json` → structured console JSON (new)
- **Feature flags**: All metrics off by default; zero overhead when disabled
- **Backport**: Threshold constant change (**0.80 → 0.70**) is a bug fix, include in patch

---

## 5. Success Criteria

| Metric | Target | Status |
|--------|--------|--------|
| Threshold invariant violations | 0 (compile-time + runtime) | Runtime-only check active; compile-time check is a possible follow-up (see Future Extensions) |
| Metrics emission overhead | <1ms per optimizeOutgoingContext call | `isMetricsEnabled()` guards the hot path; actual overhead not measured |
| Circular ref token estimate error | <10% vs actual provider count | Not measured; depends on real-world tool argument shapes |
| Heavy aging / compaction overlap | 0 occurrences in 1000 simulated sessions | Not simulated; `getEffectiveHeavyAgingThreshold` ensures the gap mathematically |
| Compression ratio (summary) | 0.3-0.5 typical, tracked per session | Tracked per session via `compaction_quality` events |

---

## 6. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| JSONL sink blocks event loop | Low | Medium | Async write with bounded queue; drop on backpressure |
| Quality metrics add LLM calls | None | N/A | Pure static analysis of summary text |
| Threshold change breaks existing tuning | Low | High | 0.70 still < 0.75 compaction floor; only widens gap |
| Sink errors crash session | Very Low | High | Try/catch per sink, errors logged not thrown |

---

## 7. Future Extensions

1. **Prometheus / OpenTelemetry exporter** sink for production monitoring
2. **Adaptive threshold tuning** based on historical compression efficiency
3. **Summary quality regression detection** in CI (compare metrics snapshots)
4. **Per-tool aging policies** configurable via extension API
5. **Compile-time threshold ordering assertion** (TypeScript const-assertion type check)
6. **Unify `safeJsonStringifyForTokens` across coding-agent and agent-harness** (one shared utility)
