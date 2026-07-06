import { prisma } from "@memoturn/db";
import { decryptSecret, encryptSecret, maskSecret, type Provider } from "@memoturn/llm";

/**
 * Per-project LLM provider connections. API keys are encrypted at rest (AES-256-GCM)
 * and only ever returned masked. Key resolution falls back to env vars so a single
 * dev key can serve all projects; the "mock" provider needs no key.
 */
export async function createProviderConnection(projectId: string, provider: string, apiKey: string) {
  const conn = await prisma.providerConnection.upsert({
    where: { projectId_provider: { projectId, provider } },
    update: { encryptedKey: encryptSecret(apiKey) },
    create: { projectId, provider, encryptedKey: encryptSecret(apiKey) },
  });
  return { provider: conn.provider, masked: maskSecret(apiKey), createdAt: conn.createdAt.toISOString() };
}

export async function listProviderConnections(projectId: string) {
  const conns = await prisma.providerConnection.findMany({ where: { projectId }, orderBy: { provider: "asc" } });
  return conns.map((c) => {
    let masked = "…";
    try {
      masked = maskSecret(decryptSecret(c.encryptedKey));
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

const ENV_KEYS: Record<string, string | undefined> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};

/** Resolve a usable API key for a provider: stored connection first, then env. */
export async function resolveProviderKey(projectId: string, provider: Provider): Promise<string | undefined> {
  if (provider === "mock") return undefined;
  const conn = await prisma.providerConnection.findUnique({
    where: { projectId_provider: { projectId, provider } },
  });
  if (conn) {
    try {
      return decryptSecret(conn.encryptedKey);
    } catch {
      // A stored key that won't decrypt (e.g. ENCRYPTION_KEY was rotated) must NOT silently
      // fall back to the operator's shared env key — that would mis-attribute cost/traffic.
      // Surface it so the project owner re-enters the key.
      console.error(
        JSON.stringify({
          level: "error",
          scope: "providers.resolveKey",
          provider,
          message: "stored key undecryptable",
        }),
      );
      throw new Error(`stored ${provider} key could not be decrypted — re-enter it in provider settings`);
    }
  }
  const envName = ENV_KEYS[provider];
  return envName ? process.env[envName] : undefined;
}
