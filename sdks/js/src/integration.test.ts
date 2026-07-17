// Env-gated integration suite — exercises the SDK against a real running API (no mockFetch).
// Skipped unless MEMOTURN_INTEGRATION=1. Defaults match `bun run setup` dev credentials:
//
//   MEMOTURN_INTEGRATION=1 bunx vitest run integration
//
// Override with MEMOTURN_BASE_URL / MEMOTURN_PUBLIC_KEY / MEMOTURN_SECRET_KEY.

import { describe, expect, it } from "vitest";
import { Memoturn } from "./client.js";
import { addDatasetItems, createDataset, getDataset } from "./dataset.js";
import { checkGuardrails } from "./guardrails.js";

const RUN = process.env.MEMOTURN_INTEGRATION === "1";

const baseUrl = process.env.MEMOTURN_BASE_URL ?? "http://localhost:3001";
const publicKey = process.env.MEMOTURN_PUBLIC_KEY ?? "pk-mt-dev";
const secretKey = process.env.MEMOTURN_SECRET_KEY ?? "sk-mt-dev";
const creds = { baseUrl, publicKey, secretKey };

describe.skipIf(!RUN)("integration (MEMOTURN_INTEGRATION=1, real API)", () => {
  it("ingest round-trip: trace + generation with cache-token usage + score flush cleanly", async () => {
    const client = new Memoturn({ ...creds, allowInsecureHttp: true, flushOnExit: false });
    const trace = client.trace({
      name: `it-ingest-${crypto.randomUUID()}`,
      userId: "integration-suite",
      tags: ["integration"],
    });
    const gen = trace.generation({
      name: "answer",
      model: "gpt-4o",
      provider: "openai",
      input: [{ role: "user", content: "2+2?" }],
    });
    gen.end({
      output: { role: "assistant", content: "4" },
      usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11, cacheReadTokens: 4, cacheCreationTokens: 2 },
    });
    trace.score({ name: "quality", value: 1, dataType: "NUMERIC" });

    await expect(client.shutdown()).resolves.toBeUndefined(); // flush rejects on any transport/schema failure
  });

  it("dataset lifecycle: create, add 2 items, fetch them back, record a run", async () => {
    const name = `it-ds-${crypto.randomUUID()}`;
    await createDataset(creds, name, "SDK integration suite");

    const added = await addDatasetItems(creds, name, [
      { input: "2+2?", expectedOutput: "4" },
      { input: "3+3?", expectedOutput: "6", metadata: { difficulty: "easy" } },
    ]);
    expect(added.added).toBe(2);
    expect(added.itemIds).toHaveLength(2);

    const ds = await getDataset(creds, name);
    expect(ds.name).toBe(name);
    expect(ds.items).toHaveLength(2);

    const run = await ds.recordRun(`run-${crypto.randomUUID()}`, [
      { datasetItemId: ds.items[0].id, traceId: crypto.randomUUID() },
    ]);
    expect(run.linked).toBe(1);
  });

  it("checkGuardrails returns a verdict in {allow, redact, block}", async () => {
    const verdict = await checkGuardrails(creds, "hello, please summarize this ticket");
    expect(["allow", "redact", "block"]).toContain(verdict.verdict);
    expect(Array.isArray(verdict.findings)).toBe(true);
  });

  it("wrong keys are a permanent reject: flush() throws and does not re-buffer", async () => {
    const bad = new Memoturn({
      baseUrl,
      publicKey: `pk-mt-wrong-${crypto.randomUUID()}`,
      secretKey: "sk-mt-wrong",
      allowInsecureHttp: true,
      flushOnExit: false,
    });
    bad.trace({ name: `it-auth-${crypto.randomUUID()}` });
    await expect(bad.flush()).rejects.toThrow(/memoturn ingest rejected: 4\d\d/);
    await expect(bad.flush()).resolves.toBeUndefined(); // batch dropped, nothing left to send
  });
});
