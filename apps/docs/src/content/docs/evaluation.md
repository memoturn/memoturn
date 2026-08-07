---
title: Evaluation
description: Offline, online, and human evaluation modes that all write scores onto your traces.
---

Memoturn supports three evaluation modes; all write **scores** into Doris, surfaced
on the trace alongside `API` feedback scores.

```
Offline:  Dataset + items ──► Experiment run ──► Evaluator ─────┐
Online:   Incoming trace ──► sampled? ──yes──► Evaluator ───────┼──► scores (Doris)
Human:    Review queue ──► Reviewer scores ─────────────────────┘            │
                                                                             ▼
                                                                    shown on the trace
```

| Mode | Source | How |
| --- | --- | --- |
| Offline | `EVAL` | Run an evaluator over a dataset/experiment |
| Online | `EVAL` | The worker samples production traces and scores them automatically |
| Human | `ANNOTATION` | Reviewers score traces in a review queue |

## Datasets & experiments (offline)

1. Create a dataset and add items (`input`, optional `expectedOutput`).
2. Run your task over each item, producing a trace per item.
3. Record a run linking items → traces (`POST /v1/datasets/{name}/runs`, or
   `dataset.recordRun()` in the SDK).
4. Score the traces (via an evaluator or human review).

See the dataset example in [TS SDK](/sdk-typescript/#datasets--experiments).

## Evaluators

An evaluator is a judge prompt + provider/model. Providers: `mock` (deterministic, no key
— for local testing), `anthropic`, `openai`.

```bash
# create
curl -u pk-mt-dev:sk-mt-dev -X POST http://localhost:3001/v1/evaluators \
  -H 'content-type: application/json' \
  -d '{"name":"helpfulness","prompt":"Score how well output answers input (0..1).","provider":"mock","model":"mock-1"}'

# run over a trace's input/output → writes an EVAL score
curl -u pk-mt-dev:sk-mt-dev -X POST http://localhost:3001/v1/evaluators/helpfulness/run \
  -H 'content-type: application/json' \
  -d '{"traceId":"<id>","input":{"q":"…"},"output":"…"}'
```

The judge is asked to return strict JSON `{"score": 0..1, "reasoning": "…"}`.

The prebuilt library (`GET /v1/evaluators/templates`, instantiate via `POST
/v1/evaluators/from-template`) covers RAG/quality dimensions plus **conversation-quality**
metrics (user frustration, knowledge retention, session completeness, conversational
coherence) and **agent-trajectory** metrics (trajectory accuracy, tool correctness, task
completion).

## Code evaluators (deterministic checks)

Not every check deserves a model. "Is this valid JSON?", "does it match `^[A-Z]{3}-[0-9]{4}$`?",
"is it under 500 characters?" have exact answers, and asking an LLM for them is slow, costly, and
less reliable than the obvious computation.

A **code evaluator** (`kind: "CODE"`) is an expression instead of a judge prompt. It runs locally
— no provider call, no API key, no cost, and the same answer every time.

```bash
curl -u pk-mt-dev:sk-mt-dev -X POST http://localhost:3001/v1/evaluators \
  -H 'content-type: application/json' \
  -d '{"name":"json-contract","kind":"CODE","model":"n/a",
       "expression":"jsonValid(output) and jsonPath(jsonParse(output), \"$.status\") == \"ok\""}'
```

Everything else works identically to an LLM evaluator: online sampling, thread scope, dataset
experiments, guardrails, version history, and the EVAL score it writes.

### The expression language

Expressions are evaluated against four variables — `input`, `output`, `expected`, `metadata` —
and must return a **boolean** (pass/fail → 1/0) or a **number in [0, 1]** for a graded score.
Anything else is an error rather than a silently coerced score.

| | |
| --- | --- |
| **Operators** | `and` `or` `not` (also `&&` `\|\|` `!`), `==` `!=` `<` `<=` `>` `>=`, `+` `-` `*` `/` `%`, `a ? b : c` |
| **Access** | `output.field`, `output["field"]`, `output.items[0]`, `output.length` |
| **Strings** | `contains` `startsWith` `endsWith` `lower` `upper` `trim` `words` `matches` |
| **JSON** | `jsonValid` `jsonParse` `jsonPath` `has` `exactMatch` |
| **Numbers** | `num` `abs` `round` `min` `max` `len` `isEmpty` `coalesce` |

```
len(output) < 500
not contains(lower(output), "i cannot")
matches(output, "^[A-Z]{3}-[0-9]{4}$")
exactMatch(output, expected)
min(1, len(words(output)) / 50)          # a graded score, not just pass/fail
has(metadata, "score") and metadata.score > 0.5
```

`GET /v1/evaluators/presets` returns a library of ready-made checks (regex, JSON shape, length,
exact match, …) that the console offers as a menu; picking one fills in an editable expression.
`POST /v1/evaluators/test-expression` dry-runs an expression against a sample item — the console
uses it for the "Try it" panel, and it reports the raw value even when that value isn't a valid
score, which is exactly when you need to see it.

### Why an expression language and not "just run JavaScript"

Evaluators are user-authored config that executes inside the **shared ingest worker**, so the
language is safe by construction rather than by sandboxing:

- No `eval`, no `Function`, no host object graph, and no way to name anything not bound — there
  are no callable values, so `output.constructor()` is unparseable rather than merely blocked.
- Property reads are `hasOwn`-gated and `__proto__` / `constructor` / `prototype` are refused.
- `matches()` rejects patterns with nested repetition (the ReDoS signature) using the same static
  check the PII-masking policy uses, and caps subject length.
- Termination is structural — the language has no loops or recursion — with a node budget and a
  parser depth cap as backstops.
- It is dependency-free and portable: no `node:vm`, no WASM, so it behaves identically in the
  worker, the API, and a future edge profile (see [ADR-0003](/adr/0003-edge-deployment-profile/)).

Expressions are compiled at **write** time, so a broken check is a `400` when you save it rather
than a silent per-event failure in the worker later.

### LLM juries (ensemble judging)

Pass `jurors` — a list of `{provider, model}` — to turn an evaluator into an ensemble. The
same judge prompt runs against every juror and the score is the **mean** of their votes
(a juror that errors is dropped; the panel only fails if all jurors do). This reduces
single-judge variance:

```json
{ "name": "quality", "prompt": "…", "model": "mock-1",
  "jurors": [{ "provider": "openai", "model": "gpt-x" }, { "provider": "anthropic", "model": "claude-y" }] }
```

### Online evaluation

Enable `online` with a `samplingRate` (and optional `filterName`). After each ingest
batch, the worker runs enabled online evaluators on the batch's **completed** traces
(those carrying an output), deterministically sampled by `hash(traceId:evaluator)`:

```json
{ "name": "auto-quality", "prompt": "…", "provider": "mock", "model": "mock-1",
  "online": true, "samplingRate": 1.0, "filterName": "" }
```

### Thread (conversation) evaluation

Set `scope: "thread"` (with `online: true`) to score whole conversations instead of single
traces. A per-minute worker cron finds sessions that have been quiet for `cooldownSeconds`
(default 900), assembles the session transcript, judges it, and writes one score to the
session's latest trace — so multi-turn conversations "settle" before being judged:

```json
{ "name": "user-frustration", "prompt": "…", "provider": "mock", "model": "mock-1",
  "online": true, "scope": "thread", "cooldownSeconds": 900 }
```

### CI gates (`mt eval`)

`mt eval` (shipped with the JS SDK) gates a dataset run's evaluator score means against
thresholds and exits non-zero on a regression — drop it into CI to fail a PR on eval drift.
See the TypeScript SDK docs and `POST /v1/datasets/{name}/runs/{run}/gate`.

## Human review queues

```bash
# create a queue + enqueue traces
curl -u pk-mt-dev:sk-mt-dev -X POST http://localhost:3001/v1/review-queues \
  -H 'content-type: application/json' -d '{"name":"q1","scoreName":"human-rating","dataType":"NUMERIC"}'
curl -u pk-mt-dev:sk-mt-dev -X POST http://localhost:3001/v1/review-queues/q1/items \
  -H 'content-type: application/json' -d '{"traceIds":["<id>"]}'

# reviewer submits a score (writes an ANNOTATION score, marks item done)
curl -u pk-mt-dev:sk-mt-dev -X POST http://localhost:3001/v1/review-queues/q1/items/<itemId>/score \
  -H 'content-type: application/json' -d '{"value":0.8,"comment":"looks good"}'
```

The console **Review** page shows each pending item's trace input/output with an inline
scoring form.

![Review queues — pending items with inline scoring](../../assets/screenshots/review.png)

Evaluator runs and their scores are visible on the **Evaluators** page:

![Evaluators — LLM-as-judge configs and recent runs](../../assets/screenshots/evaluators.png)
