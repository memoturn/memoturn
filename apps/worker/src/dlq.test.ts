import { describe, expect, it } from "vitest";
import { shouldDeadLetter } from "./dlq.js";

describe("shouldDeadLetter", () => {
  it("dead-letters once retries are exhausted", () => {
    expect(shouldDeadLetter("telemetry insert failed", 8, 8)).toBe(true);
    expect(shouldDeadLetter("telemetry insert failed", 9, 8)).toBe(true);
  });

  it("does not dead-letter while retries remain", () => {
    expect(shouldDeadLetter("telemetry insert failed", 3, 8)).toBe(false);
  });

  it("dead-letters an unrecoverable failure on the first attempt", () => {
    expect(shouldDeadLetter("unrecoverable: raw batch not found at events/p/2026-09-04/x.json", 1, 8)).toBe(true);
    expect(shouldDeadLetter("Unrecoverable: raw batch is malformed", 0, 8)).toBe(true);
    expect(shouldDeadLetter("insert failed: unrecoverable-looking but not prefixed", 1, 8)).toBe(false);
  });

  it("dead-letters a stalled job even with attempts remaining (the bypass fix)", () => {
    // BullMQ moves a stalled job to `failed` with attemptsMade possibly below `attempts`.
    expect(shouldDeadLetter("job stalled more than allowable limit", 1, 8)).toBe(true);
    expect(shouldDeadLetter("Job stalled more than allowable LIMIT", 0, 8)).toBe(true);
  });
});
