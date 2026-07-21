import type { IngestEvent } from "@memoturn/core";
import { describe, expect, it } from "vitest";
import { entityLockNames } from "./entitylock.js";

const ev = (type: string, id?: string): IngestEvent =>
  ({ type, timestamp: "2026-07-21T00:00:00Z", body: id === undefined ? {} : { id } }) as unknown as IngestEvent;

describe("entityLockNames", () => {
  it("locks every trace + observation id, project-scoped and deduped", () => {
    const names = entityLockNames("p1", [
      ev("trace-create", "t1"),
      ev("trace-create", "t1"), // duplicate id collapses
      ev("span-create", "o1"),
      ev("generation-update", "o2"),
      ev("event-create", "o3"),
    ]);
    expect(new Set(names)).toEqual(new Set(["p1:t:t1", "p1:o:o1", "p1:o:o2", "p1:o:o3"]));
  });

  it("locks a CREATED observation too, not only updates (the create/update race)", () => {
    expect(entityLockNames("p1", [ev("span-create", "o1")])).toEqual(["p1:o:o1"]);
  });

  it("ignores append-only/other events and events with no id", () => {
    expect(entityLockNames("p1", [ev("score-create", "s1"), ev("trace-create", undefined)])).toEqual([]);
  });

  it("scopes names by project so ids can't collide across tenants", () => {
    expect(entityLockNames("pA", [ev("trace-create", "x")])).toEqual(["pA:t:x"]);
    expect(entityLockNames("pB", [ev("trace-create", "x")])).toEqual(["pB:t:x"]);
  });
});
