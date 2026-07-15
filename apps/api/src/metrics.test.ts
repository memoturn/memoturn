import { describe, expect, it } from "vitest";
import { recordRequest, requestStarted, snapshot } from "./metrics.js";

describe("api metrics", () => {
  it("aggregates by route pattern, tracks status classes, in-flight, and percentiles", () => {
    // Two in-flight, one still open at snapshot time.
    requestStarted();
    requestStarted();
    recordRequest("GET", "/v1/traces/:id", 200, 10);
    recordRequest("GET", "/v1/traces/:id", 200, 30);
    recordRequest("POST", "/v1/experiments", 201, 5);
    recordRequest("GET", "/v1/traces/:id", 500, 100);
    recordRequest("GET", "/v1/datasets", 401, 2);
    // one request still open (requestStarted called twice, recordRequest five times → net -3,
    // clamped at >= 0)

    const snap = snapshot() as {
      requestsTotal: number;
      inFlight: number;
      statusClasses: Record<string, number>;
      routes: { route: string; count: number; errors: number; p50Ms: number; p95Ms: number; maxMs: number }[];
    };

    expect(snap.requestsTotal).toBeGreaterThanOrEqual(5);
    expect(snap.statusClasses["2xx"]).toBeGreaterThanOrEqual(3);
    expect(snap.statusClasses["4xx"]).toBeGreaterThanOrEqual(1);
    expect(snap.statusClasses["5xx"]).toBeGreaterThanOrEqual(1);

    const traces = snap.routes.find((r) => r.route === "GET /v1/traces/:id");
    expect(traces).toBeDefined();
    // Three calls collapsed into one pattern bucket (not exploded by id).
    expect(traces!.count).toBe(3);
    expect(traces!.errors).toBe(1); // the 500
    expect(traces!.maxMs).toBe(100);
    expect(traces!.p50Ms).toBeGreaterThan(0);
    expect(traces!.p95Ms).toBeGreaterThanOrEqual(traces!.p50Ms);
  });
});
