# memoturn worker (BullMQ) — runs on Bun.
FROM oven/bun:1.3 AS base
WORKDIR /app

FROM base AS deps
# Every workspace manifest must be present or `bun install --frozen-lockfile` fails to
# resolve workspace:* deps. Keep in sync with the workspaces in the root package.json
# (the docker-build CI job catches drift on any package.json change).
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/console/package.json apps/console/package.json
COPY apps/mcp/package.json apps/mcp/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/docs/package.json apps/docs/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/telemetry/package.json packages/telemetry/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/llm/package.json packages/llm/package.json
COPY packages/ui/package.json packages/ui/package.json
COPY packages/tsconfig/package.json packages/tsconfig/package.json
COPY sdks/js/package.json sdks/js/package.json
RUN bun install --frozen-lockfile

FROM deps AS runner
COPY . .
RUN bun --filter @memoturn/db generate
ENV NODE_ENV=production
# Drop root for the runtime process (the oven/bun image ships a non-root `bun` user).
USER bun
# Compose/Helm probes override this; it covers bare `docker run` and other orchestrators.
# The worker's health server binds 127.0.0.1 by default — in-container probes reach it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:3002/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["bun", "--filter", "@memoturn/worker", "start"]
