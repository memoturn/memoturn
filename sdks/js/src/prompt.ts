import type { Memoturn } from "./client.js";

export interface CompiledPrompt {
  name: string;
  version: number;
  type: "TEXT" | "CHAT";
  content: unknown;
  config: Record<string, unknown>;
}

/**
 * Fetch a deployed prompt by name + channel (default "production"). If the channel is running
 * an A/B split, pass `bucketKey` (a stable session/user id) to stick this caller to one arm
 * across resolves — the returned `version` is what you stamp on the resulting generation.
 */
export async function getPrompt(
  client: Pick<Memoturn, never> & { baseUrl?: string; publicKey?: string; secretKey?: string },
  name: string,
  options: { channel?: string; bucketKey?: string } = {},
): Promise<CompiledPrompt> {
  const baseUrl = (client.baseUrl ?? process.env.MEMOTURN_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const publicKey = client.publicKey ?? process.env.MEMOTURN_PUBLIC_KEY ?? "";
  const secretKey = client.secretKey ?? process.env.MEMOTURN_SECRET_KEY ?? "";
  const auth = Buffer.from(`${publicKey}:${secretKey}`).toString("base64");
  const channel = options.channel ?? "production";

  const params = new URLSearchParams({ channel });
  if (options.bucketKey) params.set("bucketKey", options.bucketKey);
  const res = await fetch(`${baseUrl}/v1/prompts/${encodeURIComponent(name)}?${params.toString()}`, {
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
