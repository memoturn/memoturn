import { prisma } from "@memoturn/db";
import { putRawBatch } from "@memoturn/db/blob";
import type { IngestJob } from "@memoturn/db/queue";
import { getTrace } from "@memoturn/server";
import { telemetry } from "@memoturn/telemetry";
import type { Job } from "bullmq";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { processIngest } from "./processors/ingest.js";

/**
 * End-to-end pipeline test (blob → worker → telemetry store → read), run in-process:
 * writes the raw batch to blob exactly as the API does, invokes the real worker
 * processor, then reads the assembled trace back. Skipped unless the datastores are
 * configured (so the default `bun run test` stays infra-free); CI sets the env +
 * service containers.
 */
const HAS_INFRA = Boolean(process.env.DATABASE_URL && process.env.DORIS_HOST && process.env.BLOB_ENDPOINT);

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

describe.skipIf(!HAS_INFRA)("ingest pipeline (blob → worker → telemetry store → read)", () => {
  const projectId = `itest-${Date.now()}`;
  const orgId = `${projectId}-org`;

  // The processor persists mutable state to Postgres (*State rows FK onto Project),
  // so the project must actually exist relationally, not just as an id.
  beforeAll(async () => {
    await prisma.organization.create({
      data: {
        id: orgId,
        name: "itest org",
        slug: orgId,
        projects: { create: { id: projectId, name: "itest", slug: projectId } },
      },
    });
  });

  afterAll(async () => {
    await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
    await telemetry()
      .deleteProjectData(projectId)
      .catch(() => {});
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
    expect(trace, "trace assembled from the telemetry store").toBeTruthy();
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

  it("preserves create-time fields when the update arrives in a LATER batch (read-merge)", async () => {
    const traceId = newId();
    const obsId = newId();
    const t0 = iso(new Date(Date.now() - 5000));

    // Batch 1: create with full state, still open (no endTime/usage/output).
    const blobKey1 = await putRawBatch(projectId, newId(), {
      batch: [
        { id: newId(), type: "trace-create", timestamp: t0, body: { id: traceId, name: "rm-trace", userId: "u-rm" } },
        {
          id: newId(),
          type: "generation-create",
          timestamp: t0,
          body: { id: obsId, traceId, name: "rm-gen", model: "gpt-4o-mini", startTime: t0 },
        },
      ],
    });
    await processIngest({ data: { projectId, batchId: newId(), blobKey: blobKey1 } } as Job<IngestJob>);
    await getTraceWithRetry(projectId, traceId); // wait until batch 1 is queryable

    // Batch 2: partial updates only — output for the trace, end/usage for the generation.
    const t1 = iso();
    const blobKey2 = await putRawBatch(projectId, newId(), {
      batch: [
        { id: newId(), type: "trace-create", timestamp: t1, body: { id: traceId, output: "late-answer" } },
        {
          id: newId(),
          type: "generation-update",
          timestamp: t1,
          body: { id: obsId, traceId, endTime: t1, output: "pong", usage: { promptTokens: 10, completionTokens: 20 } },
        },
      ],
    });
    await processIngest({ data: { projectId, batchId: newId(), blobKey: blobKey2 } } as Job<IngestJob>);

    // The merged view must have batch-1 fields AND batch-2 fields.
    let trace = await getTraceWithRetry(projectId, traceId);
    for (let i = 0; i < 10 && trace && trace.output !== "late-answer"; i++) {
      await new Promise((r) => setTimeout(r, 300));
      trace = await getTraceWithRetry(projectId, traceId);
    }
    expect(trace).toBeTruthy();
    if (!trace) return;
    expect(trace.name).toBe("rm-trace"); // from batch 1
    expect(trace.user_id).toBe("u-rm"); // from batch 1
    expect(trace.output).toBe("late-answer"); // from batch 2
    const obs = trace.observations[0];
    expect(obs?.name).toBe("rm-gen"); // from batch 1
    expect(obs?.model).toBe("gpt-4o-mini"); // from batch 1
    expect(Number(obs?.total_tokens)).toBe(30); // from batch 2
    expect(obs?.end_time).toBeTruthy(); // from batch 2
    expect(Number(obs?.latency_ms)).toBeGreaterThan(0); // spans both batches
  });

  it("merges same-batch create+update without a stored base (create-only gate)", async () => {
    const traceId = newId();
    const obsId = newId();
    const t0 = iso(new Date(Date.now() - 2000));
    const t1 = iso();

    // Create and update in the SAME batch: the processor's read-merge gate skips the
    // observations base SELECT here (nothing is stored yet), and the mapper's body
    // accumulation alone must produce the merged row.
    const blobKey = await putRawBatch(projectId, newId(), {
      batch: [
        { id: newId(), type: "trace-create", timestamp: t0, body: { id: traceId, name: "sb-trace" } },
        {
          id: newId(),
          type: "generation-create",
          timestamp: t0,
          body: { id: obsId, traceId, name: "sb-gen", model: "gpt-4o-mini", startTime: t0 },
        },
        {
          id: newId(),
          type: "generation-update",
          timestamp: t1,
          body: { id: obsId, traceId, endTime: t1, output: "pong", usage: { promptTokens: 5, completionTokens: 5 } },
        },
      ],
    });
    await processIngest({ data: { projectId, batchId: newId(), blobKey } } as Job<IngestJob>);

    const trace = await getTraceWithRetry(projectId, traceId);
    expect(trace).toBeTruthy();
    if (!trace) return;
    const obs = trace.observations[0];
    expect(obs?.name).toBe("sb-gen"); // from the create
    expect(obs?.model).toBe("gpt-4o-mini"); // from the create
    expect(Number(obs?.total_tokens)).toBe(10); // from the update
    expect(obs?.end_time).toBeTruthy(); // from the update
  });
});
