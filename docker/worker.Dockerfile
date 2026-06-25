# memoturn worker (BullMQ) — runs on Bun.
FROM oven/bun:1.3 AS base
WORKDIR /app

FROM base AS deps
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/console/package.json apps/console/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/server/package.json packages/server/package.json
COPY sdks/js/package.json sdks/js/package.json
RUN bun install --frozen-lockfile

FROM deps AS runner
COPY . .
RUN bun --filter @memoturn/db generate
ENV NODE_ENV=production
CMD ["bun", "--filter", "@memoturn/worker", "start"]
