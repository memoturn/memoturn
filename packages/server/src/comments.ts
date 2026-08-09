import { prisma } from "@memoturn/db";
import { notifyCommentMentions } from "./notifications.js";
import { listProjectMembers } from "./projectmembers.js";

/** Comments on a trace / observation / session / prompt. */
export interface CreateCommentInput {
  objectType: string;
  objectId: string;
  content: string;
}

/** A resolved @mention — a real member of this project's organization. */
export interface CommentMention {
  userId: string;
  email: string;
  name: string;
}

export interface CommentRow {
  id: string;
  objectType: string;
  objectId: string;
  author: string;
  content: string;
  mentions: CommentMention[];
  createdAt: string;
}

/**
 * Candidate @mention tokens in a comment body. Matches `@alice`, `@alice.smith`, and the
 * fully-qualified `@alice@corp.com` — the longer email form is preferred by the alternation
 * so "@alice@corp.com" yields one token, not "@alice" plus a stray domain.
 *
 * Anchored to a non-word character (or the start) so mid-word "@" — the "user@host" inside a
 * URL, a decorator, an npm scope — is not mistaken for a mention.
 */
const MENTION_RE = /(^|[^\w@])@([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|[A-Za-z0-9._%+-]+)/g;

/** Normalize a member name for handle matching: "Ada Lovelace" → "adalovelace". */
const handleOf = (name: string) => name.toLowerCase().replace(/\s+/g, "");

export function parseMentionTokens(content: string): string[] {
  const out = new Set<string>();
  for (const m of content.matchAll(MENTION_RE)) {
    const token = m[2];
    if (token) out.add(token.toLowerCase());
  }
  return [...out];
}

/**
 * Resolve @mention tokens against the project's org members. A token matches a member by full
 * email, by email local-part, or by whitespace-stripped name — so `@ada`, `@ada@corp.com`, and
 * `@AdaLovelace` all reach the same person.
 *
 * Unresolvable tokens are dropped rather than erroring: a comment is prose first, and a typo'd
 * handle should not block posting it. An ambiguous token (two members sharing a local-part or
 * name) is also dropped — silently notifying the wrong person is worse than notifying nobody.
 */
export async function resolveMentions(projectId: string, content: string): Promise<CommentMention[]> {
  const tokens = parseMentionTokens(content);
  if (tokens.length === 0) return [];

  const members = await listProjectMembers(projectId);
  const byKey = new Map<string, CommentMention | null>(); // null marks an ambiguous key
  const index = (key: string, member: CommentMention) => {
    if (!key) return;
    const existing = byKey.get(key);
    if (existing === undefined) byKey.set(key, member);
    else if (existing && existing.userId !== member.userId) byKey.set(key, null);
  };
  for (const m of members) {
    const mention: CommentMention = { userId: m.userId, email: m.email, name: m.name };
    const email = m.email.toLowerCase();
    index(email, mention);
    index(email.split("@")[0] ?? "", mention);
    index(handleOf(m.name), mention);
  }

  const seen = new Set<string>();
  const resolved: CommentMention[] = [];
  for (const token of tokens) {
    const hit = byKey.get(token);
    if (hit && !seen.has(hit.userId)) {
      seen.add(hit.userId);
      resolved.push(hit);
    }
  }
  return resolved;
}

/** Re-hydrate stored user ids into display mentions, dropping anyone no longer in the org. */
async function hydrateMentions(
  projectId: string,
  rows: { mentions: string[] }[],
): Promise<Map<string, CommentMention>> {
  if (!rows.some((r) => r.mentions.length > 0)) return new Map();
  const members = await listProjectMembers(projectId);
  return new Map(members.map((m) => [m.userId, { userId: m.userId, email: m.email, name: m.name }]));
}

export async function createComment(
  projectId: string,
  author: string,
  input: CreateCommentInput,
  authorUserId?: string,
): Promise<CommentRow> {
  const mentions = await resolveMentions(projectId, input.content);
  const c = await prisma.comment.create({
    data: {
      projectId,
      author,
      objectType: input.objectType,
      objectId: input.objectId,
      content: input.content,
      mentions: mentions.map((m) => m.userId),
    },
  });

  // Awaited, not fire-and-forget: a detached promise is not safe across deployment profiles
  // (ADR-0003 — an edge invocation can be torn down the moment the response is written).
  // notifyCommentMentions never throws and returns 0 when email isn't configured.
  await notifyCommentMentions({
    projectId,
    author,
    authorUserId,
    objectType: c.objectType,
    objectId: c.objectId,
    content: c.content,
    mentions,
  });

  return {
    id: c.id,
    objectType: c.objectType,
    objectId: c.objectId,
    author: c.author,
    content: c.content,
    mentions,
    createdAt: c.createdAt.toISOString(),
  };
}

export async function listComments(projectId: string, objectType: string, objectId: string): Promise<CommentRow[]> {
  const rows = await prisma.comment.findMany({
    where: { projectId, objectType, objectId },
    orderBy: { createdAt: "asc" },
  });
  const byUser = await hydrateMentions(projectId, rows);
  return rows.map((c) => ({
    id: c.id,
    objectType: c.objectType,
    objectId: c.objectId,
    author: c.author,
    content: c.content,
    mentions: c.mentions.map((id) => byUser.get(id)).filter((m): m is CommentMention => m !== undefined),
    createdAt: c.createdAt.toISOString(),
  }));
}

export async function deleteComment(projectId: string, id: string) {
  await prisma.comment.deleteMany({ where: { projectId, id } });
  return { deleted: true };
}
