import { describe, expect, it } from "vitest";
import { clampExportLimit, MAX_EXPORT_ROWS } from "./export.js";

describe("clampExportLimit", () => {
  it("passes through an in-range limit", () => {
    expect(clampExportLimit(500)).toBe(500);
    expect(clampExportLimit("2500")).toBe(2500);
  });

  it("caps at the hard ceiling (the OOM guard)", () => {
    expect(clampExportLimit(100_000_000)).toBe(MAX_EXPORT_ROWS);
    expect(clampExportLimit(String(MAX_EXPORT_ROWS + 1))).toBe(MAX_EXPORT_ROWS);
  });

  it("defaults NaN / absent / non-positive to 1000", () => {
    expect(clampExportLimit("abc")).toBe(1000);
    expect(clampExportLimit(null)).toBe(1000);
    expect(clampExportLimit(undefined)).toBe(1000);
    expect(clampExportLimit(0)).toBe(1000);
    expect(clampExportLimit(-5)).toBe(1000);
  });
});
