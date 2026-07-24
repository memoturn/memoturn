import { prisma } from "@memoturn/db";
import { deleteBlobPrefixOlderThan } from "@memoturn/db/blob";
import { getSandboxQueue } from "@memoturn/db/queue";
import { telemetry } from "@memoturn/telemetry";
import { generateDemoBatches } from "./demodata.js";
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
    // `viewer` is read-only (every mutating route is denyIfReadOnly-gated), which is what
    // keeps a public sandbox from ingesting, spending on the playground, or minting keys.
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
 * visitor — nothing to do).
 *
 * The organization is created with raw Prisma rather than the Better Auth org API (which
 * needs a request/Origin context we don't have inside a database hook), so the default
 * project is created explicitly here — the `afterCreateOrganization` hook won't fire.
 */
export async function provisionSandboxForUser(userId: string, email: string): Promise<string | null> {
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
  await getSandboxQueue().add("seed", { organizationId, projectId });
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
 * Seed a sandbox's project with generated telemetry. Submits through the normal ingest
 * path (`submitBatch` → blob + queue → worker), so the demo data exercises the real
 * pipeline — including cost computation — exactly like customer traffic.
 */
export async function seedSandbox(organizationId: string, projectId: string): Promise<void> {
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
    await prisma.demoSandbox.updateMany({
      where: { organizationId },
      data: { status: "READY", seededAt: new Date(), error: "" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.demoSandbox.updateMany({
      where: { organizationId },
      data: { status: "FAILED", error: message.slice(0, 500) },
    });
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
