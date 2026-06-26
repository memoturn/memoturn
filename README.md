# memoturn

Open-source **AI engineering platform** — LLM observability, evals, metrics, prompt
management, playground, and datasets. Self-hostable, OpenTelemetry-native, Bun-native.

📚 **[Documentation](./docs/README.md)** — getting started, architecture, API, SDKs, integrations, evaluation, deployment.

![memoturn dashboard](./docs/images/dashboard.png)

## Features

- **Observability** — traces, spans, generations, scores; a waterfall timeline; sessions; OTel (OTLP/JSON, GenAI semconv) ingestion; SDK + LangChain + OpenAI integrations.
- **Metrics & dashboards** — cost / tokens / latency (p50/p95) over a ClickHouse rollup, by day and by model.
- **Prompt management** — versioned registry with deployment **channels** (production/latest/custom), SDK `getPrompt` + `compile`.
- **Playground** — multi-provider (mock / Anthropic / OpenAI), **streaming**, runs recorded as traces.
- **Evaluation (trifecta)** — **offline** (datasets & experiments), **online** (sampled production traces via the worker), and **human** (review queues). All write scores into ClickHouse; scores show on the trace.
- **Datasets & experiments** — dataset items, runs linking items to traces.
- **Platform** — Better Auth login, workspaces → projects with a project switcher, RBAC (read-only viewers), audit logs, data retention, NDJSON batch export.
- **SDKs** — TypeScript (`@memoturn/sdk`) and Python (`memoturn`): tracing, `@observe`/`wrapOpenAI`, LangChain callbacks, prompts.

## Architecture

Async, decoupled, Bun-native:

| Tier | Tech | Role |
| --- | --- | --- |
| API | **Hono** on **Bun** (`apps/api`) | Public `/v1` REST + OTel receiver + Better Auth + OpenAPI/Scalar |
| Console | **Vite + TanStack Router SPA** (`apps/console`) | Dashboard (TanStack Query) |
| Worker | **Bun + BullMQ** (`apps/worker`) | Async ingest → ClickHouse, online evals, retention cron |
| OLTP | **PostgreSQL** (Prisma 7) | Workspaces, projects, API keys, prompts, datasets, evaluators, review queues, policies |
| OLAP | **ClickHouse** | High-volume `traces` / `observations` / `scores` |
| Queue/cache | **Redis (Valkey)** + BullMQ | Async pipeline, caches |
| Blob | **S3-compatible** (MinIO) | Raw replayable event log, media, exports |

```
SDKs / OTel / LangChain / OpenAI
      │  POST /v1/ingest  (Basic auth = publicKey:secretKey)
      ▼
  apps/api (Hono/Bun) ─► validate ─► blob (raw log) ─► BullMQ ─► 207 ack
      ▼
  apps/worker (Bun) ─► merge ─► ClickHouse   (+ online evaluators, retention)
      ▼
  apps/console (SPA) ──TanStack Query──► apps/api
```

## Quickstart

```bash
cp .env.example .env
bun run setup           # install + infra up + wait + migrate + clickhouse + seed
bun run dev             # api (:3001) + worker + console (:3000)
bun run quickstart      # emit a trace → open http://localhost:3000
```

- Console: http://localhost:3000 — login `admin@memoturn.dev` / `memoturn-dev-123`
- API + Scalar docs: http://localhost:3001/docs · OpenAPI: `/openapi.json`
- Dev API key (SDKs): `pk-mt-dev` / `sk-mt-dev`

## SDKs

**TypeScript**

```ts
import { Memoturn, wrapOpenAI } from "@memoturn/sdk";
const mt = new Memoturn();
const trace = mt.trace({ name: "chat", userId: "u1" });
trace.generation({ name: "answer", model: "claude-sonnet-4-6", input: messages }).end({ output, usage });
await mt.shutdown();
```

**Python**

```python
from memoturn import observe

@observe(name="rag-pipeline")
def rag(q): ...           # nested @observe calls become child spans
```

## Monorepo

```
apps/{api,console,worker}   packages/{core,contracts,db,server,llm}   sdks/{js,python}   infra/   docker/
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the dev workflow.

## License

Apache-2.0
