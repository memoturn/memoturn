import type { PromptArmScore, PromptVersionCost } from "@memoturn/contracts";
import { type PromptType, prisma } from "@memoturn/db";
import { telemetry } from "@memoturn/telemetry";
import {
  composePrompt,
  extractPlaceholders,
  extractPromptRefs,
  fillPrompt,
  PromptCompositionError,
  type PromptRef,
  type StoredMessage,
  validatePromptBody,
} from "./prompt-composition.js";

/**
 * Prompt management. Each save creates a new immutable version; "channels" are
 * movable deployment pointers (production / latest / custom) that the SDK's
 * getPrompt() resolves. The "latest" channel always tracks the newest version.
 *
 * A channel can run a weighted A/B split: `version` stays the live/control arm and
 * `splitWeight`% of resolves route to `splitVersion` (the challenger), sticky per bucketing
 * key. Rollback clears the split (optionally promoting the challenger to the live version).
 */

interface PromptChannelInfo {
  label: string;
  version: number;
  splitVersion: number | null;
  splitWeight: number;
  status: string;
}

const mapChannel = (c: {
  label: string;
  version: number;
  splitVersion: number | null;
  splitWeight: number;
  status: string;
}): PromptChannelInfo => ({
  label: c.label,
  version: c.version,
  splitVersion: c.splitVersion,
  splitWeight: c.splitWeight,
  status: c.status,
});

/** Deterministic bucket 0–99 from a key (FNV-1a) — sticky A/B assignment; same key → same arm. */
export function bucketOf(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 100;
}

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
  /** Placeholder slots still awaiting a message list (empty once compiled). */
  placeholders: string[];
}

/** Resolve one reference to the referenced version's raw stored body. */
function refResolver(projectId: string) {
  return async (ref: PromptRef) => {
    const target = await prisma.prompt.findUnique({
      where: { projectId_name: { projectId, name: ref.name } },
      include: { channels: true },
    });
    if (!target) return null;
    const version =
      ref.version ?? target.channels.find((c) => c.label === (ref.label ?? "production"))?.version ?? null;
    if (version == null) return null;
    const row = await prisma.promptVersion.findUnique({
      where: { promptId_version: { promptId: target.id, version } },
    });
    return row ? { type: row.type as "TEXT" | "CHAT", content: row.content as unknown } : null;
  };
}

export async function createPromptVersion(projectId: string, input: CreatePromptInput): Promise<CompiledPrompt> {
  const type = input.type ?? "TEXT";
  // Fail at SAVE time: a malformed body or a cycle should be a 400 the author sees now, not a
  // runtime failure in someone's request path later.
  validatePromptBody(input.content, type);
  const refs = extractPromptRefs(input.content);
  if (refs.length > 0) {
    // Self-reference first: on a prompt's FIRST save it doesn't exist yet, so composing would
    // report a confusing "not found" for what is really a cycle.
    if (refs.some((r) => r.name === input.name)) {
      throw new PromptCompositionError(`circular prompt reference: "${input.name}" includes itself`);
    }
    // Then compose against the current registry, with the channels THIS save will occupy
    // blocked — otherwise a reference back to this prompt resolves the old body and the cycle
    // only appears once the save lands.
    const willOccupy = new Set(["latest", ...(input.labels ?? [])].map((label) => `${input.name}@${label}`));
    await composePrompt(input.content, refResolver(projectId), [], willOccupy);
  }

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
      type,
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
    // The RAW body, references intact — this is the author's view of what they just saved.
    content: created.content,
    config: created.config as Record<string, unknown>,
    placeholders: extractPlaceholders(created.content),
  };
}

