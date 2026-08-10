import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
vi.mock("@memoturn/db", () => ({ prisma: { notificationPreference: { findMany } } }));

const sendEmail = vi.fn().mockResolvedValue(true);
vi.mock("./mailer.js", () => ({ sendEmail }));

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
  sendEmail.mockClear().mockResolvedValue(true);
  process.env.CONSOLE_PUBLIC_URL = "https://memoturn.example.com";
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("notifyCommentMentions", () => {
  it("emails every mentioned member", async () => {
    expect(await notifyCommentMentions(base)).toBe(2);
    expect(sendEmail.mock.calls.map((c) => c[0].to)).toEqual(["ada@corp.com", "alan@corp.com"]);
  });

  it("skips the comment's own author", async () => {
    // Mentioning yourself should not put mail in your own inbox.
    expect(await notifyCommentMentions({ ...base, authorUserId: "u-ada" })).toBe(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0]?.[0].to).toBe("alan@corp.com");
  });

  it("respects an explicit opt-out", async () => {
    findMany.mockResolvedValue([{ userId: "u-alan" }]);
    expect(await notifyCommentMentions(base)).toBe(1);
    expect(sendEmail.mock.calls[0]?.[0].to).toBe("ada@corp.com");
  });

  it("treats a missing preference row as opted in", async () => {
    findMany.mockResolvedValue([]);
    expect(await notifyCommentMentions(base)).toBe(2);
  });

  it("deep-links to the object when a public console origin is configured", async () => {
    await notifyCommentMentions(base);
    expect(sendEmail.mock.calls[0]?.[0].text).toContain("https://memoturn.example.com/traces/trace-1");
  });

  it("omits the link rather than emitting a localhost URL", async () => {
    // A dev default in someone's inbox is a dead link; the email should still send.
    process.env.CONSOLE_PUBLIC_URL = "http://localhost:3000";
    await notifyCommentMentions(base);
    const body = sendEmail.mock.calls[0]?.[0].text as string;
    expect(body).not.toContain("localhost");
    expect(body).toContain("Memoturn console");
  });

  it("links regardless of objectType casing", async () => {
    // The console posts "TRACE", not "trace". Matching only lowercase dropped the link from
    // every real mention email — the one code path that actually exists in the product.
    await notifyCommentMentions({ ...base, objectType: "TRACE" });
    expect(sendEmail.mock.calls[0]?.[0].text).toContain("https://memoturn.example.com/traces/trace-1");
  });

  it("omits the link for an object type with no console route", async () => {
    await notifyCommentMentions({ ...base, objectType: "dataset" });
    expect(sendEmail.mock.calls[0]?.[0].text).not.toContain("https://memoturn.example.com");
  });

  it("omits the link for observations, which have no standalone page", async () => {
    // Observations render inside their parent trace's waterfall; /observations/:id does not exist.
    await notifyCommentMentions({ ...base, objectType: "OBSERVATION" });
    expect(sendEmail.mock.calls[0]?.[0].text).not.toContain("https://memoturn.example.com");
  });

  it("truncates a very long comment instead of mailing the whole thing", async () => {
    await notifyCommentMentions({ ...base, content: "x".repeat(900) });
    const body = sendEmail.mock.calls[0]?.[0].text as string;
    expect(body).toContain("…");
    expect(body).not.toContain("x".repeat(600));
  });

  it("does nothing when there are no mentions", async () => {
    expect(await notifyCommentMentions({ ...base, mentions: [] })).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("never throws when the preference lookup fails", async () => {
    // A notification failure must not surface to whoever posted the comment.
    findMany.mockRejectedValue(new Error("database is down"));
    await expect(notifyCommentMentions(base)).resolves.toBe(0);
  });

  it("sends a branded HTML part alongside the text part", async () => {
    await notifyCommentMentions(base);
    const msg = sendEmail.mock.calls[0]?.[0];
    expect(msg.html).toContain("Memoturn");
    expect(msg.html).toContain("#2a7679"); // brand light-surface primary, 5.3:1 on white
    expect(msg.text).toBeTruthy(); // plain-text part still present for text-only clients
  });

  it("declares dark-mode support so clients don't force-invert it", async () => {
    // Without the head metas a dark-mode client inverts the whole email — a #2a7679 button with
    // white text becomes pale mint with dark text. Declaring color-scheme in a real <head>
    // suppresses that; the media block then styles dark deliberately.
    await notifyCommentMentions(base);
    const rendered = sendEmail.mock.calls[0]?.[0].html as string;
    expect(rendered).toContain("<!doctype html>");
    expect(rendered).toContain('name="color-scheme"');
    expect(rendered).toContain('name="supported-color-schemes"');
    expect(rendered).toContain("@media (prefers-color-scheme: dark)");
    expect(rendered).toContain("#4fb8b2"); // lagoon — the dark-surface accent
  });

  it("escapes the comment body instead of injecting it into the HTML", async () => {
    // A comment is user-authored and this email goes to someone else — markup in a comment
    // must not become markup in their inbox.
    await notifyCommentMentions({ ...base, content: '<img src=x onerror=alert(1)>"hi"' });
    const html = sendEmail.mock.calls[0]?.[0].html as string;
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("falls back to the shared console origin when CONSOLE_PUBLIC_URL is unset", async () => {
    // AUTH_TRUSTED_ORIGINS[0] is the console; AUTH_BASE_URL is the API and must not be used.
    process.env.CONSOLE_PUBLIC_URL = "";
    process.env.AUTH_TRUSTED_ORIGINS = "https://console.example.com,https://other.example.com";
    process.env.AUTH_BASE_URL = "https://api.example.com";
    await notifyCommentMentions(base);
    const text = sendEmail.mock.calls[0]?.[0].text as string;
    expect(text).toContain("https://console.example.com/traces/trace-1");
    expect(text).not.toContain("api.example.com");
  });

  it("counts only the sends that actually succeeded", async () => {
    sendEmail.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await notifyCommentMentions(base)).toBe(1);
  });
});
