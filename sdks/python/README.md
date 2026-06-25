# memoturn Python SDK

Tracing, prompts, and the OpenAI wrapper for [memoturn](https://github.com/memoturn/memoturn).
Stdlib-only (no required dependencies).

```bash
pip install memoturn        # or: uv add memoturn
```

## Trace with the decorator

```python
from memoturn import Memoturn, configure, observe

configure(Memoturn(base_url="http://localhost:3001", public_key="pk-...", secret_key="sk-..."))

@observe()
def retrieve(q): ...

@observe(as_type="generation")
def answer(q, docs): ...

@observe(name="rag-pipeline")
def rag(q):
    return answer(q, retrieve(q))   # nested spans under one trace
```

The outermost `@observe` opens a trace; nested calls become child spans (a waterfall in
the console). Env vars `MEMOTURN_BASE_URL` / `MEMOTURN_PUBLIC_KEY` / `MEMOTURN_SECRET_KEY`
are used when not passed explicitly.

## Low-level API

```python
mt = Memoturn()
trace = mt.trace(name="chat", user_id="u1")
gen = trace.generation(name="answer", model="claude-sonnet-4-6", input=messages)
gen.end(output=reply, usage={"promptTokens": 100, "completionTokens": 20})
trace.score("user-feedback", value=1, comment="helpful")
mt.shutdown()  # flush
```

## OpenAI wrapper

```python
from openai import OpenAI
from memoturn import wrap_openai

client = wrap_openai(OpenAI())
client.chat.completions.create(model="gpt-4o-mini", messages=[...])  # recorded automatically
```

## Prompts

```python
from memoturn import get_prompt, compile_prompt

prompt = get_prompt("support-reply", channel="production")
messages = compile_prompt(prompt, product="memoturn", question="How do I trace a call?")
```
