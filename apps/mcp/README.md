# @memoturn/mcp

An [MCP](https://modelcontextprotocol.io) server that exposes a memoturn project's
**prompts**, **datasets**, and **review queues** as tools for agent IDEs (Claude
Desktop, Cursor, etc.). It talks to the same `@memoturn/server` logic the API uses,
so it reads and writes the live project.

## Auth

The server is scoped to a single project, resolved at startup from a project API key
pair (the same `pk-mt-…` / `sk-mt-…` keys the SDK uses):

- `MEMOTURN_PUBLIC_KEY`
- `MEMOTURN_SECRET_KEY`

It also needs the datastore connection env (`DATABASE_URL`, `REDIS_URL`,
`DORIS_HOST`, …) since it queries them directly.

## Tools

| Tool | Purpose |
| --- | --- |
| `query_traces` | List recent traces with filters (env, user, session, level, tag, score, search, day window). |
| `get_trace` | Full trace detail: metadata, observation tree, scores. |
| `get_metrics` | Project metrics (totals + per-day/per-model) over the last N days. |
| `list_scores` | Scores attached to a trace (name, value, source). |
| `run_evaluator` | Run an evaluator over a trace and record an EVAL score (write). |
| `list_prompts` | List prompts (name, folder, versions, channels). |
| `get_prompt` | Full prompt detail with every version. |
| `resolve_prompt` | Resolve a channel (default `production`) to compiled content + config. |
| `create_prompt_version` | Create a new prompt version (and the prompt if new). |
| `list_datasets` | List datasets with item/run counts. |
| `get_dataset` | Dataset items + runs. |
| `create_dataset` | Create a dataset (idempotent on name). |
| `add_dataset_items` | Append items (input / expectedOutput / metadata). |
| `list_review_queues` | List review queues with pending/done counts. |
| `create_review_queue` | Create a queue bound to a score name + data type. |
| `add_review_items` | Enqueue traces by id. |
| `list_review_items` | List queue items (default `PENDING`) with trace I/O. |
| `submit_review_score` | Score a review item (numeric/boolean `value` or categorical `stringValue`). |

## Run

```bash
bun --filter @memoturn/mcp start    # stdio; logs to stderr, JSON-RPC on stdout
```

## Configure an agent IDE

The server speaks stdio. Point your IDE's MCP config at it, e.g.:

```jsonc
{
  "mcpServers": {
    "memoturn": {
      "command": "bun",
      "args": ["run", "/path/to/memoturn/apps/mcp/src/index.ts"],
      "env": {
        "MEMOTURN_PUBLIC_KEY": "pk-mt-…",
        "MEMOTURN_SECRET_KEY": "sk-mt-…",
        "DATABASE_URL": "postgresql://…",
        "REDIS_URL": "redis://…",
        "DORIS_HOST": "…"
      }
    }
  }
}
```
