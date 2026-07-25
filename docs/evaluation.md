# Evaluation

memoturn supports three evaluation modes; all write **scores** into Doris, surfaced
on the trace alongside `API` feedback scores.

```mermaid
flowchart TD
  subgraph offline[Offline]
    ds[Dataset + items] --> run[Experiment run] --> ev1[Evaluator]
  end
  subgraph online[Online]
    ing[Incoming trace] --> sample{sampled?} -->|yes| ev2[Evaluator]
  end
  subgraph human[Human]
    q[Review queue] --> rev[Reviewer scores]
  end
  ev1 --> score[(scores in Doris)]
  ev2 --> score
  rev --> score
  score --> trace[Shown on the trace]
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

See the dataset example in [TS SDK](./sdk-typescript.md#datasets--experiments).

## Evaluators (LLM-as-judge)

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

![Review queues](./images/review.png)
