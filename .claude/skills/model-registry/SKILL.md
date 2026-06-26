---
name: model-registry
description: How to add or update a model and its pricing in memoturn — the built-in cost registry in packages/core/src/models.ts (USD per 1M tokens, first-match-wins regex ordering) and per-project overrides. Use when a new LLM ships, costs change, or traces show $0 cost for a known model.
---

# Model + pricing registry

memoturn computes `input_cost` / `output_cost` / `total_cost` for every generation from a price registry. Prices are **USD per 1,000,000 tokens**.

## Add / update a built-in model

Edit `MODEL_PRICES` in `packages/core/src/models.ts`. Each entry:

```ts
{ match: /^claude-sonnet-4/i, provider: "anthropic", inputPerMTok: 3, outputPerMTok: 15 },
```

- `match` is a **regex** against the model id; `computeCost` / `providerForModel` use **first match wins**.
- **Order matters** — put more specific patterns *before* general ones, or the general one shadows them. The file already does this: `gpt-4o-mini` before `gpt-4o`, `claude-haiku-4` before broader claude patterns. A new variant usually belongs above its family's catch-all.
- `inputPerMTok` / `outputPerMTok` are per-1M-token USD; `provider` is the gateway name (`anthropic` / `openai`).

## Per-project overrides (no code change)

Projects can override pricing at runtime via `POST /v1/model-prices` (stored in Postgres as `ModelPriceOverride { pattern, provider?, inputPerMTok, outputPerMTok }`, compiled with `compileModelPrices`). Overrides take precedence over the built-ins (first match wins, overrides first — see `priceTable`). Use built-ins for defaults that ship with memoturn; use overrides for customer-specific or private-model pricing.

## Gotchas

- **`$0` cost for a known model** almost always means no `match` hit — check the regex and ordering.
- Cost math is **tested**: `mapEvents` cost assertions live in `apps/worker/src/mappers.test.ts` (e.g. a `claude-sonnet-4-6` generation → expected `total_cost`). Update/extend that test when you change a price, and run `bun --filter @memoturn/worker test` + `bun --filter @memoturn/core test`.
- When you add a Claude model, confirm the exact model id and pricing against the **claude-api** skill rather than guessing.

## Verify

`bun --filter @memoturn/core test`, `bun --filter @memoturn/worker test`, `bun run typecheck`.
