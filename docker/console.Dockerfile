# memoturn console (Vite SPA). Builds static assets and serves them with Vite preview
# (SPA history fallback included). NOTE: production routing of /api -> the API service
# and dashboard auth (Better Auth session) are wired in the platform phase; in dev the
# Vite proxy handles /api. Build-time API base is configurable via VITE_API_BASE.
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
COPY packages/core/package.json packages/core/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/llm/package.json packages/llm/package.json
COPY sdks/js/package.json sdks/js/package.json
RUN bun install --frozen-lockfile

FROM deps AS build
COPY . .
ARG VITE_API_BASE=/api
ENV VITE_API_BASE=$VITE_API_BASE
RUN bun --filter @memoturn/console build

FROM build AS runner
EXPOSE 3000
CMD ["bun", "--filter", "@memoturn/console", "preview"]
