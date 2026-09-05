import { describe, expect, it } from "vitest";
import { recordRequest, renderPrometheus, wantsPrometheus } from "./metrics.js";

describe("Prometheus exposition", () => {
  it("negotiates on Accept or ?format, defaulting to JSON", () => {
    expect(wantsPrometheus(undefined, undefined)).toBe(false);
    expect(wantsPrometheus("application/json", undefined)).toBe(false);
    expect(wantsPrometheus("text/plain;version=0.0.4;q=0.5,*/*;q=0.1", undefined)).toBe(true);
    expect(wantsPrometheus("application/openmetrics-text;version=1.0.0", undefined)).toBe(true);
    expect(wantsPrometheus(undefined, "prometheus")).toBe(true);
    expect(wantsPrometheus("text/plain", "json")).toBe(false);
  });

  it("escapes label values so a route pattern with quotes can't break the exposition", () => {
    recordRequest("GET", '/v1/odd"route', 200, 12);
    const text = renderPrometheus();
    expect(text).toContain('route="/v1/odd\\"route"');
    // Every sample line is `name{labels} value` or `name value`, and TYPE precedes samples.
    for (const line of text.trim().split("\n")) {
      if (line.startsWith("#")) continue;
      expect(line).toMatch(/^[a-z_]+(\{[^}]*\})? -?\d+(\.\d+)?$/);
    }
    expect(text.indexOf("# TYPE memoturn_api_route_requests_total")).toBeLessThan(
      text.indexOf("memoturn_api_route_requests_total{"),
    );
  });
});
