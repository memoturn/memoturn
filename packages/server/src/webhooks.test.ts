import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
const update = vi.fn().mockResolvedValue({});
const deliveryCreate = vi.fn().mockResolvedValue({});
vi.mock("@memoturn/db", () => ({
  prisma: { webhook: { findMany, update }, webhookDelivery: { create: deliveryCreate } },
}));

const { dispatchWebhooksBatch, signWebhook } = await import("./webhooks.js");

describe("signWebhook", () => {
  it("is a stable HMAC over timestamp.body", () => {
    const a = signWebhook("sec", "123", "{}");
    expect(a).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(signWebhook("sec", "123", "{}")).toBe(a);
    expect(signWebhook("other", "123", "{}")).not.toBe(a);
  });
});

describe("dispatchWebhooksBatch", () => {
  const origEnv = process.env.ALLOW_PRIVATE_WEBHOOK_TARGETS;
  const fetchMock = vi.fn();

  beforeEach(() => {
    // Permit the fake localhost targets without DNS resolution.
    process.env.ALLOW_PRIVATE_WEBHOOK_TARGETS = "1";
    findMany.mockReset();
    update.mockClear();
    deliveryCreate.mockClear();
    fetchMock.mockReset().mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (origEnv === undefined) delete process.env.ALLOW_PRIVATE_WEBHOOK_TARGETS;
    else process.env.ALLOW_PRIVATE_WEBHOOK_TARGETS = origEnv;
  });

  const hook = (over: Record<string, unknown> = {}) => ({
    id: "wh1",
    url: "http://localhost:9/hook",
    threshold: null,
    secret: "whsec_x",
    ...over,
  });

  const score = (value: number | null) => ({ traceId: "t1", name: "quality", value, source: "API" });

  it("does ONE config lookup for the whole batch and delivers each payload", async () => {
    findMany.mockResolvedValue([hook()]);
    const fired = await dispatchWebhooksBatch("p1", "score.created", [score(0.1), score(0.2), score(0.3)]);
    expect(fired).toBe(3);
    expect(findMany).toHaveBeenCalledTimes(1); // the old per-payload path called this 3×
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("applies the threshold filter per payload", async () => {
    findMany.mockResolvedValue([hook({ threshold: 0.5 })]);
    const fired = await dispatchWebhooksBatch("p1", "score.created", [score(0.1), score(0.9), score(null)]);
    expect(fired).toBe(1); // only the below-threshold score fires
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns 0 without fetching when no hooks or no payloads", async () => {
    findMany.mockResolvedValue([]);
    expect(await dispatchWebhooksBatch("p1", "score.created", [score(0.1)])).toBe(0);
    expect(await dispatchWebhooksBatch("p1", "score.created", [])).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("signs deliveries and records the outcome", async () => {
    findMany.mockResolvedValue([hook()]);
    await dispatchWebhooksBatch("p1", "score.created", [score(0.1)]);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["x-memoturn-signature"]).toMatch(/^sha256=/);
    expect(update).toHaveBeenCalledTimes(1);
    // The delivery is appended to the historical log with a successful outcome.
    expect(deliveryCreate).toHaveBeenCalledTimes(1);
    expect(deliveryCreate.mock.calls[0]![0].data).toMatchObject({ webhookId: "wh1", ok: true, event: "score.created" });
  });

  it("never throws when a receiver fails (best-effort)", async () => {
    findMany.mockResolvedValue([hook()]);
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(dispatchWebhooksBatch("p1", "score.created", [score(0.1)])).resolves.toBe(0);
  });
});
