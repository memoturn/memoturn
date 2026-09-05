import { newId } from "@memoturn/core";
import { prisma } from "@memoturn/db";
import { deleteBlobPrefixOlderThan } from "@memoturn/db/blob";
import { getSandboxQueue } from "@memoturn/db/queue";
import { telemetry } from "@memoturn/telemetry";
import { sendDemoMagicLink } from "./betterauth.js";
import { seedSandboxEntities } from "./demo-entities.js";
import { generateDemoBatches } from "./demodata.js";
import { runProjectionForProject } from "./embeddings.js";
import { submitBatch } from "./ingest.js";

/**
 * Public-demo sandboxes (DEMO_MODE only — every install has this off by default).
 *
 * A visitor signs in with an email (magic link), and gets a throwaway tenant of their
 * own: organization + project + a read-only membership, pre-seeded with generated
 * telemetry so the product has something to show. The sandbox is hard-deleted after
 * `DEMO_TTL_DAYS` by the worker's `sandbox-prune` cron.
 *
 * Provisioning runs from Better Auth's `session.create.before` hook, which is the one
 * place guaranteed to execute before the session lands — so the visitor never sees the
 * "create an organization" onboarding bounce.
 */

export function demoModeEnabled(): boolean {
  return process.env.DEMO_MODE === "true" || process.env.DEMO_MODE === "1";
}

function intEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function demoConfig() {
  return {
    ttlDays: intEnv("DEMO_TTL_DAYS", 7),
    maxSandboxes: intEnv("DEMO_MAX_SANDBOXES", 500),
    seedDays: intEnv("DEMO_SEED_DAYS", 3),
    seedTracesPerDay: intEnv("DEMO_SEED_TRACES_PER_DAY", 15),
    // How long the "finalize" job waits after seeding before it seeds entities + the 3D
    // projection and marks the sandbox READY. The delay lets the async ingest pipeline drain
    // the seed batches into the telemetry store first, so experiments/review-items reference
    // real traces and the embedding projection has vectors to reduce.
    finalizeDelayMs: intEnv("DEMO_FINALIZE_DELAY_MS", 120_000),
    // `viewer` is read-only (every mutating route is denyIfReadOnly-gated — including the
    // playground/assistant routes, which spend the operator's provider key even though they
    // don't mutate), which is what keeps a public sandbox from ingesting, spending on LLM
    // calls, or minting keys. `scripts/check-rbac.ts` enforces the gate in CI.
    memberRole: process.env.DEMO_MEMBER_ROLE || "viewer",
  };
}

export class DemoCapacityError extends Error {
  constructor() {
    super("demo is at capacity");
    this.name = "DemoCapacityError";
  }
}

/**
 * Provision a sandbox for a brand-new demo visitor. Returns the organization id to use
 * as the session's active org, or null when the user already belongs to one (a returning
 * visitor — nothing to do). Idempotent: the member check makes it a safe fallback for the
 * session-create hook even after the public /v1/demo/start endpoint already provisioned.
 *
 * The organization is created with raw Prisma rather than the Better Auth org API (which
 * needs a request/Origin context we don't have inside a database hook), so the default
 * project is created explicitly here — the `afterCreateOrganization` hook won't fire.
 *
 * `opts.deferMagicLink` is the email-after-ready path (change 2): the visitor is NOT yet
 * signed in, so the sign-in link must be emailed only once the sandbox finishes seeding.
 * We thread the email + a sendMagicLink flag through the seed job so the worker's finalize
 * phase sends it. The legacy session-hook path leaves it off (the visitor is already in).
 */
export async function provisionSandboxForUser(
  userId: string,
  email: string,
  opts: { deferMagicLink?: boolean } = {},
): Promise<string | null> {
  const existing = await prisma.member.findFirst({ where: { userId }, select: { organizationId: true } });
  if (existing) return null;

  const cfg = demoConfig();
  const active = await prisma.demoSandbox.count({ where: { expiresAt: { gt: new Date() } } });
  if (active >= cfg.maxSandboxes) throw new DemoCapacityError();

  const expiresAt = new Date(Date.now() + cfg.ttlDays * 86_400_000);
  const { organizationId, projectId } = await prisma.$transaction(async (tx) => {
    // Organization.slug is globally unique — derive it from the org's own cuid so
    // concurrent signups can never collide.
    const org = await tx.organization.create({
      data: { name: "Demo Sandbox", slug: `demo-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}` },
    });
    const project = await tx.project.create({
      data: { organizationId: org.id, name: "Demo Project", slug: "default" },
    });
    await tx.member.create({ data: { organizationId: org.id, userId, role: cfg.memberRole } });
    await tx.demoSandbox.create({ data: { organizationId: org.id, userId, email, expiresAt } });
    return { organizationId: org.id, projectId: project.id };
  });

  // Enqueue AFTER the transaction commits so the worker can never read a half-built tenant.
  await getSandboxQueue().add("seed", {
    organizationId,
    projectId,
    phase: "seed",
    ...(opts.deferMagicLink ? { email, sendMagicLink: true } : {}),
  });
  return organizationId;
}

