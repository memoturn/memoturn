# memoturn Python SDK

Tracing, prompts, datasets, guardrails, and provider wrappers for
[memoturn](https://github.com/memoturn/memoturn). Stdlib-only — zero required
dependencies.

```bash
pip install memoturn        # or: uv add memoturn
```

Optional extras (discoverability only — the SDK itself never imports them at runtime):

```bash
pip install "memoturn[openai]"      # openai>=1.0 for wrap_openai
pip install "memoturn[anthropic]"   # anthropic>=0.30 for wrap_anthropic
pip install "memoturn[langchain]"   # langchain-core for MemoturnCallbackHandler
pip install "memoturn[otel]"        # OTel SDK + OTLP/HTTP exporter for span_exporter/span_processor
```

## Configuration

Every helper resolves credentials from arguments first, then environment variables:

| Env var | Default | Used for |
| --- | --- | --- |
| `MEMOTURN_BASE_URL` | `http://localhost:3001` | API origin |
| `MEMOTURN_PUBLIC_KEY` / `MEMOTURN_SECRET_KEY` | *(empty)* | Basic-auth API key pair |
| `MEMOTURN_ENVIRONMENT` | `default` | environment stamped on events |
| `MEMOTURN_MAX_BUFFER_SIZE` | `10000` | event buffer cap |
| `MEMOTURN_ALLOW_HTTP` | *(unset)* | `1` suppresses the cleartext-http warning |

`Memoturn(...)` constructor options:

```python
mt = Memoturn(
    base_url="https://api.example.com",  # default: MEMOTURN_BASE_URL
    public_key="pk-...",                 # default: MEMOTURN_PUBLIC_KEY
    secret_key="sk-...",                 # default: MEMOTURN_SECRET_KEY
    environment="production",            # default: MEMOTURN_ENVIRONMENT or "default"
    flush_at=20,                         # auto-flush when the buffer reaches this many events
    max_buffer_size=10_000,              # hard cap; new events are dropped once reached
    request_timeout=10.0,                # per-request timeout, seconds
    mask=None,                           # redaction hook: mask(value, field, event_type)
    allow_insecure_http=False,           # suppress the http-to-non-local-host warning
)
```

## Trace with the decorator

```python
from memoturn import Memoturn, configure, observe

configure(Memoturn())  # or rely on env vars; get_client() returns the same default

@observe()
def retrieve(q): ...

@observe(as_type="generation")
def answer(q, docs): ...

@observe(name="rag-pipeline")
def rag(q):
    return answer(q, retrieve(q))   # nested spans under one trace
```

The outermost `@observe` opens a trace; nested calls (sync or async) become child
spans. `configure(client)` sets the default client; `get_client()` returns it
(creating an env-configured one on first use).

## Low-level client

```python
mt = Memoturn()
trace = mt.trace(name="chat", userId="u1", sessionId="s1", tags=["prod"])

gen = trace.generation(name="answer", model="claude-sonnet-4-5", input=messages)
gen.end(output=reply, usage={"promptTokens": 100, "completionTokens": 20, "totalTokens": 120})

span = trace.span(name="retrieve", input=query)      # spans nest: span.span(), span.generation(), ...
span.end(output=docs)

tool = trace.tool(name="web-search", input=query)    # classified TOOL in the console
tool.end(output=results)
step = trace.agent(name="planner", input=state)      # classified AGENT
step.end(output=plan)

trace.event(name="cache-hit", metadata={"key": "k1"})   # point-in-time event
trace.score("user-feedback", value=1, comment="helpful")

mt.flush()      # send now; raises on failure (transient failures re-buffer first)
mt.shutdown()   # flush + unregister the atexit hook — call before process exit
```

`trace(...)` kwargs: `id`, `name`, `userId`, `sessionId`, `input`, `output`,
`metadata`, `tags`, `environment`, `release`, `version`. Span/generation kwargs are
listed on their docstrings.

## OpenAI wrapper

```python
from openai import OpenAI
from memoturn import wrap_openai

client = wrap_openai(OpenAI())
client.chat.completions.create(model="gpt-4o-mini", messages=[...])  # recorded automatically
client.responses.create(model="gpt-4o-mini", input="hi")             # Responses API too
```

Pass `wrap_openai(client, mt)` to use a specific `Memoturn` instance, or
`wrap_openai(client, trace=trace)` to nest all calls under an existing trace.

## Anthropic wrapper

```python
from anthropic import Anthropic
from memoturn import wrap_anthropic

client = wrap_anthropic(Anthropic())
client.messages.create(
    model="claude-sonnet-4-5",
    system="be terse",
    max_tokens=256,
    messages=[{"role": "user", "content": "2+2?"}],
)  # recorded: system + messages as input, usage incl. cache read/creation tokens
```

Same `memoturn=`/`trace=` options as `wrap_openai`. Streaming calls
(`stream=True`) pass through unrecorded.

## LangChain

```python
from memoturn import MemoturnCallbackHandler

chain.invoke(inputs, config={"callbacks": [MemoturnCallbackHandler()]})
```

Records chains, LLM/chat-model calls (with token usage), and tools as a trace
tree. Duck-typed — imports no LangChain packages.

## Prompts

```python
from memoturn import get_prompt, compile_prompt

prompt = get_prompt("support-reply", channel="production")
messages = compile_prompt(prompt, product="memoturn", question="How do I trace a call?")
```

If the channel runs an A/B split, pass a stable `bucket_key` (session/user id) so
the caller sticks to one arm; stamp the returned `prompt["version"]` on your
generation to attribute scores to the arm.

## Datasets & CI quality gates

```python
from memoturn import add_dataset_items, create_dataset, evaluate_gate, get_dataset, record_run

create_dataset("qa-regression", "golden Q&A set")
add_dataset_items("qa-regression", [{"input": "q1", "expectedOutput": "a1"}])

ds = get_dataset("qa-regression")
links = []
for item in ds["items"]:
    trace = mt.trace(name="eval-run", input=item["input"])
    # ... run your pipeline, end observations ...
    links.append({"datasetItemId": item["id"], "traceId": trace.id})
mt.flush()
record_run("qa-regression", "run-2026-07-16", links)

# Gate the run in CI — exit non-zero when quality regresses:
gate = evaluate_gate(
    "qa-regression",
    "run-2026-07-16",
    {"faithfulness": {"min": 0.8}, "toxicity": {"max": 0.1}},
    baseline_run="run-2026-07-09",  # enables "maxRegression" bounds
)
assert gate["passed"], gate["failures"]
```

## Guardrails

```python
from memoturn import check_guardrails

result = check_guardrails(user_input)
if result["verdict"] == "block":
    ...
elif result["verdict"] == "redact":
    user_input = result["redactedText"]
```

Scans text against the project's runtime guardrails (PII, prompt injection,
blocked terms). Verdict is `"allow"`, `"redact"`, or `"block"`.

## OpenTelemetry

Already instrumented with OTel? Point it at memoturn's OTLP/HTTP receiver:

```python
from memoturn.otel import otlp_config, span_exporter, span_processor

cfg = otlp_config()  # {"endpoint": ".../v1/otel/v1/traces", "headers": {"Authorization": "Basic ..."}}
# dependency-free: pass into any OTLP/HTTP exporter yourself, or:

provider.add_span_processor(span_processor())  # needs: pip install "memoturn[otel]"
exporter = span_exporter()                     # just the exporter, bring your own processor
```

GenAI semantic-convention attributes (`gen_ai.*`) map to traces + generations.

## Production notes

See [BEST_PRACTICES.md](./BEST_PRACTICES.md) for HTTPS/key handling, flushing and
buffer behavior, PII masking, timeouts, environments, and CI gating guidance.
