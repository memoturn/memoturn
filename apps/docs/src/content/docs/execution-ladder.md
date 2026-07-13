---
title: The execution ladder
description: The additive tiers of agent capability — from a durable filesystem and chat up to full-OS shell.
---

Memoturn's capabilities are **additive**. An agent is useful at the bottom rung with nothing but a
durable filesystem and chat, and climbs only as far as a task needs. Each tier is opt-in and
governed by [configuration](/configuration/) and granted [capabilities](/sandboxing/) — nothing is
inherited.

| Tier | Capability | Backed by |
| --- | --- | --- |
| **0** | Durable [workspace](/workspace/) + chat + [memory](/memory/) | SQLite + blob store |
| **1** | Sandboxed Python code execution | [subprocess / Docker / Kubernetes](/sandboxing/) |
| **2** | Runtime dependency resolution | `uv`-built, cached virtualenvs |
| **3** | Headless browser | Playwright (`browser` extra) |
| **4** | Full-OS shell (git, compilers, test runners) | container or local shell |

## Why a ladder

- **Useful at Tier 0 alone.** Persistence and recall need no sandbox, no containers, no extra
  infrastructure.
- **Pay for what you use.** Code execution, browsing, and shell access each carry cost and risk;
  they're enabled deliberately, not by default.
- **Security scales with the rung.** Tier 0 touches only the agent's own database. Higher tiers run
  in [sandboxes with zero ambient authority](/sandboxing/), where every outside effect is an
  explicitly granted capability.

## Tier details

- **Tier 0 — Workspace + memory.** The [workspace](/workspace/) virtual filesystem and
  [long-term memory](/memory/). Always available.
- **Tier 1 — Code.** The `exec_code` tool runs Python in a [sandbox](/sandboxing/). The workspace is
  granted by default and can be withheld.
- **Tier 2 — Dependencies.** When `MEMOTURN_SANDBOX_ALLOW_DEPENDENCIES` is on (default), code may
  declare PyPI dependencies, resolved into a cached virtualenv with `uv`.
- **Tier 3 — Browser.** With `MEMOTURN_BROWSER_ENABLED`, the `browse` tool fetches rendered pages or
  screenshots via headless Chromium.
- **Tier 4 — Shell.** The `run_shell` tool runs commands against a [materialized](/workspace/#materialization)
  copy of the workspace — in a container (production) or, for dev only, the local host
  (`MEMOTURN_SANDBOX_ENABLE_LOCAL_SHELL`).

## Related

- [Sandboxing](/sandboxing/) — backends and the zero-ambient-authority model.
- [Tools](/tools/) — the tools that expose each tier.
- [Workspace](/workspace/) — the Tier 0 foundation.
