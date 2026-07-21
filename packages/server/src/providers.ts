import { prisma } from "@memoturn/db";
import { decryptSecret, encryptSecret, maskSecret, type Provider, type ProviderConfig } from "@memoturn/llm";
import { assertPublicUrl } from "./net.js";

/**
 * Per-project LLM provider connections. Credentials are encrypted at rest (AES-256-GCM)
 * as a JSON config blob `{ apiKey?, baseUrl?, region? }` — a single column serves
 * single-key providers (anthropic/openai/gemini) and multi-field ones (bedrock needs a
 * region, azure/openai_compatible a baseUrl) alike. Keys are only ever returned masked.
 * Resolution falls back to env vars so a single dev key can serve all projects; the
 * "mock" provider needs no key.
 */

/** Env fallback for the primary API key, per provider. */
const ENV_KEYS: Record<string, string | undefined> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  bedrock: "AWS_BEARER_TOKEN_BEDROCK",
  azure: "AZURE_API_KEY",
};

/**
 * Decode a stored `encryptedKey` into a config. Back-compat: legacy rows stored a bare
 * API-key string (pre config-blob); if the decrypted value isn't JSON, treat it as apiKey.
 */
function decodeConfig(encrypted: string): ProviderConfig {
  const raw = decryptSecret(encrypted);
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as ProviderConfig;
  } catch {
    // legacy bare-string key
  }
  return { apiKey: raw };
}

export async function createProviderConnection(projectId: string, provider: string, config: ProviderConfig) {
  const encryptedKey = encryptSecret(JSON.stringify(config));
  const conn = await prisma.providerConnection.upsert({
    where: { projectId_provider: { projectId, provider } },
    update: { encryptedKey },
    create: { projectId, provider, encryptedKey },
  });
  return { provider: conn.provider, masked: maskConfig(config), createdAt: conn.createdAt.toISOString() };
}

/** A safe display string for a config: masked apiKey, plus baseUrl/region if present. */
function maskConfig(config: ProviderConfig): string {
  const bits: string[] = [];
  if (config.apiKey) bits.push(maskSecret(config.apiKey));
  if (config.baseUrl) bits.push(config.baseUrl);
  if (config.region) bits.push(config.region);
  return bits.join(" · ") || "…";
}

export async function listProviderConnections(projectId: string) {
  const conns = await prisma.providerConnection.findMany({ where: { projectId }, orderBy: { provider: "asc" } });
  return conns.map((c) => {
    let masked = "…";
    try {
      masked = maskConfig(decodeConfig(c.encryptedKey));
    } catch {
      /* ignore */
    }
    return { provider: c.provider, masked, createdAt: c.createdAt.toISOString() };
  });
}

export async function deleteProviderConnection(projectId: string, provider: string) {
  await prisma.providerConnection.deleteMany({ where: { projectId, provider } });
  return { deleted: true };
}

/**
 * Resolve a usable provider config: stored connection first, then env fallback for the
 * API key. The "mock" provider needs none.
 */
export async function resolveProviderConfig(projectId: string, provider: Provider): Promise<ProviderConfig> {
  if (provider === "mock") return {};
  const conn = await prisma.providerConnection.findUnique({
    where: { projectId_provider: { projectId, provider } },
  });
  if (conn) {
    let config: ProviderConfig;
    try {
      config = decodeConfig(conn.encryptedKey);
    } catch {
      // A stored key that won't decrypt (e.g. ENCRYPTION_KEY was rotated) must NOT silently
      // fall back to the operator's shared env key — that would mis-attribute cost/traffic.
      // Surface it so the project owner re-enters the key.
      console.error(
        JSON.stringify({
          level: "error",
          scope: "providers.resolveConfig",
          provider,
          message: "stored config undecryptable",
        }),
      );
      throw new Error(`stored ${provider} config could not be decrypted — re-enter it in provider settings`);
    }
    // Re-validate the egress target at DISPATCH time: DNS can rebind between save and use, so a
    // baseUrl that was public when connected could now resolve to an internal address. Mirrors the
    // webhook write+dispatch double-check.
    if (config.baseUrl) await assertPublicUrl(config.baseUrl);
    return config;
  }
  const envName = ENV_KEYS[provider];
  const apiKey = envName ? process.env[envName] : undefined;
  return { apiKey };
}

/** Back-compat shim: resolve just the API key (callers that don't need baseUrl/region). */
export async function resolveProviderKey(projectId: string, provider: Provider): Promise<string | undefined> {
  return (await resolveProviderConfig(projectId, provider)).apiKey;
}
