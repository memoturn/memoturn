import { afterEach, describe, expect, it } from "vitest";
import { Memoturn } from "./client.js";
import { configure, getClient, observe } from "./observe.js";
import { mockFetch } from "./test-helpers.js";
import type { IngestEnvelope } from "./types.js";

const creds = { baseUrl: "http://api.test", publicKey: "pk-mt-x", secretKey: "sk-mt-y", flushAt: 1000 };

let active: ReturnType<typeof mockFetch> | undefined;
afterEach(() => {
  active?.restore();
  active = undefined;
});

function setup() {
  active = mockFetch(() => ({ status: 207 }));
  const client = configure(new Memoturn(creds));
  return { client };
}

function batchFrom(m: ReturnType<typeof mockFetch>): IngestEnvelope[] {
  return (m.calls[0].body as { batch: IngestEnvelope[] }).batch;
}

describe("observe", () => {
  it("configure() sets the client returned by getClient()", () => {
    const { client } = setup();
    expect(getClient()).toBe(client);
  });

  it("root call opens a trace + root span; nested observed calls become child spans", async () => {
    const { client } = setup();
    const inner = observe(async (x: number) => x * 2, { name: "inner" });
    const outer = observe(
      async function outer(x: number) {
        return (await inner(x)) + 1;
      },
      { name: "outer" },
    );

    expect(await outer(3)).toBe(7);
    await client.flush();

    const batch = batchFrom(active!);
    const traces = batch.filter((e) => e.type === "trace-create");
    const spans = batch.filter((e) => e.type === "span-create");
    expect(traces[0]?.body).toMatchObject({ name: "outer", input: { args: [3] } });
    expect(spans).toHaveLength(2);

    const outerSpan = spans.find((e) => e.body.name === "outer");
    const innerSpan = spans.find((e) => e.body.name === "inner");
    expect(outerSpan?.body.parentObservationId).toBeUndefined();
    expect(innerSpan?.body).toMatchObject({
      traceId: traces[0]?.body.id,
      parentObservationId: outerSpan?.body.id,
      input: { args: [3] },
    });

    // Both spans end with their outputs; the root also updates the trace output.
    const updates = batch.filter((e) => e.type === "span-update");
    expect(updates.find((e) => e.body.id === innerSpan?.body.id)?.body.output).toBe(6);
    expect(updates.find((e) => e.body.id === outerSpan?.body.id)?.body.output).toBe(7);
    const traceUpdate = batch.filter((e) => e.type === "trace-create").at(-1);
    expect(traceUpdate?.body.output).toBe(7);
  });

  it("asType: 'generation' records a generation instead of a span", async () => {
    const { client } = setup();
    const llm = observe(async (prompt: string) => `echo: ${prompt}`, { name: "llm", asType: "generation" });

    await llm("hi");
    await client.flush();

    const batch = batchFrom(active!);
    expect(batch.find((e) => e.type === "generation-create")?.body.name).toBe("llm");
    expect(batch.find((e) => e.type === "generation-update")?.body.output).toBe("echo: hi");
  });

  it("supports sync functions (returns the plain value, not a promise)", async () => {
    const { client } = setup();
    const add = observe(function add(a: number, b: number) {
      return a + b;
    });

    const result = add(1, 2);
    expect(result).toBe(3); // not a thenable
    await client.flush();

    const batch = batchFrom(active!);
    expect(batch.find((e) => e.type === "trace-create")?.body.name).toBe("add"); // fn.name fallback
    expect(batch.find((e) => e.type === "span-update")?.body.output).toBe(3);
  });

  it("records ERROR + statusMessage and rethrows on failure", async () => {
    const { client } = setup();
    const boom = observe(async () => {
      throw new Error("kaput");
    });

    await expect(boom()).rejects.toThrow("kaput");
    await client.flush();

    const update = batchFrom(active!).find((e) => e.type === "span-update");
    expect(update?.body.level).toBe("ERROR");
    expect(String(update?.body.statusMessage)).toContain("kaput");
  });

  it("sibling calls after a nested call still nest under the root, not the sibling", async () => {
    const { client } = setup();
    const stepA = observe(async () => "a", { name: "stepA" });
    const stepB = observe(async () => "b", { name: "stepB" });
    const root = observe(
      async () => {
        await stepA();
        await stepB();
        return "done";
      },
      { name: "root" },
    );

    await root();
    await client.flush();

    const batch = batchFrom(active!);
    const rootSpan = batch.find((e) => e.type === "span-create" && e.body.name === "root");
    const b = batch.find((e) => e.type === "span-create" && e.body.name === "stepB");
    expect(b?.body.parentObservationId).toBe(rootSpan?.body.id);
  });
});
