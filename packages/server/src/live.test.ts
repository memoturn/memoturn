import { beforeEach, describe, expect, it, vi } from "vitest";

// A minimal fake ioredis: a command connection with publish/duplicate, and duplicated
// subscriber connections that capture handlers so tests can emit messages.
type Handler = (channel: string, message: string) => void;
class FakeRedis {
  publish = vi.fn().mockResolvedValue(1);
  subscribe = vi.fn().mockResolvedValue(undefined);
  unsubscribe = vi.fn().mockResolvedValue(undefined);
  quit = vi.fn().mockResolvedValue("OK");
  handlers: Handler[] = [];
  on(_event: "message", h: Handler) {
    this.handlers.push(h);
    return this;
  }
  off(_event: "message", h: Handler) {
    this.handlers = this.handlers.filter((x) => x !== h);
    return this;
  }
  duplicate() {
    const sub = new FakeRedis();
    duplicated.push(sub);
    return sub;
  }
  emit(channel: string, message: string) {
    for (const h of this.handlers) h(channel, message);
  }
}

let root: FakeRedis;
const duplicated: FakeRedis[] = [];
vi.mock("@memoturn/db/queue", () => ({ redisConnection: () => root }));

const { publishLiveTraces, subscribeLiveTraces } = await import("./live.js");

const trace = (id: string) => ({
  id,
  name: `t-${id}`,
  timestamp: "2026-07-24T00:00:00Z",
  environment: "prod",
  sessionId: "s1",
});

describe("publishLiveTraces", () => {
  beforeEach(() => {
    root = new FakeRedis();
    duplicated.length = 0;
  });

  it("publishes one message per trace to the project channel", async () => {
    await publishLiveTraces("p1", [trace("a"), trace("b")]);
    expect(root.publish).toHaveBeenCalledTimes(2);
    expect(root.publish).toHaveBeenCalledWith("memoturn:live:p1", JSON.stringify(trace("a")));
  });

  it("does nothing for an empty batch", async () => {
    await publishLiveTraces("p1", []);
    expect(root.publish).not.toHaveBeenCalled();
  });

  it("swallows publish errors (best-effort — never fails ingestion)", async () => {
    root.publish.mockRejectedValue(new Error("redis down"));
    await expect(publishLiveTraces("p1", [trace("a")])).resolves.toBeUndefined();
  });
});

describe("subscribeLiveTraces", () => {
  beforeEach(() => {
    root = new FakeRedis();
    duplicated.length = 0;
  });

  it("delivers parsed events on the project channel, ignores others, and cleans up", async () => {
    const seen: string[] = [];
    const cleanup = subscribeLiveTraces("p1", (e) => seen.push(e.id));
    const sub = duplicated[0]!;
    expect(sub.subscribe).toHaveBeenCalledWith("memoturn:live:p1");

    sub.emit("memoturn:live:p1", JSON.stringify(trace("a")));
    sub.emit("memoturn:live:other", JSON.stringify(trace("b"))); // wrong channel → ignored
    sub.emit("memoturn:live:p1", "not json"); // malformed → dropped, no throw
    expect(seen).toEqual(["a"]);

    await cleanup();
    expect(sub.unsubscribe).toHaveBeenCalledWith("memoturn:live:p1");
    expect(sub.quit).toHaveBeenCalled();
    expect(sub.handlers).toHaveLength(0);
  });
});
