# memoturn-mcp image — the MCP server in streamable-HTTP mode (remote agents).
# Build from this directory: docker build -t memoturn/mcp:0.1.0 .
FROM node:22-slim AS build
WORKDIR /src
COPY package.json package-lock.json* tsconfig.json ./
COPY src ./src
RUN npm install && npm run build && npm prune --omit=dev

FROM node:22-slim
RUN useradd -r -u 10001 memoturn
WORKDIR /app
COPY --from=build /src/dist ./dist
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/package.json .
USER memoturn
# Credentials are per-session: clients present `Authorization: Bearer` at MCP
# initialize and it is pinned to the session — no token baked into the pod.
ENV MEMOTURN_MCP_HOST=0.0.0.0 \
    MEMOTURN_MCP_PORT=8765
EXPOSE 8765
ENTRYPOINT ["node", "dist/index.js", "--http"]
