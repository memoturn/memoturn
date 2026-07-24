import { beforeEach, describe, expect, it, vi } from "vitest";

const memberFindFirst = vi.fn();
const sandboxCount = vi.fn();
const sandboxFindMany = vi.fn();
const sandboxUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
const projectFindMany = vi.fn();
const orgDelete = vi.fn().mockResolvedValue({});
const userDelete = vi.fn().mockResolvedValue({});
const txOrgCreate = vi.fn();
const txProjectCreate = vi.fn();
const txMemberCreate = vi.fn().mockResolvedValue({});
const txSandboxCreate = vi.fn().mockResolvedValue({});

vi.mock("@memoturn/db", () => ({
  prisma: {
    member: { findFirst: memberFindFirst },
    demoSandbox: { count: sandboxCount, findMany: sandboxFindMany, updateMany: sandboxUpdateMany },
    project: { findMany: projectFindMany },
    organization: { delete: orgDelete },
    user: { delete: userDelete },
    $transaction: (fn: (tx: unknown) => unknown) =>
      fn({
        organization: { create: txOrgCreate },
        project: { create: txProjectCreate },
        member: { create: txMemberCreate },
        demoSandbox: { create: txSandboxCreate },
      }),
  },
}));

const queueAdd = vi.fn().mockResolvedValue(undefined);
vi.mock("@memoturn/db/queue", () => ({ getSandboxQueue: () => ({ add: queueAdd }) }));

const deleteBlobPrefixOlderThan = vi.fn().mockResolvedValue(0);
vi.mock("@memoturn/db/blob", () => ({ deleteBlobPrefixOlderThan }));

const deleteProjectData = vi.fn().mockResolvedValue(undefined);
vi.mock("@memoturn/telemetry", () => ({ telemetry: () => ({ deleteProjectData }) }));

const submitBatch = vi.fn().mockResolvedValue({ batchId: "b" });
vi.mock("./ingest.js", () => ({ submitBatch }));

const { provisionSandboxForUser, pruneExpiredSandboxes, demoConfig, demoModeEnabled, DemoCapacityError, seedSandbox } =
  await import("./demo.js");

beforeEach(() => {
  vi.clearAllMocks();
  sandboxUpdateMany.mockResolvedValue({ count: 1 });
  txOrgCreate.mockResolvedValue({ id: "org1" });
  txProjectCreate.mockResolvedValue({ id: "proj1" });
  for (const k of ["DEMO_MODE", "DEMO_TTL_DAYS", "DEMO_MAX_SANDBOXES", "DEMO_MEMBER_ROLE"]) delete process.env[k];
});

describe("demoModeEnabled", () => {
  it("is off unless explicitly enabled", () => {
    expect(demoModeEnabled()).toBe(false);
    process.env.DEMO_MODE = "true";
    expect(demoModeEnabled()).toBe(true);
    process.env.DEMO_MODE = "1";
    expect(demoModeEnabled()).toBe(true);
  });
});

describe("demoConfig", () => {
  it("defaults to a 7-day TTL and a read-only role", () => {
    const c = demoConfig();
    expect(c.ttlDays).toBe(7);
    expect(c.memberRole).toBe("viewer");
    expect(c.maxSandboxes).toBe(500);
  });

  it("honors overrides and ignores junk", () => {
    process.env.DEMO_TTL_DAYS = "30";
    process.env.DEMO_MAX_SANDBOXES = "not-a-number";
    expect(demoConfig().ttlDays).toBe(30);
    expect(demoConfig().maxSandboxes).toBe(500);
  });
});

