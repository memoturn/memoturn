---
title: Sandboxing
description: Running untrusted code with zero ambient authority — subprocess, Docker, and gVisor/Kubernetes backends, and the capability bridge.
---

Memoturn runs agent-authored code in a **sandbox** built on a single principle: **zero ambient
authority**. Sandboxed code starts with no access to the network, the filesystem, or the host.
Anything it can do, it does through a **capability** the caller explicitly granted — there is
nothing to inherit.

## Zero ambient authority

When code runs, the only things it inherits are `PATH`, an unbuffered stdout, and the paths it
needs to read its code and write its result. To touch the outside world it calls a named
capability — e.g. `workspace.read` — over a bridge back to the control plane. The bridge **fails
closed**: a method that wasn't granted returns an error. So `exec_code` with no grants is pure
compute; the [workspace](/workspace/) is granted only when asked for (and on by default for
`exec_code`).

## Backends

Select with [`MEMOTURN_SANDBOX_BACKEND`](/configuration/#sandbox--execution):

| Backend | Isolation | Use for |
| --- | --- | --- |
| **`subprocess`** (default) | Process isolation + POSIX limits (CPU, file size). Shares the host kernel and filesystem. | Trusted/dev, single-tenant, CI. Not a boundary for untrusted multi-tenant code. |
| **`docker`** | Throwaway container: `--network=none`, all capabilities dropped, read-only root, non-root user, no-new-privileges, memory/CPU/PID limits, tmpfs `/tmp`. | Untrusted code in production. |
| **`k8s`** | gVisor-isolated pod: a [RuntimeClass](/configuration/#sandbox--execution) (default `gvisor`), no service-account token, non-root, read-only root, all caps dropped, seccomp `RuntimeDefault`, deny-all network. | Cloud-scale untrusted code, data residency. **Does not yet support declared dependencies** (Tier 2) — see below. |

Resource limits apply across backends: `MEMOTURN_SANDBOX_TIMEOUT_SECONDS` (30), `…_MEMORY_MB`
(256), `…_CPUS` (1.0), `…_MAX_PROCESSES` (128). The sandbox image is `MEMOTURN_SANDBOX_IMAGE`.

### The capability bridge

The bridge is how granted capabilities reach sandboxed code:

- **subprocess / Docker** — a Unix-socket JSON-RPC server.
- **Kubernetes** — a TCP server (`MEMOTURN_SANDBOX_K8S_BRIDGE_ENABLED`,
  `…_BRIDGE_PORT`, `…_BRIDGE_HOST`), with one-time tokens per execution. A NetworkPolicy must allow
  sandbox→control-plane egress on the bridge port; without the bridge, K8s pods run as pure compute
  (workspace access fails closed).

## Higher tiers

- **Dependencies (Tier 2).** With `MEMOTURN_SANDBOX_ALLOW_DEPENDENCIES` (default on), code can
  declare PyPI dependencies; they're resolved into a content-addressed, cached virtualenv with `uv`
  and mounted read-only. Supported on the `subprocess` and `docker` backends. The `k8s` backend
  does not support this yet — code that declares dependencies is rejected before the pod is
  scheduled (`the k8s sandbox backend does not support dependencies yet`); it is a tracked
  follow-up. Run dependency-declaring code on the `docker` backend until then.
- **Browser (Tier 3).** `MEMOTURN_BROWSER_ENABLED` enables headless Chromium (Playwright); the
  `browser` extra and `playwright install chromium` are required.
- **Shell (Tier 4).** `run_shell` runs commands against a [materialized](/workspace/#materialization)
  workspace. In production this is a container (`MEMOTURN_SANDBOX_FULL_IMAGE`, with
  `MEMOTURN_SANDBOX_SHELL_NETWORK` and `…_SHELL_TIMEOUT_SECONDS`). The local-shell backend runs on
  the host with no isolation and is **dev-only** (`MEMOTURN_SANDBOX_ENABLE_LOCAL_SHELL`).

## Warm pools

Container backends pay a create+start cold start per execution. With
[`MEMOTURN_SANDBOX_WARM_POOL_SIZE`](/configuration/#sandbox--execution) set, the Docker backend
keeps that many containers pre-started ahead of demand: an execution takes a warm slot instantly
and a background refill replaces it.

Slots are **strictly single-use** — a warm container is pre-*started*, used once, destroyed.
Nothing is ever recycled across executions or tenants, so pooling changes latency, not
isolation; warm and cold containers share the same hardening flags. Idle slots self-expire
(`MEMOTURN_SANDBOX_WARM_MAX_IDLE_SECONDS`) as leak protection, and executions that declare extra
`dependencies` bypass the pool (their resolved venv must be mounted at container creation).

## HTTP egress with credential injection

Sandboxed code has no network. When `MEMOTURN_SANDBOX_HTTP_ENABLED` is set it instead gets an
`http_fetch(url, method, headers, body)` helper backed by an `http.fetch` capability: the
**host** performs the outbound request and injects operator-configured credentials by host
match. The program receives `{status, headers, body, truncated}` and never holds a secret — a
prompt-injected program cannot exfiltrate what it never had.

```bash
MEMOTURN_EGRESS_CREDENTIALS='[{"host":"api.github.com","header":"authorization","secret":"GITHUB_TOKEN"}]'
```

Rules, all enforced host-side: every URL passes the SSRF guard (private/metadata addresses are
blocked, DNS-rebinding-safe); an optional allowlist (`MEMOTURN_SANDBOX_HTTP_ALLOW_HOSTS`, exact
hosts or `*.suffix` for proper subdomains) restricts targets; credentials inject **only over
HTTPS** and override any program-supplied header of the same name; redirects are surfaced, not
followed; response headers are filtered (no cookies) and bodies capped. A credential can also
name an [`oauth_provider`](/enterprise/#oauth-token-vault) to inject a live, auto-refreshed
token from the Enterprise vault instead of a static value.

## Extensions run sandboxed too

[Self-authored tools](/extensions/) execute in the same sandbox as `exec_code`, with the same
zero-ambient-authority model — an agent extending itself cannot escape the boundary.

## Choosing a backend

- **Local dev / trusted single-tenant** → `subprocess`.
- **Untrusted code, single host** → `docker` (mount the Docker socket only on trusted hosts).
- **Untrusted code at scale / data residency** → `k8s` with a gVisor RuntimeClass and a
  deny-all NetworkPolicy. See [Operations](/operations/) and [Deployment](/deployment/).

## Related

- [Execution ladder](/execution-ladder/) — where sandboxing sits.
- [Workspace](/workspace/) — the capability sandboxed code is usually granted.
- [Operations](/operations/) — hardening the sandbox in production.
