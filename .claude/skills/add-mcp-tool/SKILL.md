---
name: add-mcp-tool
description: How to add a tool to the memoturn MCP server (apps/mcp) — the ToolDef registry, plain JSON Schema inputs, handlers that call into @memoturn/server, the stderr-only logging rule, and keeping the README in sync. Use when exposing a new capability to agent IDEs via MCP.
paths: packages/server/src/mcp-tools.ts, apps/mcp/**
---

# Add an MCP tool

`apps/mcp` is a stdio MCP server exposing prompts/datasets/review queues to agent IDEs, scoped to one project via a `MEMOTURN_PUBLIC_KEY`/`MEMOTURN_SECRET_KEY` pair. **stdout is the JSON-RPC channel — all logging goes to stderr.**

## Add the tool

Append a `ToolDef` to the `tools` array in `packages/server/src/mcp-tools.ts` (shared by the stdio server `apps/mcp` and the remote HTTP endpoint `apps/api/src/mcp.ts`):

```ts
{
  name: "list_widgets",
  description: "List dashboard widgets in the project.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: (projectId) => listWidgets(projectId),
},
```

- **`inputSchema` is plain JSON Schema** (`type`/`properties`/`required`/`additionalProperties`) — deliberately *not* zod, so the tool definitions stay stable across MCP SDK versions. Mark `required` and set `additionalProperties: false`.
- **The handler is `(projectId, args) => …`** and should call a `@memoturn/server` domain function — import it from the sibling module at the top of `mcp-tools.ts` (e.g. `./widgets.js`), *not* the barrel `./index.js` (which re-exports this file → circular). The server module is the single source of business logic, shared with the API. Reuse an existing server function; don't reimplement queries here.
- **Set `write: true` on mutating tools** (create/update/delete/append/submit). The remote HTTP transport (`apps/api/src/mcp.ts`) maps that flag to the caller's `write` scope and audits the call; read tools require only `read`. The stdio server ignores it.
- Coerce args defensively with the local `str(...)` helper; return `NOT_FOUND(kind, name)` for misses, matching the existing tools.

## Keep the README in sync (enforced)

`apps/mcp/README.md` lists the tools, and `bun run docs:check` **fails** if a tool name in `packages/server/src/mcp-tools.ts` is missing from the README (the MCP-tools coupling). Add your tool's name + a one-line description to the README, then run `bun run docs:check`.

## Verify

- `bun run typecheck`.
- `bun run docs:check` (confirms the README lists the new tool).
- Smoke-test over stdio with the `MEMOTURN_PUBLIC_KEY`/`MEMOTURN_SECRET_KEY` env pair set; confirm the tool appears in `list_tools` and returns data. Remember: any debug output must go to **stderr**, never stdout.
