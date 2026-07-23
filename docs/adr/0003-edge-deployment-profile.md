# ADR 0003 — An edge deployment profile (serverless runtimes, Cloudflare Workers reference target)

- **Status:** Proposed (implementation trigger-gated — see [Trigger](#trigger)). **Depends on
  ADR-0002** (the Postgres telemetry tier is the edge profile's data plane).
- **Date:** 2026-07-22
- **Context tags:** deployment profiles, runtime portability, queue seam, self-hosting

## Context

memoturn today assumes long-running server processes: the API on Bun (with a Node entrypoint as a
secondary), and a worker process that holds BullMQ consumers, cron schedules, and Redis locks. The
self-host story is therefore "run containers" — even after ADR-0002 removes Doris from the small
tier, an operator still provisions compute for the API and worker, plus Redis.

Serverless edge runtimes (Cloudflare Workers as the concrete reference; the seams introduced here
are provider-neutral) would collapse a small install to **zero self-managed infrastructure**:
managed Postgres (e.g. Neon — ADR-0002's tier, with pgvector), object storage (R2/S3), a managed
queue, and one deploy command. No Docker, no processes to keep alive.

An audit of the current coupling points shows the architecture is closer to edge-portable than it
looks — several past decisions align accidentally well:

| Piece | Today | Edge analogue | Lift |
|---|---|---|---|
| `apps/api` | Hono on Bun (`server.bun.ts`, `server.node.ts`) | Hono is runtime-portable; a third entrypoint is idiomatic — two are already maintained | Small |
| Telemetry engine | Doris via mysql2 (TCP) | Not viable on Workers → the edge profile **is** `TELEMETRY_ENGINE=postgres` (ADR-0002) over a serverless Postgres driver / connection pooler | Covered by ADR-0002 |
| Ingest ack path | batch → blob, enqueue a **pointer**, 207 | Already queue-agnostic: edge queues cap message size (Workers Queues: 128 KB), but memoturn never enqueues payloads — only blob references | Nearly free |
| Queue (`@memoturn/db/queue`) | BullMQ over Redis (`getIngestQueue` / `getExperimentQueue` / `getDlqQueue`) | **The real work**: BullMQ cannot run on Workers. Needs a queue *port* with the BullMQ implementation as today's adapter and a Workers Queues adapter (native retries + DLQ) | Medium |
| `apps/worker` | long-running BullMQ consumer + cron schedules | Queue-consumer handler + platform cron triggers (`scheduled()`); `withLock` (Redis) is unnecessary where the platform serializes cron invocations, or maps to a Durable Object | Medium |
| Blob | S3/MinIO SDK | R2 is S3-compatible — `@memoturn/db/blob` largely unchanged | Small |
| Auth | Better Auth | Runs on Workers by design | Free |
| Console SPA | Vite static build | Served from the same Worker via an assets binding (API paths run the Worker first, everything else falls through to the SPA) — same-origin, no CORS | Small |
| Locks / alert state | Redis (`withLock`) | Cron-trigger serialization, KV, or a Durable Object | Small–medium |

The one true architectural gap is the **queue seam**: `@memoturn/db/queue` is already a subpath
module (a seam in position), but its surface is BullMQ-shaped. Everything else is entrypoint and
configuration work.

## Decision

**Introduce an edge deployment profile as OSS configuration, enabled by two pieces of work:**

1. **A queue port.** Define a minimal queue interface (enqueue with retry policy, consume,
   dead-letter) sized to what memoturn actually uses — not BullMQ's surface. The BullMQ/Redis
   implementation becomes the default adapter (behavior unchanged for existing profiles); a
   Workers Queues adapter is the second implementation. Like the `TelemetryStore` seam, nothing
   above the port may know which queue is running.
2. **A Workers runtime target.** A Workers entrypoint for the Hono app (console served from the
   same Worker via assets), the worker's processors re-hosted as a queue-consumer handler plus
   cron triggers, and a wrangler configuration wiring Postgres (via pooler), R2, and Queues.

The profile matrix after ADR-0002 + ADR-0003:

| Profile | Compute | Telemetry | Queue | Blob |
|---|---|---|---|---|
| **Container (small)** | Bun processes / Docker | Postgres (ADR-0002) | BullMQ/Redis | MinIO/S3 |
| **Container (scale)** | Bun processes / Docker | Doris | BullMQ/Redis | S3 |
| **Edge (new)** | Workers | Postgres (ADR-0002) | Workers Queues | R2 |

Doris remains the scale story; the edge profile deliberately targets the same envelope as the
ADR-0002 Postgres tier and inherits its sizing guidance and its graduation path (move to the
container-scale profile; blob replay rebuilds Doris).

## Consequences

**Positive**

- A small install becomes **one deploy command against managed services** — no containers, no
  Redis, no always-on compute to operate. The strongest possible answer to self-host friction.
- The queue port is valuable independent of edge: it makes the worker's queue infrastructure
  swappable (managed Redis, SQS-alikes) the same way `TelemetryStore` made the analytics engine
  swappable.
- Native platform primitives replace hand-rolled ones where they're strictly better: Queues
  retries + DLQ replace BullMQ retry bookkeeping; cron triggers replace in-process schedules;
  single-flight cron delivery replaces `withLock` for that use.
- A hosted deployment of memoturn could reuse this profile rather than a separate stack.

**Negative / cost**

- **A third runtime target multiplies the test matrix.** Bun (primary), Node (entrypoint), and
  Workers must all stay green; Workers-specific behavior needs its own test lane
  (`@cloudflare/vitest-pool-workers` or equivalent smoke deploys).
- **The queue port is a permanent abstraction tax** — every new job type is designed against the
  port, and both adapters must implement it (mirroring ADR-0002's dual-implementation cost).
- **Workers constraints shape the worker path**: CPU-time limits per invocation (large batch
  merges may need chunking), subrequest limits, no long-lived in-process state (provider-client
  caches, metrics counters need rethinking — counters move to platform analytics or structured
  logs).
- Node-flavored dependencies must clear the runtime's compatibility layer (crypto for key
  hashing/HMAC, the Postgres driver); anything that doesn't needs a shim alias.
- The Prisma client must run driver-adapter-only on this target (already the configured style,
  but it becomes load-bearing).

## Implementation plan

Strictly sequenced **after** ADR-0002's Postgres tier exists (the edge profile has no data plane
without it).

### Phase 1 — Queue port (no behavior change)
- Define the port in `@memoturn/db/queue` sized to actual usage: `enqueue(queue, job, opts)`,
  a consumer registration surface, DLQ inspection/replay hooks (the `dlq` CLI works through the
  port). Re-express `getIngestQueue`/`getExperimentQueue`/`getDlqQueue` as the BullMQ adapter.
- All existing profiles run the BullMQ adapter unchanged; a port-level contract test (in the
  spirit of `conformance.test.ts`) pins semantics: at-least-once delivery, retry with backoff,
  exhausted → DLQ, replay.

### Phase 2 — Workers API entrypoint
- `apps/api/src/server.workers.ts` alongside the Bun/Node entrypoints; console `dist` served via
  an assets binding with API paths running the Worker first.
- Wire env: Postgres URL (pooler), R2 credentials (S3 API), `TELEMETRY_ENGINE=postgres` forced —
  the profile refuses to boot against Doris.
- Shim seams for Node-only pieces (metrics counters → structured logs / platform analytics).

### Phase 3 — Worker re-hosting
- Ingest/experiment processors invoked from a queue-consumer handler through the port; crons
  (retention, exports, projection, state-prune, alerts) from cron triggers, dropping `withLock`
  where the platform serializes invocations.
- Chunking guard for batch merges that could exceed per-invocation CPU limits (re-enqueue the
  remainder — the blob pointer model makes this natural).

### Phase 4 — Profile packaging & docs
- Wrangler config + a `deploy:edge` recipe; self-host docs gain the third profile with the
  ADR-0002 sizing table and graduation runbook.
- CI: Workers test lane for the entrypoint + queue adapter; port contract test runs against both
  adapters.
- Update `docs/architecture.md`, `CLAUDE.md`, and run `bun run docs:check`.

**Rollback:** the port's BullMQ adapter is the default; the Workers target is additive. Blob
remains the replay source, so any profile can rebuild any other's telemetry store.

## Alternatives considered

- **Managed containers instead (Fly.io / Cloud Run / similar).** Much smaller lift — no queue
  port, no third runtime — and a fine *documentation* answer today ("here's a one-click container
  deploy"). But it keeps Redis + always-on compute in the bill and doesn't reach zero-infra.
  Complementary; worth doing as docs regardless of this ADR.
- **Everything-in-Durable-Objects / platform-native rewrite.** Maximum platform leverage, but it
  forks the codebase rather than seaming it — violates the one-app-many-profiles principle that
  makes ADR-0002 cheap.
- **Polyfill BullMQ on Workers.** BullMQ's Lua-script/blocking-connection model doesn't map to
  the runtime; a port with honest adapters is less code than a leaky emulation.
- **Skip the port, hard-fork the worker for edge.** Avoids the abstraction tax but creates two
  divergent job pipelines — the drift cost exceeds the port cost within a few job types.
- **Do nothing (containers only).** The default until the trigger fires; ADR-0002 alone already
  removes the heaviest dependency.

## Trigger

Execute when **ADR-0002 is implemented** and any of these is true:

1. Zero-infra deployment is requested by real self-host users (issues/discussions naming the
   container/Redis requirement as the blocker), **or**
2. A hosted deployment of memoturn is being built and would run on this profile, **or**
3. The queue port is wanted independently (e.g. to support a managed queue in containers) — in
   which case Phase 1 can ship alone, ahead of the rest.

Until then this ADR records the mapping so the option stays cheap and deliberate.