export interface PromptListItem {
  name: string;
  folder: string;
  versions: number;
  latestVersion: number;
  channels: PromptChannelInfo[];
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
    channels: p.channels.map(mapChannel),
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
    channels: p.channels.map(mapChannel),
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

/**
 * Resolve a deployed prompt by name + channel (default "production"). When the channel is
 * running an A/B experiment, `bucketKey` (a session/user id) sticks a caller to one arm;
 * with no key the split is random per call. The returned `version` is stamped onto the
 * caller's generations, which is what attributes each arm's cost/scores.
 */
export async function resolvePrompt(
  projectId: string,
  name: string,
  channel = "production",
  bucketKey?: string,
): Promise<CompiledPrompt | null> {
  const prompt = await prisma.prompt.findUnique({
    where: { projectId_name: { projectId, name } },
    include: { channels: true },
  });
  if (!prompt) return null;

  const channelRow = prompt.channels.find((c) => c.label === channel);
  if (!channelRow) return null;

  // A/B: route splitWeight% of resolves to the challenger, sticky per bucketKey.
  let chosen = channelRow.version;
  if (channelRow.status === "experiment" && channelRow.splitWeight > 0 && channelRow.splitVersion != null) {
    const bucket = bucketKey ? bucketOf(bucketKey) : Math.floor(Math.random() * 100);
    if (bucket < channelRow.splitWeight) chosen = channelRow.splitVersion;
  }

  const version = await prisma.promptVersion.findUnique({
    where: { promptId_version: { promptId: prompt.id, version: chosen } },
  });
  if (!version) return null;

  // Runtime gets the COMPOSED body — updating a shared prompt updates everything that includes
  // it. Authors still see the raw body with its references intact via the detail endpoint.
  const content = await composePrompt(version.content as unknown, refResolver(projectId), [
    `${prompt.name}@${channel}`,
  ]);

  return {
    name: prompt.name,
    version: version.version,
    type: version.type,
    content,
    config: version.config as Record<string, unknown>,
    placeholders: extractPlaceholders(content),
  };
}

/**
 * Resolve a prompt and fill it in one call: composition expanded, `{{variables}}` substituted,
 * and placeholder slots replaced with the caller's message lists. Doing this server-side means
 * every language gets placeholders today without three SDK releases.
 */
export async function compilePrompt(
  projectId: string,
  name: string,
  opts: {
    channel?: string;
    bucketKey?: string;
    variables?: Record<string, unknown>;
    placeholders?: Record<string, StoredMessage[]>;
  } = {},
): Promise<CompiledPrompt | null> {
  const resolved = await resolvePrompt(projectId, name, opts.channel ?? "production", opts.bucketKey);
  if (!resolved) return null;
  const content = fillPrompt(resolved.content, { variables: opts.variables, placeholders: opts.placeholders });
  // Every slot is either filled or dropped by fillPrompt, so the compiled body has none left.
  return { ...resolved, content, placeholders: [] };
}

/** Start a weighted A/B split on a channel: route `splitWeight`% to `splitVersion` (challenger). */
export async function startExperiment(
  projectId: string,
  name: string,
  input: { channel: string; splitVersion: number; splitWeight: number },
): Promise<{ channel: string; version: number; splitVersion: number; splitWeight: number } | null> {
  const prompt = await prisma.prompt.findUnique({ where: { projectId_name: { projectId, name } } });
  if (!prompt) return null;
  const channel = await prisma.promptChannel.findUnique({
    where: { promptId_label: { promptId: prompt.id, label: input.channel } },
  });
  if (!channel) return null;
  const challenger = await prisma.promptVersion.findUnique({
    where: { promptId_version: { promptId: prompt.id, version: input.splitVersion } },
  });
  if (!challenger || input.splitVersion === channel.version) return null; // challenger must exist and differ from control
  const weight = Math.max(1, Math.min(99, Math.floor(input.splitWeight)));
  await prisma.promptChannel.update({
    where: { promptId_label: { promptId: prompt.id, label: input.channel } },
    data: { splitVersion: input.splitVersion, splitWeight: weight, status: "experiment" },
  });
  return { channel: input.channel, version: channel.version, splitVersion: input.splitVersion, splitWeight: weight };
}

/**
 * Stop an experiment on a channel and clear the split. `promote: true` makes the challenger the
 * live version (declare it the winner); otherwise the control version stays live.
 */
export async function stopExperiment(
  projectId: string,
  name: string,
  input: { channel: string; promote?: boolean },
): Promise<{ channel: string; version: number } | null> {
  const prompt = await prisma.prompt.findUnique({ where: { projectId_name: { projectId, name } } });
  if (!prompt) return null;
  const channel = await prisma.promptChannel.findUnique({
    where: { promptId_label: { promptId: prompt.id, label: input.channel } },
  });
  if (!channel) return null;
  const winner = input.promote && channel.splitVersion != null ? channel.splitVersion : channel.version;
  await prisma.promptChannel.update({
    where: { promptId_label: { promptId: prompt.id, label: input.channel } },
    data: { version: winner, splitVersion: null, splitWeight: 0, status: "stable" },
  });
  return { channel: input.channel, version: winner };
}

/** Per-arm quality: score means grouped by the prompt version that produced them. */
export async function getPromptArmScores(projectId: string, name: string, days = 30): Promise<PromptArmScore[]> {
  return telemetry().scoresByPromptVersion(projectId, name, { days });
}
