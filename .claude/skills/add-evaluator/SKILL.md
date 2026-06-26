---
name: add-evaluator
description: How to add or change an evaluator in memoturn — LLM-as-judge config, online vs offline runs, the deterministic per-trace sampling, the never-fail-ingestion rule, and how scores are written back. Use when working on evaluators (packages/server/src/evaluators.ts), online evals in the worker, or the EVAL score path.
---

# Add / change an evaluator

Evaluators are LLM-as-judge scorers. They run two ways: **offline** (on demand via `POST /v1/evaluators/{name}/run`) and **online** (automatically on a sampled fraction of incoming traces, in the worker). Both end by writing a score **back through the ingest pipeline** so it lands in ClickHouse like any other score.

## Where things live

- **Config + run** — `packages/server/src/evaluators.ts`: `createEvaluator`, `listEvaluators`, `listOnlineEvaluators` (online + `samplingRate`/`filterName`), `runEvaluator`.
- **API** — `apps/api/src/app.ts`: `POST /v1/evaluators` (create), `POST /v1/evaluators/{name}/run` (run). Create is guarded (`denyIfReadOnly` + `403`); see the `add-endpoint` skill.
- **Online execution** — `apps/worker/src/processors/ingest.ts` → `runOnlineEvals`.

## Two invariants — do not break these

1. **Deterministic sampling, never random.** The worker decides whether to run an online evaluator with an FNV-style hash of the seed `` `${trace.id}:${ev.name}` `` → a stable `[0,1)` value, compared against `ev.samplingRate`. Same trace + evaluator → same decision on every replay. Never use `Math.random()`; keep the seed `traceId:evaluatorName`.
2. **Online eval failures never fail ingestion.** In `runOnlineEvals`, each `runEvaluator` call is wrapped in try/catch and only logged. Keep that — an evaluator (or its provider) erroring must not break the ingest job.

## How a score is written

`runEvaluator` calls the provider gateway (`generate`, with the system prompt forcing strict JSON `{"score", "reasoning"}`), then writes the result via `submitBatch(projectId, { batch: [{ type: "score-create", body: { ..., source: "EVAL", dataType: "NUMERIC" } }] })`. Don't insert into ClickHouse directly — go through `submitBatch` so the score replays like any ingest event. The `mock` provider synthesizes a deterministic `score: 1` for tests.

## Verify

- `bun --filter @memoturn/core test` (sampling/cost) and `bun --filter @memoturn/worker test`.
- `bun run typecheck`.
- End to end: create an online evaluator, emit a completed trace (SDK/quickstart), and confirm an `EVAL` score appears.
