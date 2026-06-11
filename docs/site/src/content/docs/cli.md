---
title: CLI
description: The memoturn command — databases, branches, SQL, KV, typed agent memory, tokens, and sync against a running node.
---

`memoturn` is a thin client over the [REST API](/api-rest/). It targets one node or gateway and
prints JSON responses; the `Memoturn-Txid` of each response goes to stderr (`txid: N`), so
output stays pipeable. See [quickstart](/quickstart/) for getting a node running.

## Global flags

| Flag | Env var | Default | Purpose |
| --- | --- | --- | --- |
| `--url` | `MEMOTURN_URL` | `http://127.0.0.1:8080` | Base URL of a `memoturnd` node / gateway |
| `--token` | `MEMOTURN_TOKEN` | — | Per-database or namespace JWT (data-plane commands) |
| `--platform-key` | `MEMOTURN_PLATFORM_KEY` | — | Platform key (control-plane commands: `db`, `token`) |

Control-plane commands authenticate with the platform key, data-plane commands with the token;
either falls back to the other. With auth off (the dev default), neither is needed.

## memory

Typed agent memory against `/v1/memory/{ns}/{profile}` — see [memories](/memories/) and
[recall](/recall/).

```bash
memoturn memory ingest <ns> <profile> --summary <gist> [--type fact|event|instruction|task]
                                      [--topic <key>] [--content <json>] [--keywords <terms>]
                                      [--session <id>] [--ttl <secs>]
memoturn memory recall  <ns> <profile> [<query>] [--topic <key>] [--k 8] [--type <t>]...
                                      [--include-superseded]
memoturn memory extract <ns> <profile> [--session <id>] [--dry-run]   # turns JSON on stdin
memoturn memory get     <ns> <profile> <id>
memoturn memory forget  <ns> <profile> <id>
memoturn memory sessions <ns> <profile>
memoturn memory profiles <ns>
```

```bash
# every agent serving acme's user "alice" shares one profile
memoturn memory ingest acme alice --type fact --topic user.diet \
  --summary "vegetarian since 2024" --keywords "food preference"

memoturn memory recall acme alice "what can this user eat?"
# ranked memories with channel attribution; superseded facts hidden
```

`ingest` stores one memory per invocation; `--content` defaults to `{"summary": <summary>}`, and
the profile auto-creates on first ingest. `recall` drives the keyword and topic channels; the
vector channel needs an embedding, which the CLI does not compute — use the API or SDKs (or
enable node-side [auto-embedding](/embeddings/), which embeds bare query strings at recall).
`extract` reads a JSON array of `{role, content}` turns from stdin and needs a node with
server-side [extraction](/extraction/) configured:

```bash
echo '[{"role": "user", "content": "I am vegan now"}]' \
  | memoturn memory extract acme alice --dry-run
```

`profiles` lists every profile under a namespace and requires a namespace token.

## db

Control-plane database management (platform key when auth is on).

```bash
memoturn db create <name>
memoturn db list
memoturn db delete <name>

memoturn db create agent-42
```

`db delete` writes a deletion tombstone: write tokens minted before the deletion are rejected
(`403`), so a stale token cannot write into a re-created database of the same name. See
[security](/security/#token-revocation).

## branch

Copy-on-write branches, checkpoints, and rewind — see [branching](/branching/).

```bash
memoturn branch create <db> <name> [--from <branch>] [--ttl <secs>]
memoturn branch list <db>
memoturn branch delete <db> <name>
memoturn branch checkpoint <db> <branch> <name>
memoturn branch rewind <db> <branch> <to>          # checkpoint name or txid

memoturn branch checkpoint agent-42 main before-task
memoturn branch create agent-42 experiment --ttl 3600   # burner branch, auto-expires
memoturn branch rewind agent-42 main before-task
```

## sql

Run SQL against a database. `spec` is `name` or `name@branch`; statements split on `;`. Reads
stdin when the query argument is omitted.

```bash
memoturn sql <spec> [<query>]

memoturn sql agent-42 "SELECT count(*) FROM orders WHERE status = 'open'"
memoturn sql agent-42@experiment < migration.sql
```

## kv

KV namespaces with TTL inside a database.

```bash
memoturn kv put <spec> <ns> <key> <value> [--ttl <secs>]
memoturn kv get <spec> <ns> <key>
memoturn kv delete <spec> <ns> <key>
memoturn kv list <spec> <ns> [--prefix <p>]

memoturn kv put agent-42 scratch plan "step 1: fetch orders" --ttl 3600
memoturn kv list agent-42 scratch --prefix step:
```

## sync

Ship a database's state to object storage now — an explicit durability point.

```bash
memoturn sync agent-42
```

## token

Mint JWTs (platform key required). Scopes: `read`, `write`, `admin`; default TTL 3600 s.

```bash
memoturn token create <db> [--scope write] [--ttl 3600]      # one database / profile
memoturn token create-ns <ns> [--scope write] [--ttl 3600]   # every profile under the namespace
```

The full auth flow against a node with auth enabled:

```bash
# start the node with auth on
MEMOTURN_AUTH=on MEMOTURN_PLATFORM_KEY=... memoturnd

# mint a per-database token, then use it for data-plane commands
memoturn --platform-key ... token create agent-1 --scope write
memoturn --token <jwt> kv put agent-1 scratch plan "..."

# orchestrator posture: one token for every acme profile
memoturn token create-ns acme --scope write
```

See [security](/security/) for token semantics and [configuration](/configuration/) for the
node-side `MEMOTURN_*` variables.

## ask

Asks the built-in assistant. The assistant ships post-prototype; in the current build the
command exits with an error pointing at the design document. See [roadmap](/roadmap/).

```bash
memoturn ask "why is recall empty for profile alice?"
```
