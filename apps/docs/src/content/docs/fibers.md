---
title: Durable execution (fibers)
description: Crash-safe background tasks that checkpoint, sleep durably, retry, and resume from where they left off.
---

A **fiber** is a durable, resumable background task owned by an agent. Fibers checkpoint their
progress to SQLite, can sleep for arbitrary durations without holding a process, survive crashes,
and resume from their last checkpoint. They are Memoturn's answer to durable execution — the
equivalent of workflow engines, built on the agent's own database.

## How a fiber runs

1. **Registered durably** before it runs. If a `wake_at` is set in the future, it starts
   `suspended`; otherwise `pending`.
2. The [scheduler](#the-scheduler) picks it up and runs the registered handler under the agent's
   single-writer lock.
3. The handler checkpoints as it goes (`step`, `stash`, `sleep`).
4. On success it is `completed` with a result; on an unhandled error it retries with backoff, or is
   `failed` once attempts are exhausted.

### Status

`pending` → `running` → (`suspended` for durable sleep / retry) → `completed` | `failed`

## Checkpointing primitives

Handlers receive a context with these primitives:

| Primitive | Behavior |
| --- | --- |
| `step(key, fn)` | Run `fn` once and memoize under `key`. On resume, a completed step is skipped and its stored result returned — so external effects aren't repeated. |
| `stash(key, value)` | Persist an arbitrary checkpoint value. |
| `get(key, default)` | Read a stashed value. |
| `sleep(seconds)` | Durably sleep. The fiber suspends; the scheduler resumes it after the interval — no process is held meanwhile. |
| `sleep_until(ts)` | Durably sleep until an absolute timestamp. |
| `resources` | Access resources the agent exposed via `fiber_resources()`. |

Because steps are memoized and replayed, fibers are **at-least-once**: a step that crashes after
running may run again on resume. Make handlers with external side effects idempotent.

## The scheduler

A background scheduler sweeps every [`MEMOTURN_FIBER_POLL_SECONDS`](/configuration/#fibers-durable-execution)
(default `2`). Each sweep it discovers agents on disk, peeks for **ready** fibers without waking
idle actors, and resumes only those that are ready. A fiber is ready when it is:

- `pending`, or
- `suspended` with `wake_at <= now` (a durable sleep elapsed), or
- `running` but its heartbeat is older than
  [`MEMOTURN_FIBER_STALE_AFTER_SECONDS`](/configuration/#fibers-durable-execution) (default `60`) —
  i.e. the process crashed mid-run, so it is recovered.

## Managing fibers

| Operation | How |
| --- | --- |
| List fibers | `GET /v1/agents/{name}/fibers` |
| Start a fiber | `POST /v1/agents/{name}/fibers` with `{ "name": "...", "input": {...}, "delay_seconds": 0 }` |

A fiber summary reports `id`, `name`, `status`, `result`, `error`, `attempts`, and `wake_at`. See
the [REST API](/api-rest/).

Handlers are registered in code against the agent's fiber registry (e.g. a `@durable_task("name")`
decorator); the API starts a registered handler by name.

## Scheduled turns (cron)

The built-in `cron_turn` task runs a prompt as a normal agent turn on a schedule — durable,
traced, [middleware-wrapped](/guardrails/), and [webhook-notified](/webhooks/) like any user
turn. Each run re-schedules the next as a new fiber (a self-rescheduling chain), so crons fire
even for hibernated agents and survive restarts.

```
POST /v1/agents/{name}/crons
{ "prompt": "summarize today's incidents", "interval_seconds": 86400, "session": "shared" }
```

| Field | Values | Meaning |
| --- | --- | --- |
| `session` | `fresh` (default) / `shared` | `shared`: every run appends to one session, accumulating context (daily research, monitoring with state). `fresh`: a new session per run. |
| `on_run_completed` | `keep` (default) / `delete` | Cleanup for `fresh` sessions: keep them inspectable in session listings, or remove them after the run. |
| `interval_seconds` | `0` = run once | Recurrence interval. |
| `delay_seconds` | `0` = next sweep | Delay before the first run. |

A cron run never hijacks the agent's "current session" — sessionless chat clients are unaffected.
Stop a cron by cancelling its pending fiber: `DELETE /v1/agents/{name}/fibers/{fiber_id}` (this
also cancels any scheduled or suspended fiber; running ones finish their attempt first).

## Related

- [Agents & actors](/agents/) — fibers run under the actor's lock and live in its database.
- [Operations](/operations/) — running the scheduler in production.
