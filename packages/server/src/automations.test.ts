import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
const findUnique = vi.fn();
vi.mock("@memoturn/db", () => ({ prisma: { automation: { findMany, findUnique } } }));

// The github action decrypts a stored PAT; the cipher itself is tested in @memoturn/llm.
vi.mock("@memoturn/llm", () => ({
  encryptSecret: (v: string) => `enc:${v}`,
  decryptSecret: (v: string) => v.replace(/^enc:/, ""),
}));

const redis = { get: vi.fn(), set: vi.fn(), del: vi.fn() };
vi.mock("@memoturn/db/queue", () => ({ redisConnection: () => redis }));

const sendEmail = vi.fn().mockResolvedValue(true);
vi.mock("./mailer.js", () => ({ sendEmail }));

const { automationMatches, dispatchAutomationsBatch } = await import("./automations.js");

describe("automationMatches", () => {
  it("with no threshold or filter, always matches", () => {
    expect(automationMatches({}, { name: "x", value: 5 })).toBe(true);
  });
  it("threshold fires only when the value is below it", () => {
    expect(automationMatches({ threshold: 0.5 }, { value: 0.2 })).toBe(true);
    expect(automationMatches({ threshold: 0.5 }, { value: 0.9 })).toBe(false);
    expect(automationMatches({ threshold: 0.5 }, { value: null })).toBe(false); // no value → not below
  });
  it("filter is a substring match on the name", () => {
    expect(automationMatches({ filter: "rag" }, { name: "rag-pipeline" })).toBe(true);
    expect(automationMatches({ filter: "rag" }, { name: "chat" })).toBe(false);
    expect(automationMatches({ filter: "rag" }, {})).toBe(false);
  });
  it("threshold and filter must both pass", () => {
    expect(automationMatches({ threshold: 0.5, filter: "q" }, { value: 0.2, name: "quality" })).toBe(true);
    expect(automationMatches({ threshold: 0.5, filter: "q" }, { value: 0.2, name: "latency" })).toBe(false);
    expect(automationMatches({ threshold: 0.5, filter: "q" }, { value: 0.9, name: "quality" })).toBe(false);
  });
});

