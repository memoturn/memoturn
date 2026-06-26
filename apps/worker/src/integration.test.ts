import { putRawBatch } from "@memoturn/db/blob";
import { clickhouse } from "@memoturn/db/clickhouse";
import type { IngestJob } from "@memoturn/db/queue";
import { getTrace } from "@memoturn/server";
import type { Job } from "bullmq";
import { afterAll, describe, expect, it } from "vitest";
import { processIngest } from "./processors/ingest.js";

/**
 * End-to-end pipeline test (blob → worker → ClickHouse → read), run in-process: writes
 * the raw batch to blob exactly as the API does, invokes the real worker processor, then
 * reads the assembled trace back. Skipped unless the datastores are configured (so the
 * default `bun run test` stays infra-free); CI sets the env + service containers.
 */
const HAS_INFRA = Boolean(process.env.DATABASE_URL && process.env.CLICKHOUSE_URL && process.env.BLOB_ENDPOINT);

const iso = (d = new Date()) => d.toISOString();
const newId = () => `it-${Math.random().toString(36).slice(2)}-${Date.now()}`;

async function getTraceWithRetry(projectId: string, traceId: string, tries = 10) {
  for (let i = 0; i < tries; i++) {
    const t = await getTrace(projectId, traceId);
    if (t) return t;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

describe.skipIf(!HAS_INFRA)("ingest pipeline (blob → worker → ClickHouse → read)", () => {
  const projectId = `itest-${Date.now()}`;

  afterAll(async () => {
    const ch = clickhouse();
    for (const table of ["traces", "observations", "scores"]) {
      await ch
        .command({ query: `DELETE FROM ${table} WHERE project_id = {p:String}`, query_params: { p: projectId } })
        .catch(() => {});
    }
  });

  it("ingests a trace + generation + score and reads them back assembled", async () => {
    const traceId = newId();
    const obsId = newId();
    const ts = iso();
    const batch = {
      batch: [
        { id: newId(), type: "trace-create", timestamp: ts, body: { id: traceId, name: "itest", input: { q: "hi" } } },
        {
          id: newId(),
          type: "generation-create",
          timestamp: ts,
          body: {
            id: obsId,
            traceId,
            name: "gen",
            model: "gpt-4o-mini",
            startTime: ts,
            endTime: ts,
            usage: { promptTokens: 1000, completionTokens: 1000 },
            output: "pong",
          },
        },
        {
          id: newId(),
          type: "score-create",
          timestamp: ts,
          body: { id: newId(), traceId, name: "quality", value: 0.8, source: "API" },
        },
      ],
    };

    // Write the raw batch to blob exactly as the API does, then run the real processor.
    const batchId = newId();
    const blobKey = await putRawBatch(projectId, batchId, batch);
    await processIngest({ data: { projectId, batchId, blobKey } } as Job<IngestJob>);

    const trace = await getTraceWithRetry(projectId, traceId);
    expect(trace, "trace assembled from ClickHouse").toBeTruthy();
    if (!trace) return;

    expect(trace.name).toBe("itest");
    expect(trace.observations).toHaveLength(1);
    const obs = trace.observations[0];
    expect(obs?.model).toBe("gpt-4o-mini");
    expect(Number(obs?.total_tokens)).toBe(2000);
    // gpt-4o-mini is in the cost registry → non-zero cost computed by the mapper.
    expect(Number(trace.total_cost)).toBeGreaterThan(0);
    expect(trace.scores).toHaveLength(1);
    expect(trace.scores[0]?.name).toBe("quality");
    expect(trace.scores[0]?.value).toBe(0.8);
  });
});
