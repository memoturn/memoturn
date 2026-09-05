import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authSecret, envInt, envSchemaProblems, looksDeployed, validateRuntimeEnv } from "./env.js";

/**
 * Boot-time secret validation. The regression that matters: the ENCRYPTION_KEY placeholder
 * shipped in .env.example must be rejected in production, not just BETTER_AUTH_SECRET's.
 */
describe("validateRuntimeEnv (production)", () => {
  const saved: Record<string, string | undefined> = {};
  const keys = [
    "NODE_ENV",
    "ENCRYPTION_KEY",
    "BETTER_AUTH_SECRET",
    "AUTH_TRUSTED_ORIGINS",
    "ALLOW_PRIVATE_WEBHOOK_TARGETS",
    "ALLOW_PRIVATE_WEBHOOK_TARGETS_ACK",
    "AUTH_RATE_LIMIT_DISABLED",
    "DATABASE_URL",
    "REDIS_URL",
    "BLOB_ENDPOINT",
    "BLOB_ACCESS_KEY_ID",
    "BLOB_SECRET_ACCESS_KEY",
    "AUTH_BASE_URL",
    "DORIS_HOST",
    "TELEMETRY_ENGINE",
    "WORKER_CONCURRENCY",
    "RATE_LIMIT_PER_MINUTE",
  ];

  beforeEach(() => {
    for (const k of keys) saved[k] = process.env[k];
    process.env.NODE_ENV = "production";
    process.env.AUTH_TRUSTED_ORIGINS = "https://console.example.com";
    process.env.BETTER_AUTH_SECRET = "aVLp8x0rSANuT2Zt9m4KqFbYc7Hd3nWj"; // strong, non-placeholder
    process.env.ENCRYPTION_KEY = "u7Qh2Kd91mXcR4bY6nZp0sVtLwEaJ3Fg"; // strong, non-placeholder
    // A complete production datastore + auth configuration.
    process.env.DATABASE_URL = "postgresql://u:p@db:5432/memoturn";
    process.env.REDIS_URL = "redis://redis:6379";
    process.env.BLOB_ENDPOINT = "https://s3.example.com";
    process.env.BLOB_ACCESS_KEY_ID = "AKIA";
    process.env.BLOB_SECRET_ACCESS_KEY = "s3cr3t";
    process.env.AUTH_BASE_URL = "https://memoturn.example.com";
    process.env.DORIS_HOST = "doris-fe";
    delete process.env.TELEMETRY_ENGINE;
    delete process.env.WORKER_CONCURRENCY;
    delete process.env.RATE_LIMIT_PER_MINUTE;
  });

  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("accepts strong secrets", () => {
    expect(() => validateRuntimeEnv("api")).not.toThrow();
  });

  it("refuses the dev .env's ALLOW_PRIVATE_WEBHOOK_TARGETS=1 unless explicitly acknowledged", () => {
    process.env.ALLOW_PRIVATE_WEBHOOK_TARGETS = "1";
    expect(() => validateRuntimeEnv("api")).toThrow(/ALLOW_PRIVATE_WEBHOOK_TARGETS_ACK/);
    process.env.ALLOW_PRIVATE_WEBHOOK_TARGETS_ACK = "1";
    expect(() => validateRuntimeEnv("api")).not.toThrow();
  });

  it("requires the datastore URLs/credentials in production (their code fallbacks are dev-only)", () => {
    delete process.env.REDIS_URL;
    delete process.env.BLOB_SECRET_ACCESS_KEY;
    expect(() => validateRuntimeEnv("api")).toThrow(/REDIS_URL must be set[\s\S]*BLOB_SECRET_ACCESS_KEY must be set/);
  });

  it("requires DORIS_HOST on the Doris engine but not on the Postgres tier", () => {
    delete process.env.DORIS_HOST;
    expect(() => validateRuntimeEnv("worker")).toThrow(/DORIS_HOST/);
    process.env.TELEMETRY_ENGINE = "postgres";
    expect(() => validateRuntimeEnv("worker")).not.toThrow();
  });

  it("rejects malformed numeric/enum/url knobs instead of letting them become NaN", () => {
    process.env.WORKER_CONCURRENCY = "ten";
    process.env.RATE_LIMIT_PER_MINUTE = "1,000";
    process.env.TELEMETRY_ENGINE = "clickhouse";
    process.env.REDIS_URL = "localhost:6379";
    const problems = envSchemaProblems("api", true);
    expect(problems.join("\n")).toMatch(/WORKER_CONCURRENCY="ten" is not an integer/);
    expect(problems.join("\n")).toMatch(/RATE_LIMIT_PER_MINUTE="1,000" is not an integer/);
    expect(problems.join("\n")).toMatch(/TELEMETRY_ENGINE="clickhouse" must be one of/);
    expect(problems.join("\n")).toMatch(/REDIS_URL (is not a valid URL|must use redis:)/);
    expect(() => validateRuntimeEnv("api")).toThrow(/WORKER_CONCURRENCY/);
  });

  it("catches a forgotten NODE_ENV when AUTH_BASE_URL is a public https origin", () => {
    process.env.NODE_ENV = "development";
    expect(looksDeployed()).toBe(true);
    expect(() => validateRuntimeEnv("api")).toThrow(/NODE_ENV is not 'production'/);
    process.env.AUTH_BASE_URL = "http://localhost:3001";
    expect(looksDeployed()).toBe(false);
    expect(() => validateRuntimeEnv("api")).not.toThrow();
  });

  it("authSecret() never returns the dev fallback in production", () => {
    delete process.env.BETTER_AUTH_SECRET;
    expect(() => authSecret()).toThrow(/BETTER_AUTH_SECRET is required/);
    process.env.NODE_ENV = "development";
    expect(authSecret()).toBe("dev-only-change-me");
  });

  it("envInt falls back on malformed values instead of NaN", () => {
    process.env.WORKER_CONCURRENCY = "ten";
    expect(envInt("WORKER_CONCURRENCY", 10)).toBe(10);
    process.env.WORKER_CONCURRENCY = "24";
    expect(envInt("WORKER_CONCURRENCY", 10)).toBe(24);
  });

  it("refuses the test-only AUTH_RATE_LIMIT_DISABLED switch", () => {
    process.env.AUTH_RATE_LIMIT_DISABLED = "true";
    expect(() => validateRuntimeEnv("api")).toThrow(/AUTH_RATE_LIMIT_DISABLED/);
  });

  it("rejects the .env.example ENCRYPTION_KEY placeholder", () => {
    process.env.ENCRYPTION_KEY = "dev-encryption-key-please-change-in-prod-0123456789";
    expect(() => validateRuntimeEnv("api")).toThrow(/ENCRYPTION_KEY/);
  });

  it("rejects the .env.example BETTER_AUTH_SECRET placeholder", () => {
    process.env.BETTER_AUTH_SECRET = "dev-secret-please-change-in-prod-0123456789";
    expect(() => validateRuntimeEnv("api")).toThrow(/BETTER_AUTH_SECRET/);
  });

  it("rejects any value carrying the placeholder marker even if it drifts", () => {
    process.env.ENCRYPTION_KEY = "my-app-please-change-in-prod-value-abcdef";
    expect(() => validateRuntimeEnv("api")).toThrow(/placeholder/);
  });

  it("rejects secrets shorter than the minimum length", () => {
    process.env.ENCRYPTION_KEY = "tooshort";
    expect(() => validateRuntimeEnv("api")).toThrow(/at least/);
  });
});
