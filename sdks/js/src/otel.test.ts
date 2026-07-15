import { describe, expect, it } from "vitest";
import { memoturnOtlpConfig, memoturnTraceExporter } from "./otel.js";
import { decodeBasic } from "./test-helpers.js";

describe("memoturnOtlpConfig", () => {
  it("builds the OTLP traces URL + Basic auth header from creds", () => {
    const cfg = memoturnOtlpConfig({ baseUrl: "http://api.test", publicKey: "pk-mt-x", secretKey: "sk-mt-y" });
    expect(cfg.url).toBe("http://api.test/v1/otel/v1/traces");
    expect(decodeBasic(cfg.headers.Authorization)).toBe("pk-mt-x:sk-mt-y");
  });

  it("strips a trailing slash from baseUrl", () => {
    const cfg = memoturnOtlpConfig({ baseUrl: "http://api.test/", publicKey: "p", secretKey: "s" });
    expect(cfg.url).toBe("http://api.test/v1/otel/v1/traces");
  });

  it("merges extra headers alongside auth", () => {
    const cfg = memoturnOtlpConfig({ baseUrl: "http://api.test", headers: { "x-proxy": "1" } });
    expect(cfg.headers["x-proxy"]).toBe("1");
    expect(cfg.headers.Authorization).toMatch(/^Basic /);
  });

  it("falls back to MEMOTURN_* env vars", () => {
    const prev = { ...process.env };
    process.env.MEMOTURN_BASE_URL = "http://env.test";
    process.env.MEMOTURN_PUBLIC_KEY = "pk-env";
    process.env.MEMOTURN_SECRET_KEY = "sk-env";
    try {
      const cfg = memoturnOtlpConfig();
      expect(cfg.url).toBe("http://env.test/v1/otel/v1/traces");
      expect(decodeBasic(cfg.headers.Authorization)).toBe("pk-env:sk-env");
    } finally {
      process.env = prev;
    }
  });
});

describe("memoturnTraceExporter", () => {
  it("throws a helpful error when the OTLP exporter peer dep is missing", () => {
    // @opentelemetry/exporter-trace-otlp-http is an optional peer dep, not installed here.
    expect(() => memoturnTraceExporter({ baseUrl: "http://api.test" })).toThrow(
      /@opentelemetry\/exporter-trace-otlp-http/,
    );
  });
});