/** Sandbox status for the console's "preparing your sandbox" screen. */
export async function getSandboxForUser(userId: string) {
  const s = await prisma.demoSandbox.findFirst({ where: { userId }, orderBy: { createdAt: "desc" } });
  if (!s) return null;
  return {
    status: s.status,
    error: s.error,
    expiresAt: s.expiresAt.toISOString(),
    seededAt: s.seededAt?.toISOString() ?? null,
  };
}

/**
 * Phase 1 of two. Seed a sandbox's project with generated telemetry, then enqueue a DELAYED
 * "finalize" job (change 1). Submits through the normal ingest path (`submitBatch` → blob +
 * queue → worker), so the demo data exercises the real pipeline — including cost computation
 * — exactly like customer traffic.
 *
 * Deliberately does NOT seed entities, run the projection, or mark READY here: those all need
 * the telemetry to have DRAINED into the store (ingest is async), which it hasn't yet. The
 * finalize job, delayed by `DEMO_FINALIZE_DELAY_MS`, does that work once the store has caught
 * up. The sandbox stays SEEDING until then. `opts` is threaded straight to the finalize job so
 * the email-after-ready flow (change 2) sends the magic link at the right moment.
 */
export async function seedSandbox(
  organizationId: string,
  projectId: string,
  opts: { email?: string; sendMagicLink?: boolean } = {},
): Promise<void> {
  const cfg = demoConfig();
  await prisma.demoSandbox.updateMany({ where: { organizationId }, data: { status: "SEEDING" } });
  try {
    const batches = generateDemoBatches({
      days: cfg.seedDays,
      tracesPerDay: cfg.seedTracesPerDay,
      // Per-sandbox seed → every visitor sees a plausibly different dataset.
      seed: `sandbox-${organizationId}`,
    });
    for (const batch of batches) await submitBatch(projectId, { batch });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.demoSandbox.updateMany({
      where: { organizationId },
      data: { status: "FAILED", error: message.slice(0, 500) },
    });
    throw err;
  }

  // Hand off to the delayed finalize job (after the batches are submitted, so a submit failure
  // above marks FAILED without ever scheduling finalize). The delay lets ingest drain first.
  await getSandboxQueue().add(
    "finalize",
    {
      organizationId,
      projectId,
      phase: "finalize",
      ...(opts.email ? { email: opts.email } : {}),
      ...(opts.sendMagicLink ? { sendMagicLink: true } : {}),
    },
    { delay: cfg.finalizeDelayMs },
  );
}

/**
 * Phase 2 of two (change 1). Runs after the seed batches have drained into the telemetry
 * store: seeds the remaining product entities (which reference real trace ids) and the 3D
 * embedding projection, then marks the sandbox READY. Every step is best-effort — a cosmetic
 * failure must NEVER leave a sandbox stuck in SEEDING, so each is wrapped and the function
 * always reaches the READY update. Idempotent + retry-safe.
 *
 * When `opts.sendMagicLink` is set (email-after-ready, change 2), the deferred sign-in link is
 * emailed here — but only once: the send is claimed atomically via `DemoSandbox.linkSentAt` so
 * a BullMQ retry can never email the visitor twice, and the claim is released on send failure
 * so a genuine retry can try again.
 */
export async function finalizeSandbox(
  organizationId: string,
  projectId: string,
  opts: { email?: string; sendMagicLink?: boolean } = {},
): Promise<void> {
  try {
    await seedSandboxEntities(projectId);
  } catch (err) {
    console.error("[demo] finalize seedSandboxEntities failed:", err instanceof Error ? err.message : err);
  }
  try {
    await runProjectionForProject(projectId);
  } catch (err) {
    console.error("[demo] finalize runProjectionForProject failed:", err instanceof Error ? err.message : err);
  }

  if (opts.sendMagicLink && opts.email) {
    try {
      // Claim the send atomically (linkSentAt: null → now) so concurrent/retried finalize jobs
      // can never both send. count > 0 means THIS call won the claim.
      const claim = await prisma.demoSandbox.updateMany({
        where: { organizationId, linkSentAt: null },
        data: { linkSentAt: new Date() },
      });
      if (claim.count > 0) {
        try {
          await sendDemoMagicLink(opts.email);
        } catch (sendErr) {
          console.error(
            "[demo] finalize sendDemoMagicLink failed:",
            sendErr instanceof Error ? sendErr.message : sendErr,
          );
          // Release the claim so a subsequent finalize retry can retry the send.
          await prisma.demoSandbox
            .updateMany({ where: { organizationId }, data: { linkSentAt: null } })
            .catch(() => {});
        }
      }
    } catch (err) {
      console.error("[demo] finalize magic-link claim failed:", err instanceof Error ? err.message : err);
    }
  }

  // Always reach READY — the sandbox must never be stranded in SEEDING by a cosmetic failure.
  await prisma.demoSandbox.updateMany({
    where: { organizationId },
    data: { status: "READY", seededAt: new Date(), error: "" },
  });
}

