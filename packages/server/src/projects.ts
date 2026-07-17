import { prisma } from "@memoturn/db";
import { telemetry } from "@memoturn/telemetry";

const slugify = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
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
 * Delete a project: Postgres rows cascade from Project; telemetry rows in the
 * analytical store are purged best-effort (the raw blob event log ages out via
 * retention). The last project in an organization cannot be deleted — every org
 * keeps at least one project so sessions always resolve somewhere.
 */
export async function deleteProject(projectId: string): Promise<{ name: string; organizationId: string }> {
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { name: true, organizationId: true },
  });
  const siblings = await prisma.project.count({ where: { organizationId: project.organizationId } });
  if (siblings <= 1) throw new Error("cannot delete the last project in an organization");
  await prisma.project.delete({ where: { id: projectId } });
  try {
    await telemetry().deleteProjectData(projectId);
  } catch (e) {
    // Best-effort: orphaned telemetry rows are unreachable (every query is
    // project-scoped) and merge-on-write tables tolerate a later manual purge.
    console.error(JSON.stringify({ msg: "project.delete telemetry purge failed", projectId, error: String(e) }));
  }
  return project;
}
