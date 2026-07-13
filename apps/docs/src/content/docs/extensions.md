---
title: Extensions
description: Self-authored tools — agents write, persist, and call their own tools, sandboxed like any other code.
---

**Extensions** are tools an agent writes for itself at runtime. An agent can compose new
capabilities from existing ones without any change to the core — and those tools persist across
turns, hibernation, and restarts.

## How they work

An agent calls `create_extension` with a `name`, `description`, optional input JSON-Schema, and
Python `code`. The extension is:

- **Persisted** durably in the agent's SQLite database (`extensions` table).
- **Registered live** in the [tool registry](/tools/) — it's callable immediately, in the same
  session.
- **Restored** automatically when the agent rehydrates from hibernation.

When the tool is called, its code runs in the [sandbox](/sandboxing/) exactly like `exec_code` —
same zero-ambient-authority isolation, with the [workspace](/workspace/) granted by default. The
call's arguments are made available to the code as `args`.

## Managing extensions

| Tool | Effect |
| --- | --- |
| `create_extension` | Create or update a self-authored tool. |
| `delete_extension` | Remove a self-authored tool. |
| `list_extensions` | List the agent's extensions. |

## Guardrails

- **Reserved names.** Extensions cannot shadow a built-in tool (`exec_code`, `remember`, `recall`,
  `run_shell`, `browse`, `set_context`, `call_subagent`, the extension-management tools, etc.).
- **Code-auditable.** Every extension's code is stored verbatim and can be inspected.
- **Sandboxed.** Extension code has no more authority than `exec_code` — it cannot reach the host or
  the network unless a capability is granted.

## Related

- [Tools](/tools/) — the registry extensions register into.
- [Sandboxing](/sandboxing/) — the isolation extension code runs under.
