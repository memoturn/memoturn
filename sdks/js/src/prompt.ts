import type { Memoturn } from "./client.js";

export interface CompiledPrompt {
  name: string;
  version: number;
  type: "TEXT" | "CHAT";
  content: unknown;
  config: Record<string, unknown>;
}

/**
 * Fetch a deployed prompt by name + channel (default "production"). Phase 4 adds a
 * zero-latency in-memory cache; for now this is a thin GET against the read API.
 */
export async function getPrompt(
  client: Pick<Memoturn, never> & { baseUrl?: string; publicKey?: string; secretKey?: string },
  name: string,
  options: { channel?: string } = {},
): Promise<CompiledPrompt> {
  const baseUrl = (client.baseUrl ?? process.env.MEMOTURN_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const publicKey = client.publicKey ?? process.env.MEMOTURN_PUBLIC_KEY ?? "";
  const secretKey = client.secretKey ?? process.env.MEMOTURN_SECRET_KEY ?? "";
  const auth = Buffer.from(`${publicKey}:${secretKey}`).toString("base64");
  const channel = options.channel ?? "production";

  const res = await fetch(`${baseUrl}/v1/prompts/${encodeURIComponent(name)}?channel=${encodeURIComponent(channel)}`, {
    headers: { authorization: `Basic ${auth}` },
  });
  if (!res.ok) throw new Error(`getPrompt failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as CompiledPrompt;
}

type ChatMessage = { role: string; content: string };

/**
 * Substitute `{{variable}}` placeholders in a prompt's content with `vars`. Works for
 * TEXT prompts (string) and CHAT prompts (array of {role, content}); unknown
 * placeholders are left untouched. Returns the compiled content ready to send to a model.
 */
export function compilePrompt(
  prompt: CompiledPrompt,
  vars: Record<string, string | number> = {},
): string | ChatMessage[] {
  const fill = (text: string): string =>
    text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, key: string) => (key in vars ? String(vars[key]) : match));

  if (prompt.type === "CHAT" && Array.isArray(prompt.content)) {
    return (prompt.content as ChatMessage[]).map((m) => ({ ...m, content: fill(String(m.content ?? "")) }));
  }
  return fill(String(prompt.content ?? ""));
}
