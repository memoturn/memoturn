import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
vi.mock("@memoturn/db", () => ({ prisma: { comment: { findMany, create: vi.fn(), deleteMany: vi.fn() } } }));

const listProjectMembers = vi.fn();
vi.mock("./projectmembers.js", () => ({ listProjectMembers }));

const { parseMentionTokens, resolveMentions } = await import("./comments.js");

const MEMBERS = [
  { userId: "u-ada", email: "ada@corp.com", name: "Ada Lovelace", orgRole: "member", projectRole: null },
  { userId: "u-alan", email: "alan@corp.com", name: "Alan Turing", orgRole: "owner", projectRole: null },
];

describe("parseMentionTokens", () => {
  it("finds bare handles and full-email handles", () => {
    expect(parseMentionTokens("cc @ada and @alan@corp.com please")).toEqual(["ada", "alan@corp.com"]);
  });

  it("prefers the email form over its local-part when both could match", () => {
    // "@ada@corp.com" must yield ONE token, not "ada" plus a dangling domain.
    expect(parseMentionTokens("@ada@corp.com")).toEqual(["ada@corp.com"]);
  });

  it("ignores an @ that is not at a word boundary", () => {
    // Emails in prose, npm scopes and decorators are not mentions.
    expect(parseMentionTokens("mail ada@corp.com about it")).toEqual([]);
    expect(parseMentionTokens("see https://x.com/u@ada")).toEqual([]);
  });

  it("dedupes repeated handles", () => {
    expect(parseMentionTokens("@ada @ada @Ada")).toEqual(["ada"]);
  });
});

describe("resolveMentions", () => {
  beforeEach(() => {
    listProjectMembers.mockReset();
    listProjectMembers.mockResolvedValue(MEMBERS);
  });

  it("does not hit the member list when there is nothing to resolve", async () => {
    expect(await resolveMentions("p1", "no mentions here")).toEqual([]);
    expect(listProjectMembers).not.toHaveBeenCalled();
  });

  it("resolves by local-part, full email, and whitespace-stripped name", async () => {
    const byLocal = await resolveMentions("p1", "@ada");
    const byEmail = await resolveMentions("p1", "@ada@corp.com");
    const byName = await resolveMentions("p1", "@AdaLovelace");
    for (const r of [byLocal, byEmail, byName]) {
      expect(r).toEqual([{ userId: "u-ada", email: "ada@corp.com", name: "Ada Lovelace" }]);
    }
  });

  it("drops handles that match nobody instead of failing the comment", async () => {
    const r = await resolveMentions("p1", "@nobody but also @alan");
    expect(r.map((m) => m.userId)).toEqual(["u-alan"]);
  });

  it("drops an ambiguous handle rather than guessing a person", async () => {
    listProjectMembers.mockResolvedValue([
      { userId: "u1", email: "chris@a.com", name: "Chris A", orgRole: "member", projectRole: null },
      { userId: "u2", email: "chris@b.com", name: "Chris B", orgRole: "member", projectRole: null },
    ]);
    // "chris" is a local-part shared by two members — notifying the wrong one is worse than neither.
    expect(await resolveMentions("p1", "@chris")).toEqual([]);
    // The unambiguous full-email form still resolves.
    expect((await resolveMentions("p1", "@chris@b.com")).map((m) => m.userId)).toEqual(["u2"]);
  });

  it("returns each mentioned user once even when addressed several ways", async () => {
    const r = await resolveMentions("p1", "@ada @ada@corp.com @AdaLovelace");
    expect(r).toHaveLength(1);
  });
});
