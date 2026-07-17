# memoturn Python SDK — production best practices

Grounded in the actual implementation (`src/memoturn/client.py`); each section
notes the exact behavior you can rely on.

## Keys and transport

- Load API keys from the environment (`MEMOTURN_PUBLIC_KEY` / `MEMOTURN_SECRET_KEY`)
  — never hardcode them. The client warns once at construction if both are empty.
- Use HTTPS for any non-local `base_url`. The SDK sends keys as Basic auth, so a
  plain-`http` URL to a non-local host triggers a one-time-per-origin warning on
  the `memoturn` logger. Deliberate plain-http deployments (e.g. a LAN self-host)
  can silence it with `Memoturn(allow_insecure_http=True)` or
  `MEMOTURN_ALLOW_HTTP=1` — it never raises either way.

## Flushing and shutdown

- Events are buffered in memory and sent when the buffer reaches `flush_at`
  (default 20) or when you flush explicitly. Buffered events are lost if the
  process dies without a flush.
- Call `mt.shutdown()` before exit: it flushes (raising on failure so you notice)
  and unregisters the atexit hook. The atexit hook is a best-effort quiet flush —
  it never raises and won't run on `SIGKILL`, `os._exit()`, or a crashed
  interpreter, so don't rely on it in servers or batch jobs.
- `mt.flush()` raises on failure. Transient failures (network errors, 5xx, 408,
  429) re-buffer the batch *before* raising, so nothing is lost and a later flush
  retries it. Permanent rejects (other 4xx — bad auth, bad request) drop the
  batch: retrying them can never succeed.
- A 207 response means per-event results: schema-rejected events are logged as
  warnings (they are not retried) while the rest were accepted.

## Buffer sizing

- The buffer is hard-capped at `max_buffer_size` (default 10 000, override via
  the constructor or `MEMOTURN_MAX_BUFFER_SIZE`). Two overflow behaviors:
  - **New events while full** (e.g. the API is unreachable and retries keep
    re-buffering): incoming events are *dropped* with a one-time warning.
  - **Re-buffer overflow** (a failed batch + newer events exceed the cap): the
    *oldest* events are dropped, keeping the newest.
- Size it for your outage tolerance: at `flush_at=20` and steady traffic, the cap
  bounds memory during an API outage; 10k events is usually a few MB. Raise it if
  you'd rather buffer through longer outages, lower it in memory-tight workers.

## Masking PII

Pass a `mask` hook to redact before anything leaves the process. It runs at
enqueue time on the `input`, `output`, and `metadata` fields of every event:

```python
import re

EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+")

def mask(value, field, event_type):
    # value: the field's value; field: "input"|"output"|"metadata";
    # event_type: "trace-create", "generation-update", ...
    return EMAIL.sub("[email]", value) if isinstance(value, str) else value

mt = Memoturn(mask=mask)
```

If the hook raises, the event is still sent but the field is replaced with the
sentinel `"<memoturn: mask error>"` — the unmasked value is never sent and the
event is never dropped.

## Timeouts

- Ingest requests use `Memoturn(request_timeout=...)` (default 10 s). A timeout
  surfaces as a transient failure, so the batch re-buffers.
- `get_prompt`, the dataset helpers, and `check_guardrails` each take their own
  `timeout=` argument (default 10 s). Prompt fetches sit on your request path —
  consider a shorter timeout there plus a cached fallback prompt.

## Environments

- The client stamps every event with its `environment` (constructor arg or
  `MEMOTURN_ENVIRONMENT`, default `"default"`). Set it per deployment
  (`production`, `staging`, ...) so console filters separate traffic.
- A single trace can override it — `mt.trace(name="job", environment="staging")` —
  and all of that trace's spans, generations, events, and scores inherit the
  trace's resolved environment, not the client default.

## Agentic traces

Use the typed helpers so agent runs render meaningfully (colors, agent-flow
graph) in the console:

- `trace.tool(name="web-search", ...)` / `span.tool(...)` — a TOOL span.
- `trace.agent(name="planner", ...)` / `span.agent(...)` — an AGENT step.
- Equivalent: pass `observationType="TOOL"` or `"AGENT"` to `span(...)`.
- Repeated tool/agent names across a run are what the aggregated graph view
  collapses into loops — keep names stable, not per-invocation-unique.

## CI quality gates

Gate merges on evaluator scores with `evaluate_gate`:

```python
gate = evaluate_gate(
    "qa-regression", run_name,
    {"faithfulness": {"min": 0.8}, "answer-relevance": {"maxRegression": 0.05}},
    baseline_run=main_branch_run,  # required for maxRegression bounds
)
if not gate["passed"]:
    raise SystemExit(f"quality gate failed: {gate['failures']}")
```

Flush (`mt.flush()`) before `record_run`/`evaluate_gate` so the run's traces and
scores have actually been ingested.

## Logging

All diagnostics go to the standard-library logger named `"memoturn"` — dropped
batches, re-buffers, 207 partial rejects, buffer-full and cleartext-http
warnings. Wire it into your logging setup and alert on `ERROR`:

```python
import logging
logging.getLogger("memoturn").setLevel(logging.WARNING)
```

Background flushes (size-triggered and atexit) never raise into your code; the
logger is the only place their failures appear.
