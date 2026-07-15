import { describe, expect, it } from "vitest";
import { isFatalConnectionError } from "./client.js";

describe("isFatalConnectionError", () => {
  it("flags dead-connection errors as retryable", () => {
    expect(isFatalConnectionError({ code: "PROTOCOL_CONNECTION_LOST" })).toBe(true);
    expect(isFatalConnectionError({ code: "ECONNRESET" })).toBe(true);
    expect(isFatalConnectionError({ code: "EPIPE" })).toBe(true);
    expect(isFatalConnectionError({ code: "ETIMEDOUT" })).toBe(true);
    expect(isFatalConnectionError({ fatal: true, code: "SOMETHING" })).toBe(true);
    expect(isFatalConnectionError(new Error("Can't add new command when connection is in closed state"))).toBe(true);
  });

  it("does not retry query/logic errors or missing errors", () => {
    // A SQL error must surface, not be silently retried.
    expect(isFatalConnectionError({ code: "ER_PARSE_ERROR", message: "syntax error" })).toBe(false);
    expect(isFatalConnectionError({ code: "ER_BAD_FIELD_ERROR" })).toBe(false);
    expect(isFatalConnectionError(null)).toBe(false);
    expect(isFatalConnectionError(undefined)).toBe(false);
    expect(isFatalConnectionError(new Error("column not found"))).toBe(false);
  });
});