describe("dispatchAutomationsBatch", () => {
  const origEnv = process.env.ALLOW_PRIVATE_WEBHOOK_TARGETS;
  const fetchMock = vi.fn();

  const rule = (over: Record<string, unknown> = {}) => ({
    id: "a1",
    action: "webhook",
    target: "http://localhost:9/auto",
    threshold: null,
    filter: "",
    ...over,
  });

  beforeEach(() => {
    process.env.ALLOW_PRIVATE_WEBHOOK_TARGETS = "1"; // permit the fake localhost targets
    findMany.mockReset();
    redis.get.mockReset().mockResolvedValue(null);
    redis.set.mockReset().mockResolvedValue("OK");
    redis.del.mockReset().mockResolvedValue(1);
    fetchMock.mockReset().mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (origEnv === undefined) delete process.env.ALLOW_PRIVATE_WEBHOOK_TARGETS;
    else process.env.ALLOW_PRIVATE_WEBHOOK_TARGETS = origEnv;
  });

  it("does ONE config lookup for the whole batch and caches it", async () => {
    findMany.mockResolvedValue([rule()]);
    const fired = await dispatchAutomationsBatch("p1", "score.created", [
      { traceId: "t1", name: "a", value: 0.1 },
      { traceId: "t2", name: "b", value: 0.2 },
    ]);
    expect(fired).toBe(2);
    expect(findMany).toHaveBeenCalledTimes(1); // the old per-payload path called this 2×
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(redis.set).toHaveBeenCalledTimes(1); // list cached for the next batch
  });

  it("serves the config from Redis without touching Postgres on a cache hit", async () => {
    redis.get.mockResolvedValue(JSON.stringify([rule()]));
    const fired = await dispatchAutomationsBatch("p1", "score.created", [{ traceId: "t1", name: "a", value: 0.1 }]);
    expect(fired).toBe(1);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("applies threshold/filter matching per payload", async () => {
    findMany.mockResolvedValue([rule({ threshold: 0.5, filter: "qual" })]);
    const fired = await dispatchAutomationsBatch("p1", "score.created", [
      { name: "quality", value: 0.1 }, // matches
      { name: "quality", value: 0.9 }, // above threshold
      { name: "latency", value: 0.1 }, // filter miss
    ]);
    expect(fired).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns 0 without fetching for empty payloads or no rules", async () => {
    findMany.mockResolvedValue([]);
    expect(await dispatchAutomationsBatch("p1", "score.created", [{ name: "x" }])).toBe(0);
    expect(await dispatchAutomationsBatch("p1", "score.created", [])).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never throws when a target fails (best-effort)", async () => {
    findMany.mockResolvedValue([rule()]);
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(dispatchAutomationsBatch("p1", "score.created", [{ name: "x", value: 0 }])).resolves.toBe(0);
  });

  it("dispatches a PagerDuty action via the Events API (routing key target, no SSRF check)", async () => {
    findMany.mockResolvedValue([rule({ action: "pagerduty", target: "R0UTING_KEY" })]);
    const fired = await dispatchAutomationsBatch("p1", "score.created", [{ name: "quality", value: 0.1 }]);
    expect(fired).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toContain("events.pagerduty.com");
    const payload = JSON.parse(opts.body) as { routing_key: string; event_action: string };
    expect(payload).toMatchObject({ routing_key: "R0UTING_KEY", event_action: "trigger" });
  });

  it("dispatches an email action via the mailer (no fetch)", async () => {
    sendEmail.mockClear();
    findMany.mockResolvedValue([rule({ action: "email", target: "alerts@example.com" })]);
    const fired = await dispatchAutomationsBatch("p1", "score.created", [
      { name: "quality", value: 0.1, traceId: "t1" },
    ]);
    expect(fired).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const arg = sendEmail.mock.calls[0]![0] as { to: string; subject: string };
    expect(arg.to).toBe("alerts@example.com");
    expect(arg.subject).toContain("score.created"); // plain-text summary, no markdown
    expect(arg.subject).not.toContain("*");
  });
});

describe("github repository_dispatch action", () => {
  const fetchMock = vi.fn();
  const origEnv = process.env.ALLOW_PRIVATE_WEBHOOK_TARGETS;

  beforeEach(() => {
    findMany
      .mockReset()
      .mockResolvedValue([{ id: "gh1", action: "github", target: "acme/ci", threshold: null, filter: "" }]);
    findUnique.mockReset().mockResolvedValue({ secret: "enc:ghp_token" });
    redis.get.mockReset().mockResolvedValue(null);
    redis.set.mockReset().mockResolvedValue("OK");
    fetchMock.mockReset().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    process.env.ALLOW_PRIVATE_WEBHOOK_TARGETS = origEnv;
    vi.unstubAllGlobals();
  });

  it("POSTs a repository_dispatch with the event type derived from the trigger", async () => {
    const fired = await dispatchAutomationsBatch("p1", "prompt.label.moved", [
      { name: "support-reply", version: 4, labels: ["production"] },
    ]);
    expect(fired).toBe(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string>; body: string }];
    expect(url).toBe("https://api.github.com/repos/acme/ci/dispatches");
    expect(init.headers.authorization).toBe("Bearer ghp_token");
    const body = JSON.parse(init.body) as { event_type: string; client_payload: Record<string, unknown> };
    // A workflow filters on `types: [...]`, and dots aren't allowed there.
    expect(body.event_type).toBe("memoturn-prompt-label-moved");
    expect(body.client_payload).toMatchObject({ name: "support-reply", version: 4, projectId: "p1" });
  });

  it("keeps the token out of the cached dispatch shape", async () => {
    await dispatchAutomationsBatch("p1", "prompt.updated", [{ name: "x", version: 2 }]);
    // Whatever gets cached must not contain the secret — a Redis dump can't leak a credential.
    const cached = redis.set.mock.calls[0]?.[1] as string;
    expect(cached).not.toContain("ghp_token");
    expect(cached).not.toContain("secret");
  });

  it("reports a rejected dispatch as not delivered", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401 });
    expect(await dispatchAutomationsBatch("p1", "prompt.updated", [{ name: "x" }])).toBe(0);
  });

  it("does not call GitHub when the token is missing or unreadable", async () => {
    findUnique.mockResolvedValue({ secret: "" });
    expect(await dispatchAutomationsBatch("p1", "prompt.updated", [{ name: "x" }])).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not call GitHub when the target isn't owner/repo", async () => {
    findMany.mockResolvedValue([{ id: "gh1", action: "github", target: "not-a-repo", threshold: null, filter: "" }]);
    expect(await dispatchAutomationsBatch("p1", "prompt.updated", [{ name: "x" }])).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
