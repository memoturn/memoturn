# memoturn console (Vite SPA). Builds static assets with Bun, serves them with Caddy
# (static file server + SPA history fallback — `vite preview` is a dev convenience, not
# a production server). NOTE: production routing of /api -> the API service and dashboard
# auth (Better Auth session) are wired in the front proxy (infra/Caddyfile); in dev the
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

FROM deps AS build
COPY . .
ARG VITE_API_BASE=/api
ENV VITE_API_BASE=$VITE_API_BASE
RUN bun --filter @memoturn/console build

FROM caddy:2-alpine AS runner
COPY docker/console.Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/console/dist /srv
# Drop root for the runtime process. Caddy writes only to its XDG dirs (/config, /data).
RUN adduser -D -u 1000 console && chown -R console:console /config /data
USER console
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/ || exit 1
# CMD inherited from the caddy base image: caddy run --config /etc/caddy/Caddyfile
