// k6 ingest load harness — sustained POST /v1/ingest at a target event rate.
//
//   k6 run -e BASE_URL=http://localhost:3001 -e PK=pk-mt-dev -e SK=sk-mt-dev \
//          -e EVENTS_PER_SEC=500 -e DURATION=2m scripts/load/ingest.k6.js
//
// Each iteration posts one batch of BATCH_EVENTS events (a trace + spans + a generation +
// a score) — realistic shape, ~1.5 KB/event. Thresholds fail the run when the API's p95
// exceeds 500 ms or more than 1% of batches are rejected/5xx. Watch the worker's
// /metrics (queue depth, insert latency) alongside: the API acking fast while the queue
// grows unbounded is the other failure mode this exists to expose.

import { check } from "k6";
import http from "k6/http";
import { Trend } from "k6/metrics";

const BASE_URL = __ENV.BASE_URL || "http://localhost:3001";
const AUTH = `Basic ${encoding.b64encode(`${__ENV.PK || "pk-mt-dev"}:${__ENV.SK || "sk-mt-dev"}`)}`;
const BATCH_EVENTS = Number(__ENV.BATCH_EVENTS || 20);
const EVENTS_PER_SEC = Number(__ENV.EVENTS_PER_SEC || 200);
const DURATION = __ENV.DURATION || "1m";

const ackMs = new Trend("ingest_ack_ms", true);

export const options = {
  scenarios: {
    ingest: {
      executor: "constant-arrival-rate",
      rate: Math.max(1, Math.round(EVENTS_PER_SEC / BATCH_EVENTS)),
      timeUnit: "1s",
      duration: DURATION,
      preAllocatedVUs: 20,
      maxVUs: 200,
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    ingest_ack_ms: ["p(95)<500"],
  },
};

function uuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function batch() {
  const now = new Date().toISOString();
  const traceId = uuid();
  const events = [
    {
      id: uuid(),
      type: "trace-create",
      timestamp: now,
      body: {
        id: traceId,
        name: "load",
        userId: `u${__VU}`,
        sessionId: `s${__ITER % 50}`,
        input: "question ".repeat(40),
      },
    },
  ];
  for (let i = 1; i < BATCH_EVENTS; i++) {
    const obs = uuid();
    const kind = i % 4 === 0 ? "generation" : "span";
    events.push({
      id: uuid(),
      type: `${kind}-create`,
      timestamp: now,
      body: {
        id: obs,
        traceId,
        name: `${kind}-${i}`,
        model: kind === "generation" ? "gpt-4o-mini" : undefined,
        startTime: now,
        input: "x".repeat(600),
      },
    });
    events.push({
      id: uuid(),
      type: `${kind}-update`,
      timestamp: now,
      body: {
        id: obs,
        traceId,
        endTime: now,
        output: "y".repeat(600),
        usage: kind === "generation" ? { promptTokens: 120, completionTokens: 80 } : undefined,
      },
    });
  }
  events.push({
    id: uuid(),
    type: "score-create",
    timestamp: now,
    body: { id: uuid(), traceId, name: "quality", value: Math.random() },
  });
  return events.slice(0, BATCH_EVENTS);
}

export default function () {
  const res = http.post(`${BASE_URL}/v1/ingest`, JSON.stringify({ batch: batch() }), {
    headers: { "content-type": "application/json", authorization: AUTH },
    tags: { name: "POST /v1/ingest" },
  });
  ackMs.add(res.timings.duration);
  check(res, {
    "207 accepted": (r) => r.status === 207,
    "no per-event errors": (r) => r.status === 207 && (r.json("errors") || []).length === 0,
  });
}
