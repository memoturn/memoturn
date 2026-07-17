---
title: Python SDK
description: Stdlib-only Python SDK (memoturn on PyPI) with the @observe decorator, wrappers, and prompts.
---

The Python SDK (`memoturn` on PyPI) is stdlib-only — no required dependencies. Install with
`pip install memoturn` or `uv add memoturn`. Configure via the constructor or the env vars
`MEMOTURN_BASE_URL` / `MEMOTURN_PUBLIC_KEY` / `MEMOTURN_SECRET_KEY` /
`MEMOTURN_ENVIRONMENT` / `MEMOTURN_MAX_BUFFER_SIZE` (buffered-event cap, default 10000) /
`MEMOTURN_ALLOW_HTTP` (suppress the cleartext-http warning for non-local hosts).

## `@observe` decorator

The outermost `@observe` opens a trace; nested calls become child spans. Works for sync and async
functions.

```python
from memoturn import Memoturn, configure, observe

configure(Memoturn(base_url="http://localhost:3001", public_key="pk-mt-dev", secret_key="sk-mt-dev"))

@observe()
def retrieve(query): ...

@observe(as_type="generation")          # records a generation instead of a span
def answer(question, docs): ...

@observe(name="rag-pipeline")
def rag(question):
    return answer(question, retrieve(question))
```

## Low-level API

```python
mt = Memoturn()
trace = mt.trace(name="chat", user_id="u1", session_id="s1")
gen = trace.generation(name="answer", model="claude-sonnet-4-6", input=messages)
gen.end(output=reply, usage={"promptTokens": 100, "completionTokens": 20})
trace.score("user-feedback", value=1, comment="helpful")
mt.shutdown()  # flush (also flushed atexit)
```

## OpenAI wrapper

```python
from openai import OpenAI
from memoturn import wrap_openai

client = wrap_openai(OpenAI())
client.chat.completions.create(model="gpt-4o-mini", messages=[...])  # recorded
```

## LangChain

```python
from memoturn.langchain import MemoturnCallbackHandler

chain.invoke(inputs, config={"callbacks": [MemoturnCallbackHandler()]})
```

## LlamaIndex

```python
from memoturn.llamaindex import MemoturnLlamaIndexHandler
from llama_index.core import Settings
from llama_index.core.callbacks import CallbackManager

Settings.callback_manager = CallbackManager([MemoturnLlamaIndexHandler()])
```

Records query/retrieve/synthesize/LLM/tool/agent steps as a nested trace tree (using
LlamaIndex's own parent ids), including retrieved documents and embeddings.

## Prompts

```python
from memoturn import get_prompt, compile_prompt

prompt = get_prompt("support-reply", channel="production")
messages = compile_prompt(prompt, product="memoturn", question=q)
```
