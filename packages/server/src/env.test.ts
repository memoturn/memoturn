import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateRuntimeEnv } from "./env.js";

/**
 * Boot-time secret validation. The regression that matters: the ENCRYPTION_KEY placeholder
 * shipped in .env.example must be rejected in production, not just BETTER_AUTH_SECRET's.
 */
describe("validateRuntimeEnv (production)", () => {
  const saved: Record<string, string | undefined> = {};
  const keys = ["NODE_ENV", "ENCRYPTION_KEY", "BETTER_AUTH_SECRET", "AUTH_TRUSTED_ORIGINS"];

  beforeEach(() => {
    for (const k of keys) saved[k] = process.env[k];
    process.env.NODE_ENV = "production";
    process.env.AUTH_TRUSTED_ORIGINS = "https://console.example.com";
    process.env.BETTER_AUTH_SECRET = "aVLp8x0rSANuT2Zt9m4KqFbYc7Hd3nWj"; // strong, non-placeholder
    process.env.ENCRYPTION_KEY = "u7Qh2Kd91mXcR4bY6nZp0sVtLwEaJ3Fg"; // strong, non-placeholder
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
