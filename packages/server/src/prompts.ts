import type { PromptVersionCost } from "@memoturn/contracts";
import { type PromptType, prisma } from "@memoturn/db";
import { telemetry } from "@memoturn/telemetry";

/**
 * Prompt management. Each save creates a new immutable version; "channels" are
 * movable deployment pointers (production / latest / custom) that the SDK's
 * getPrompt() resolves. The "latest" channel always tracks the newest version.
 */

export interface CreatePromptInput {
  name: string;
  type?: PromptType; // TEXT | CHAT
  content: unknown; // string for TEXT, message array for CHAT
  config?: Record<string, unknown>;
  folder?: string;
  labels?: string[]; // channels to point at this new version (besides "latest")
}

export interface CompiledPrompt {
  name: string;
  version: number;
  type: PromptType;
  content: unknown;
  config: Record<string, unknown>;
}

export async function createPromptVersion(projectId: string, input: CreatePromptInput): Promise<CompiledPrompt> {
  const prompt = await prisma.prompt.upsert({
    where: { projectId_name: { projectId, name: input.name } },
    update: { folder: input.folder ?? undefined },
    create: { projectId, name: input.name, folder: input.folder ?? "" },
  });

  const last = await prisma.promptVersion.findFirst({
    where: { promptId: prompt.id },
    orderBy: { version: "desc" },
  });
  const version = (last?.version ?? 0) + 1;

  const created = await prisma.promptVersion.create({
    data: {
      promptId: prompt.id,
      version,
      type: input.type ?? "TEXT",
      content: input.content as object,
      config: (input.config ?? {}) as object,
    },
  });

  // "latest" always tracks the newest version; plus any explicit labels.
  const labels = new Set(["latest", ...(input.labels ?? [])]);
  for (const label of labels) {
    await prisma.promptChannel.upsert({
      where: { promptId_label: { promptId: prompt.id, label } },
      update: { version },
      create: { promptId: prompt.id, label, version },
    });
  }

  return {
    name: prompt.name,
    version: created.version,
    type: created.type,
    content: created.content,
    config: created.config as Record<string, unknown>,
  };
}

export interface PromptListItem {
  name: string;
  folder: string;
  versions: number;
  latestVersion: number;
  channels: { label: string; version: number }[];
  updatedAt: string;
}

export async function listPrompts(projectId: string): Promise<PromptListItem[]> {
  const prompts = await prisma.prompt.findMany({
    where: { projectId },
    include: {
      channels: { orderBy: { label: "asc" } },
      versions: { orderBy: { version: "desc" }, take: 1 },
      _count: { select: { versions: true } },
    },
    orderBy: { name: "asc" },
  });

  return prompts.map((p) => ({
    name: p.name,
    folder: p.folder,
    versions: p._count.versions,
    latestVersion: p.versions[0]?.version ?? 0,
    channels: p.channels.map((c) => ({ label: c.label, version: c.version })),
    updatedAt: (p.versions[0]?.createdAt ?? p.createdAt).toISOString(),
  }));
}

export interface PromptDetail extends PromptListItem {
  allVersions: { version: number; type: PromptType; content: unknown; config: unknown; createdAt: string }[];
}

/** Spend attributed to each version of a prompt (telemetry rollup over observations). */
export async function getPromptVersionCosts(projectId: string, name: string, days = 30): Promise<PromptVersionCost[]> {
  return telemetry().costByPromptVersion(projectId, name, { days });
}

export async function getPromptDetail(projectId: string, name: string): Promise<PromptDetail | null> {
  const p = await prisma.prompt.findUnique({
    where: { projectId_name: { projectId, name } },
    include: { channels: { orderBy: { label: "asc" } }, versions: { orderBy: { version: "desc" } } },
  });
  if (!p) return null;

  return {
    name: p.name,
    folder: p.folder,
    versions: p.versions.length,
    latestVersion: p.versions[0]?.version ?? 0,
    channels: p.channels.map((c) => ({ label: c.label, version: c.version })),
    updatedAt: (p.versions[0]?.createdAt ?? p.createdAt).toISOString(),
    allVersions: p.versions.map((v) => ({
      version: v.version,
      type: v.type,
      content: v.content,
      config: v.config,
      createdAt: v.createdAt.toISOString(),
    })),
  };
}

/** Resolve a deployed prompt by name + channel (default "production"). */
export async function resolvePrompt(
  projectId: string,
  name: string,
  channel = "production",
): Promise<CompiledPrompt | null> {
  const prompt = await prisma.prompt.findUnique({
    where: { projectId_name: { projectId, name } },
    include: { channels: true },
  });
  if (!prompt) return null;

  const channelRow = prompt.channels.find((c) => c.label === channel);
  if (!channelRow) return null;

  const version = await prisma.promptVersion.findUnique({
    where: { promptId_version: { promptId: prompt.id, version: channelRow.version } },
  });
  if (!version) return null;

  return {
    name: prompt.name,
    version: version.version,
    type: version.type,
    content: version.content,
    config: version.config as Record<string, unknown>,
  };
}
