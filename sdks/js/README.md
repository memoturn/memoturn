# @memoturn/sdk

JavaScript/TypeScript SDK for [memoturn](https://github.com/memoturn/memoturn) — open-source LLM
observability, evals, prompts, and metrics. Trace LLM calls, wrap the OpenAI SDK, hook into
LangChain, and fetch deployed prompts. Zero runtime dependencies.

## Install

```bash
npm install @memoturn/sdk
# openai wrapper is optional
npm install openai
```

## Quickstart

```ts
import { Memoturn } from "@memoturn/sdk";

const memoturn = new Memoturn({
  baseUrl: "http://localhost:3001",
  publicKey: "pk-mt-...",
  secretKey: "sk-mt-...",
});

const trace = memoturn.trace({ name: "chat", userId: "u_123" });
const gen = trace.generation({ name: "answer", model: "gpt-4o", provider: "openai", input: messages });
gen.end({ output, usage: { promptTokens: 42, completionTokens: 8, totalTokens: 50 } });
trace.score({ name: "helpfulness", value: 0.9, dataType: "NUMERIC" });

await memoturn.shutdown(); // flush before exit
```

Credentials fall back to `MEMOTURN_BASE_URL`, `MEMOTURN_PUBLIC_KEY`, and `MEMOTURN_SECRET_KEY`.
The client batches events and flushes on a timer, at `flushAt` events, or on `shutdown()`.

## OpenAI wrapper

```ts
import OpenAI from "openai";
import { wrapOpenAI } from "@memoturn/sdk/openai";

const openai = wrapOpenAI(new OpenAI(), memoturn);
// every call is recorded as a generation (model, params, usage, latency, output)
await openai.chat.completions.create({ model: "gpt-4o", messages });
```

## LangChain

```ts
import { MemoturnCallback } from "@memoturn/sdk/langchain";

const handler = new MemoturnCallback(memoturn, { traceName: "agent-run" });
await chain.invoke(input, { callbacks: [handler] });
await handler.flush();
```

## Prompts

```ts
import { compilePrompt, getPrompt } from "@memoturn/sdk";

const prompt = await getPrompt(memoturn, "support-reply", { channel: "production" });
const messages = compilePrompt(prompt, { customer: "Ada" });
```

## Datasets

```ts
import { addDatasetItems, createDataset, getDataset } from "@memoturn/sdk";

await createDataset(memoturn, "qa", "regression set");
await addDatasetItems(memoturn, "qa", [{ input: "2+2?", expectedOutput: "4" }]);
const ds = await getDataset(memoturn, "qa");
await ds.recordRun("baseline", [{ datasetItemId: ds.items[0].id, traceId: trace.id }]);
```

## License

Apache-2.0
