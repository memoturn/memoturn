import { app } from "./app.js";

/**
 * Bun entrypoint. `bun run src/server.bun.ts` serves the Hono app via Bun.serve
 * (Bun reads the default export's `port` + `fetch`). This is the default runtime
 * for the memoturn API.
 */
const port = Number(process.env.API_PORT ?? 3001);
console.log(`[api] memoturn API (Bun) listening on http://localhost:${port}`);
console.log(`[api] OpenAPI: http://localhost:${port}/openapi.json · Swagger UI: /docs`);

export default {
  port,
  fetch: app.fetch,
};
