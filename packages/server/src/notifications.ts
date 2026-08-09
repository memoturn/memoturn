import type { NotificationPreferences } from "@memoturn/contracts";
import { prisma } from "@memoturn/db";
import { deliverToChannel } from "./automations.js";
import type { CommentMention } from "./comments.js";

/**
 * Outbound notifications to *people* (as opposed to automations, which notify systems).
 *
 * Every send here is best-effort: a mention email that fails must never fail the action that
 * triggered it, so these functions swallow their own errors and report a count instead of
 * throwing. Callers still await them — a detached promise isn't safe across deployment
 * profiles (ADR-0003), where an invocation can be torn down as soon as the response is written.
 */

/**
 * Public origin of the console, used to deep-link notifications back to the object in question.
 *
 * `CONSOLE_PUBLIC_URL` is the explicit setting. It falls back to `AUTH_BASE_URL`, which is the
 * console origin on the single-VM deployment (Caddy serves the SPA at the root and proxies the
 * API under `/api`). When neither is set — or when the value is a localhost dev default that
 * would be meaningless in someone's inbox — we send a link-free email rather than a broken link.
 */
function consoleOrigin(): string | null {
  const raw = (process.env.CONSOLE_PUBLIC_URL ?? process.env.AUTH_BASE_URL ?? "").trim();
  if (!raw) return null;
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(raw)) return null;
  return raw.replace(/\/$/, "");
}

/**
 * Console path for a commented-on object. Mirrors the console's file-based routes; an unknown
 * objectType yields null so the email degrades to link-free rather than inventing a route.
 */
function objectPath(objectType: string, objectId: string): string | null {
  const id = encodeURIComponent(objectId);
  switch (objectType) {
    case "trace":
      return `/traces/${id}`;
    case "observation":
      return `/observations/${id}`;
    case "session":
      return `/sessions/${id}`;
    case "prompt":
      return `/prompts/${id}`;
    default:
      return null;
  }
}

/**
 * Which of these users still want mention email. A user with no preference row has never
 * changed a default, so absence means opted in — we only exclude explicit opt-outs.
 */
async function mentionOptOuts(userIds: string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const rows = await prisma.notificationPreference.findMany({
    where: { userId: { in: userIds }, mentionEmail: false },
    select: { userId: true },
  });
  return new Set(rows.map((r) => r.userId));
}

/**
 * This user's notification settings. A missing row means every default, so a user who has
 * never opened the settings page reads back all-on without us writing anything for them.
 */
export async function getNotificationPreferences(userId: string): Promise<NotificationPreferences> {
  const row = await prisma.notificationPreference.findUnique({
    where: { userId },
    select: { mentionEmail: true },
  });
  return { mentionEmail: row?.mentionEmail ?? true };
}

/** Upsert this user's notification settings, returning the stored result. */
export async function updateNotificationPreferences(
  userId: string,
  input: Partial<NotificationPreferences>,
): Promise<NotificationPreferences> {
  const row = await prisma.notificationPreference.upsert({
    where: { userId },
    create: { userId, ...input },
    update: input,
    select: { mentionEmail: true },
  });
  return { mentionEmail: row.mentionEmail };
}

export interface MentionNotification {
  projectId: string;
  /** Display name or email of whoever wrote the comment. */
  author: string;
  objectType: string;
  objectId: string;
  content: string;
  mentions: CommentMention[];
  /** User id of the comment's author, when known — used to skip self-mentions. */
  authorUserId?: string;
}

/**
 * Email everyone @mentioned in a comment. Returns the number of messages actually delivered.
 *
 * Skips the author (nobody needs mail about their own comment) and anyone who has opted out.
 * Never throws: individual failures are swallowed by `deliverToChannel`, and a total failure
 * (e.g. the database is unreachable) resolves to 0.
 */
export async function notifyCommentMentions(input: MentionNotification): Promise<number> {
  try {
    const recipients = input.mentions.filter((m) => m.userId !== input.authorUserId && m.email);
    if (recipients.length === 0) return 0;

    const optedOut = await mentionOptOuts(recipients.map((m) => m.userId));
    const targets = recipients.filter((m) => !optedOut.has(m.userId));
    if (targets.length === 0) return 0;

    const origin = consoleOrigin();
    const path = objectPath(input.objectType, input.objectId);
    const link = origin && path ? `${origin}${path}` : null;

    // Comments are prose and can be long; quote enough to give context without mailing an essay.
    const excerpt = input.content.length > 500 ? `${input.content.slice(0, 500)}…` : input.content;
    const subject = `${input.author} mentioned you in a comment`;
    const body = [
      `${input.author} mentioned you on a ${input.objectType} in Memoturn:`,
      "",
      excerpt,
      "",
      link ? `View it: ${link}` : `Open the ${input.objectType} in your Memoturn console to reply.`,
      "",
      "Don't want these? Turn off mention email in your Memoturn notification settings.",
    ].join("\n");

    const results = await Promise.all(
      targets.map((m) =>
        deliverToChannel(
          { type: "email", target: m.email },
          { slackText: subject, webhookBody: null, summary: subject, body },
        ),
      ),
    );
    return results.filter(Boolean).length;
  } catch {
    return 0; // best-effort: never let a notification failure surface to the commenter
  }
}
