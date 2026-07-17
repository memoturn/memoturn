# TypeScript SDK (`@memoturn/sdk`)

Tracing, prompts, and an OpenAI wrapper. Configure via constructor or the env vars
`MEMOTURN_BASE_URL`, `MEMOTURN_PUBLIC_KEY`, `MEMOTURN_SECRET_KEY`, `MEMOTURN_ENVIRONMENT`,
`MEMOTURN_MAX_BUFFER_SIZE` (buffered-event cap, default 10000), and `MEMOTURN_ALLOW_HTTP`
(suppress the cleartext-http warning for non-local hosts).

## Tracing

```ts
import { Memoturn } from "@memoturn/sdk";

const mt = new Memoturn({
  baseUrl: "http://localhost:3001",
  publicKey: "pk-mt-dev",
  secretKey: "sk-mt-dev",
});

const trace = mt.trace({ name: "rag", userId: "u1", sessionId: "s1", input: { q } });

const retrieval = trace.span({ name: "retrieve", input: { q } });
retrieval.end({ output: docs });

const gen = trace.generation({
  name: "answer",
  model: "claude-sonnet-4-6",
  modelParameters: { temperature: 0.2 },
  input: messages,
});
gen.end({ output: reply, usage: { promptTokens: 320, completionTokens: 24 } });

trace.update({ output: reply });
trace.score({ name: "user-feedback", value: 1, comment: "helpful" });

await mt.shutdown(); // flush before exit
```

The client batches events and flushes on size, on an interval, and at shutdown. Spans
and generations can nest via `span.span({...})`.

## OpenAI wrapper

```ts
import OpenAI from "openai";
import { wrapOpenAI } from "@memoturn/sdk";

const openai = wrapOpenAI(new OpenAI(), mt);
await openai.chat.completions.create({ model: "gpt-4o-mini", messages }); // recorded
```

## LangChain (JS)

```ts
import { MemoturnCallback } from "@memoturn/sdk";

const handler = new MemoturnCallback(mt);
await chain.invoke(input, { callbacks: [handler] });
await handler.flush();
```

## Prompts

```ts
import { getPrompt, compilePrompt } from "@memoturn/sdk";

const prompt = await getPrompt(
  { baseUrl, publicKey, secretKey },
  "support-reply",
  { channel: "production" },
);
const messages = compilePrompt(prompt, { product: "memoturn", question: q });
```

## Datasets / experiments

```ts
import { createDataset, addDatasetItems, getDataset } from "@memoturn/sdk";

await createDataset(creds, "qa-eval");
await addDatasetItems(creds, "qa-eval", [{ input: { q }, expectedOutput: "…" }]);

const ds = await getDataset(creds, "qa-eval");
const links = [];
for (const item of ds.items) {
  const trace = mt.trace({ name: "qa-run", input: item.input });
  // …run your task, end generations…
  links.push({ datasetItemId: item.id, traceId: trace.id });
}
await mt.shutdown();
await ds.recordRun("baseline-v1", links);
```