/**
 * Public pre-provision entrypoint (change 2) for the console's `/demo` email form. Unlike the
 * legacy flow (email sent immediately, provisioning in the session hook), this provisions the
 * sandbox FIRST and defers the sign-in link until the sandbox is READY, so the visitor doesn't
 * stare at a "preparing" screen through the whole seed.
 *
 * Find-or-creates the user by email (unverified — Better Auth's magic-link verify signs in this
 * existing user rather than duplicating it, and flips emailVerified true then). A returning
 * visitor who already has a membership just gets a fresh link. Otherwise provisioning enqueues
 * the seed job with the deferred-magic-link flag and returns "seeding".
 */
export async function startDemoSandbox(email: string): Promise<{ status: "seeding" | "ready" | "capacity" }> {
  const normalized = email.trim().toLowerCase();
  // Minimal shape check — the real gate is deliverability (the link only works if the address
  // receives it). Better Auth applies its own validation on verify. The endpoint is PUBLIC, so
  // the pattern must be backtracking-free (no ReDoS): the domain labels exclude `.`, so `\.`
  // is the only thing that can match a dot — no overlapping quantifiers. Plus a hard length cap.
  if (normalized.length > 254 || !/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(normalized))
    throw new Error("invalid email");

  let user = await prisma.user.findUnique({ where: { email: normalized }, select: { id: true } });
  if (!user) {
    // Create unverified so magic-link verify (which flips emailVerified true) treats this as a
    // sign-in of an existing user, not a new signup. id is app-generated (User.id has no default).
    user = await prisma.user.create({
      data: { id: newId(), name: "", email: normalized, emailVerified: false },
      select: { id: true },
    });
  }

  const member = await prisma.member.findFirst({ where: { userId: user.id }, select: { id: true } });
  if (member) {
    // Returning visitor — the sandbox already exists. Just email a fresh sign-in link.
    await sendDemoMagicLink(normalized);
    return { status: "ready" };
  }

  try {
    await provisionSandboxForUser(user.id, normalized, { deferMagicLink: true });
    return { status: "seeding" };
  } catch (err) {
    if (err instanceof DemoCapacityError) return { status: "capacity" };
    throw err;
  }
}

/**
 * Hard-delete every expired sandbox. Order matters: telemetry and blob live OUTSIDE the
 * Prisma cascade, so they must be purged while the project rows still exist. Deleting the
 * organization then cascades the whole Prisma tenant, and the visitor's user row goes last
 * so the same email can start fresh.
 *
 * Per-sandbox failures are logged and skipped rather than aborting the sweep (matching
 * applyAllRetention).
 */
export async function pruneExpiredSandboxes(now: Date = new Date()): Promise<{ deleted: number; failed: number }> {
  const expired = await prisma.demoSandbox.findMany({
    where: { expiresAt: { lt: now } },
    select: { id: true, organizationId: true, userId: true },
  });
  let deleted = 0;
  let failed = 0;

  for (const sandbox of expired) {
    try {
      const projects = await prisma.project.findMany({
        where: { organizationId: sandbox.organizationId },
        select: { id: true },
      });
      for (const { id: projectId } of projects) {
        await telemetry().deleteProjectData(projectId);
        // A cutoff in the future means "everything under this prefix" — reusing the
        // retention sweep's paginated, batched delete rather than a near-duplicate.
        const everything = new Date(Date.now() + 86_400_000);
        for (const prefix of ["events", "payloads", "media"]) {
          await deleteBlobPrefixOlderThan(`${prefix}/${projectId}/`, everything).catch(() => {});
        }
      }
      // Cascades projects + every project-scoped row, members, invitations, and the
      // DemoSandbox row itself.
      await prisma.organization.delete({ where: { id: sandbox.organizationId } });
      // Demo users exist only for their sandbox; removing it frees the email for reuse.
      await prisma.user.delete({ where: { id: sandbox.userId } }).catch(() => {});
      deleted++;
    } catch {
      failed++;
    }
  }
  return { deleted, failed };
}