describe("provisionSandboxForUser", () => {
  it("creates org + project + read-only member + sandbox, then enqueues the seed", async () => {
    memberFindFirst.mockResolvedValue(null);
    sandboxCount.mockResolvedValue(0);

    const orgId = await provisionSandboxForUser("u1", "visitor@example.com");

    expect(orgId).toBe("org1");
    expect(txOrgCreate).toHaveBeenCalledTimes(1);
    expect(txProjectCreate).toHaveBeenCalledWith({
      data: { organizationId: "org1", name: "Demo Project", slug: "default" },
    });
    expect(txMemberCreate).toHaveBeenCalledWith({
      data: { organizationId: "org1", userId: "u1", role: "viewer" },
    });
    const sandboxArg = txSandboxCreate.mock.calls[0]![0].data;
    expect(sandboxArg).toMatchObject({ organizationId: "org1", userId: "u1", email: "visitor@example.com" });
    // ~7 days out.
    const days = (sandboxArg.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
    // Enqueued only after the transaction, so the worker never sees a half-built tenant.
    expect(queueAdd).toHaveBeenCalledWith("seed", { organizationId: "org1", projectId: "proj1" });
  });

  it("is a no-op for a user who already belongs to an org (returning visitor)", async () => {
    memberFindFirst.mockResolvedValue({ organizationId: "existing" });
    expect(await provisionSandboxForUser("u1", "a@b.c")).toBeNull();
    expect(txOrgCreate).not.toHaveBeenCalled();
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it("refuses past the sandbox cap", async () => {
    memberFindFirst.mockResolvedValue(null);
    process.env.DEMO_MAX_SANDBOXES = "2";
    sandboxCount.mockResolvedValue(2);
    await expect(provisionSandboxForUser("u1", "a@b.c")).rejects.toBeInstanceOf(DemoCapacityError);
    expect(txOrgCreate).not.toHaveBeenCalled();
  });

  it("generates a unique slug per sandbox", async () => {
    memberFindFirst.mockResolvedValue(null);
    sandboxCount.mockResolvedValue(0);
    await provisionSandboxForUser("u1", "a@b.c");
    await provisionSandboxForUser("u2", "b@b.c");
    const slugs = txOrgCreate.mock.calls.map((c) => c[0].data.slug);
    expect(new Set(slugs).size).toBe(2);
    for (const s of slugs) expect(s).toMatch(/^demo-/);
  });
});

describe("seedSandbox", () => {
  it("marks SEEDING, submits batches, then READY", async () => {
    process.env.DEMO_SEED_DAYS = "2";
    process.env.DEMO_SEED_TRACES_PER_DAY = "3";
    await seedSandbox("org1", "proj1");
    expect(submitBatch).toHaveBeenCalled();
    expect(submitBatch.mock.calls[0]![0]).toBe("proj1");
    const statuses = sandboxUpdateMany.mock.calls.map((c) => c[0].data.status);
    expect(statuses[0]).toBe("SEEDING");
    expect(statuses.at(-1)).toBe("READY");
    delete process.env.DEMO_SEED_DAYS;
    delete process.env.DEMO_SEED_TRACES_PER_DAY;
  });

  it("records FAILED with the error when submission throws", async () => {
    submitBatch.mockRejectedValueOnce(new Error("blob down"));
    await expect(seedSandbox("org1", "proj1")).rejects.toThrow("blob down");
    const last = sandboxUpdateMany.mock.calls.at(-1)![0].data;
    expect(last.status).toBe("FAILED");
    expect(last.error).toContain("blob down");
  });
});

describe("pruneExpiredSandboxes", () => {
  it("purges telemetry and blob BEFORE deleting the tenant, then the user", async () => {
    sandboxFindMany.mockResolvedValue([{ id: "s1", organizationId: "org1", userId: "u1" }]);
    projectFindMany.mockResolvedValue([{ id: "proj1" }]);

    const order: string[] = [];
    deleteProjectData.mockImplementation(async () => void order.push("telemetry"));
    deleteBlobPrefixOlderThan.mockImplementation(async () => void order.push("blob"));
    orgDelete.mockImplementation(async () => void order.push("org"));
    userDelete.mockImplementation(async () => void order.push("user"));

    const r = await pruneExpiredSandboxes();

    expect(r).toEqual({ deleted: 1, failed: 0 });
    // Telemetry/blob live outside the Prisma cascade — they must go first, while the
    // project rows still exist to enumerate.
    expect(order.indexOf("telemetry")).toBeLessThan(order.indexOf("org"));
    expect(order.indexOf("blob")).toBeLessThan(order.indexOf("org"));
    expect(order.indexOf("org")).toBeLessThan(order.indexOf("user"));
    // All three blob prefixes swept.
    expect(deleteBlobPrefixOlderThan.mock.calls.map((c) => c[0])).toEqual([
      "events/proj1/",
      "payloads/proj1/",
      "media/proj1/",
    ]);
  });

  it("only selects sandboxes past their expiry", async () => {
    sandboxFindMany.mockResolvedValue([]);
    const now = new Date("2026-07-24T00:00:00Z");
    await pruneExpiredSandboxes(now);
    expect(sandboxFindMany.mock.calls[0]![0].where).toEqual({ expiresAt: { lt: now } });
  });

  it("keeps sweeping when one sandbox fails", async () => {
    sandboxFindMany.mockResolvedValue([
      { id: "s1", organizationId: "bad", userId: "u1" },
      { id: "s2", organizationId: "good", userId: "u2" },
    ]);
    projectFindMany.mockResolvedValue([{ id: "p" }]);
    orgDelete.mockRejectedValueOnce(new Error("fk violation"));
    expect(await pruneExpiredSandboxes()).toEqual({ deleted: 1, failed: 1 });
  });
});
