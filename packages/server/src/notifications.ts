import type { NotificationPreferences } from "@memoturn/contracts";
import { prisma } from "@memoturn/db";
import type { CommentMention } from "./comments.js";
import { brandedEmail } from "./emailtemplate.js";
import { publicConsoleOrigin } from "./env.js";
import { sendEmail } from "./mailer.js";

/**
 * Outbound notifications to *people* (as opposed to automations, which notify systems).
 *
 * Every send here is best-effort: a mention email that fails must never fail the action that
 * triggered it, so these functions swallow their own errors and report a count instead of
 * throwing. Callers still await them — a detached promise isn't safe across deployment
 * profiles (ADR-0003), where an invocation can be torn down as soon as the response is written.
 */

/**
 * Console path for a commented-on object, or null when the object has no standalone page —
 * the email then degrades to link-free rather than pointing at a route that 404s.
 *
 * Case-insensitive on purpose: `objectType` is a free-form string on the wire, and the console
 * posts it uppercase ("TRACE") while the API and MCP surfaces accept anything. Matching only
 * lowercase silently dropped the link from every real mention email.
 *
 * Only object types with an actual console route appear here. Observations deliberately do not:
 * they are rendered inside their parent trace's waterfall, so there is no /observations/:id page
 * to link to.
 */
function objectPath(objectType: string, objectId: string): string | null {
  const id = encodeURIComponent(objectId);
  switch (objectType.toLowerCase()) {
    case "trace":
      return `/traces/${id}`;
    case "session":
      return `/sessions/${id}`;
    case "prompt":
      // The prompts route is keyed by name (`/prompts/$name`), so this only resolves when the
      // caller stored a prompt name as objectId.
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
 * Never throws: a failed send resolves false rather than raising, and a total failure (e.g. the
 * database is unreachable) resolves to 0.
 */
export async function notifyCommentMentions(input: MentionNotification): Promise<number> {
  try {
    const recipients = input.mentions.filter((m) => m.userId !== input.authorUserId && m.email);
    if (recipients.length === 0) return 0;

    const optedOut = await mentionOptOuts(recipients.map((m) => m.userId));
    const targets = recipients.filter((m) => !optedOut.has(m.userId));
    if (targets.length === 0) return 0;

    const origin = publicConsoleOrigin();
    const path = objectPath(input.objectType, input.objectId);
    const link = origin && path ? `${origin}${path}` : null;

    // Comments are prose and can be long; quote enough to give context without mailing an essay.
    const excerpt = input.content.length > 500 ? `${input.content.slice(0, 500)}…` : input.content;
    const kind = input.objectType.toLowerCase();
    const subject = `${input.author} mentioned you in a comment`;
    // The comment body is user-authored and lands in someone else's inbox — brandedEmail
    // escapes it, which is why the quote goes through the template rather than string concat.
    const { text, html } = brandedEmail({
      title: subject,
      // With no public console URL there's no button to press, so the intro carries the
      // instruction instead — otherwise the recipient is told they were mentioned and given
      // nowhere to go.
      intro: link
        ? `${input.author} mentioned you on a ${kind} in Memoturn.`
        : `${input.author} mentioned you on a ${kind} in Memoturn. Open the ${kind} in your Memoturn console to reply.`,
      quote: excerpt,
      ...(link ? { action: { label: `View the ${kind}`, url: link } } : {}),
      footer: "Don't want these? Turn off mention email in Settings → Notifications.",
    });

    const results = await Promise.all(targets.map((m) => sendEmail({ to: m.email, subject, text, html })));
    return results.filter(Boolean).length;
  } catch {
    return 0; // best-effort: never let a notification failure surface to the commenter
  }
}
