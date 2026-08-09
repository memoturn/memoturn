import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
vi.mock("@memoturn/db", () => ({ prisma: { notificationPreference: { findMany } } }));

const deliverToChannel = vi.fn().mockResolvedValue(true);
vi.mock("./automations.js", () => ({ deliverToChannel }));

const { notifyCommentMentions } = await import("./notifications.js");

const ADA = { userId: "u-ada", email: "ada@corp.com", name: "Ada Lovelace" };
const ALAN = { userId: "u-alan", email: "alan@corp.com", name: "Alan Turing" };

const base = {
  projectId: "p1",
  author: "Grace Hopper",
  objectType: "trace",
  objectId: "trace-1",
  content: "@ada @alan take a look",
  mentions: [ADA, ALAN],
};

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  findMany.mockReset().mockResolvedValue([]); // nobody has opted out
  deliverToChannel.mockClear().mockResolvedValue(true);
  process.env.CONSOLE_PUBLIC_URL = "https://memoturn.example.com";
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("notifyCommentMentions", () => {
  it("emails every mentioned member", async () => {
    expect(await notifyCommentMentions(base)).toBe(2);
    expect(deliverToChannel.mock.calls.map((c) => c[0])).toEqual([
      { type: "email", target: "ada@corp.com" },
      { type: "email", target: "alan@corp.com" },
    ]);
  });

  it("skips the comment's own author", async () => {
    // Mentioning yourself should not put mail in your own inbox.
    expect(await notifyCommentMentions({ ...base, authorUserId: "u-ada" })).toBe(1);
    expect(deliverToChannel).toHaveBeenCalledTimes(1);
    expect(deliverToChannel.mock.calls[0]?.[0]).toEqual({ type: "email", target: "alan@corp.com" });
  });

  it("respects an explicit opt-out", async () => {
    findMany.mockResolvedValue([{ userId: "u-alan" }]);
    expect(await notifyCommentMentions(base)).toBe(1);
    expect(deliverToChannel.mock.calls[0]?.[0]).toEqual({ type: "email", target: "ada@corp.com" });
  });

  it("treats a missing preference row as opted in", async () => {
    findMany.mockResolvedValue([]);
    expect(await notifyCommentMentions(base)).toBe(2);
  });

  it("deep-links to the object when a public console origin is configured", async () => {
    await notifyCommentMentions(base);
    expect(deliverToChannel.mock.calls[0]?.[1]?.body).toContain("https://memoturn.example.com/traces/trace-1");
  });

  it("omits the link rather than emitting a localhost URL", async () => {
    // A dev default in someone's inbox is a dead link; the email should still send.
    process.env.CONSOLE_PUBLIC_URL = "http://localhost:3000";
    await notifyCommentMentions(base);
    const body = deliverToChannel.mock.calls[0]?.[1]?.body as string;
    expect(body).not.toContain("localhost");
    expect(body).toContain("Memoturn console");
  });

  it("links regardless of objectType casing", async () => {
    // The console posts "TRACE", not "trace". Matching only lowercase dropped the link from
    // every real mention email — the one code path that actually exists in the product.
    await notifyCommentMentions({ ...base, objectType: "TRACE" });
    expect(deliverToChannel.mock.calls[0]?.[1]?.body).toContain("https://memoturn.example.com/traces/trace-1");
  });

  it("omits the link for an object type with no console route", async () => {
    await notifyCommentMentions({ ...base, objectType: "dataset" });
    expect(deliverToChannel.mock.calls[0]?.[1]?.body).not.toContain("https://memoturn.example.com");
  });

  it("omits the link for observations, which have no standalone page", async () => {
    // Observations render inside their parent trace's waterfall; /observations/:id does not exist.
    await notifyCommentMentions({ ...base, objectType: "OBSERVATION" });
    expect(deliverToChannel.mock.calls[0]?.[1]?.body).not.toContain("https://memoturn.example.com");
  });

  it("truncates a very long comment instead of mailing the whole thing", async () => {
    await notifyCommentMentions({ ...base, content: "x".repeat(900) });
    const body = deliverToChannel.mock.calls[0]?.[1]?.body as string;
    expect(body).toContain("…");
    expect(body).not.toContain("x".repeat(600));
  });

  it("does nothing when there are no mentions", async () => {
    expect(await notifyCommentMentions({ ...base, mentions: [] })).toBe(0);
    expect(deliverToChannel).not.toHaveBeenCalled();
  });

  it("never throws when the preference lookup fails", async () => {
    // A notification failure must not surface to whoever posted the comment.
    findMany.mockRejectedValue(new Error("database is down"));
    await expect(notifyCommentMentions(base)).resolves.toBe(0);
  });

  it("counts only the sends that actually succeeded", async () => {
    deliverToChannel.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await notifyCommentMentions(base)).toBe(1);
  });
});
