import { prisma } from "@memoturn/db";
import { purgeProjectData } from "./lifecycle.js";

const slugify = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    // Runs are already collapsed to a single "-", so a non-quantified trim suffices (avoids polynomial backtracking).
    .replace(/^-/, "")
    .replace(/-$/, "")
    .slice(0, 48) || "project";

type ProjectInfo = { id: string; name: string; slug: string; organization: string };

const toInfo = (p: { id: string; name: string; slug: string; organization: { name: string } }): ProjectInfo => ({
  id: p.id,
  name: p.name,
  slug: p.slug,
  organization: p.organization.name,
});

export async function createProject(organizationId: string, name: string): Promise<ProjectInfo> {
  const base = slugify(name);
  // Slug is unique per org — retry with a numeric suffix on collision.
  for (let attempt = 0; ; attempt++) {
    const slug = attempt === 0 ? base : `${base}-${attempt + 1}`;
    try {
      const p = await prisma.project.create({
        data: { organizationId, name, slug },
        include: { organization: { select: { name: true } } },
      });
      return toInfo(p);
    } catch (e) {
      const unique = e instanceof Error && "code" in e && (e as { code?: string }).code === "P2002";
      if (!unique || attempt >= 8) throw e;
    }
  }
}

export async function renameProject(projectId: string, name: string): Promise<ProjectInfo> {
  const p = await prisma.project.update({
    where: { id: projectId },
    data: { name },
    include: { organization: { select: { name: true } } },
  });
  return toInfo(p);
}

/**
 * Delete a project: Postgres rows cascade from Project; the telemetry store AND every blob
 * object the project owns (raw event log, offloaded payloads, media) are purged via
 * `purgeProjectData` — the RetentionPolicy cascades away with the project, so nothing
 * would ever sweep those prefixes otherwise. The last project in an organization cannot be
 * deleted — every org keeps at least one project so sessions always resolve somewhere.
 */
export async function deleteProject(projectId: string): Promise<{ name: string; organizationId: string }> {
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { name: true, organizationId: true },
  });
  const siblings = await prisma.project.count({ where: { organizationId: project.organizationId } });
  if (siblings <= 1) throw new Error("cannot delete the last project in an organization");
  await prisma.project.delete({ where: { id: projectId } });
  // Best-effort and logged inside: orphaned telemetry rows are unreachable (every query is
  // project-scoped) and merge-on-write tables tolerate a later manual purge; blob leftovers
  // are visible in the log so an operator can re-run the purge.
  await purgeProjectData(projectId);
  return project;
}
