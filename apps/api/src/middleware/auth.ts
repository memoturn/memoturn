import { authenticateKeys, parseBasicAuth } from "@memoturn/server";
import type { Context, Next } from "hono";

/**
 * Hono middleware: authenticate the request's Basic auth (publicKey:secretKey) and
 * stash the resolved projectId on the context. Runtime-agnostic — works the same on
 * Node and Bun.
 */
export async function requireApiKey(c: Context<{ Variables: { projectId: string } }>, next: Next) {
  const creds = parseBasicAuth(c.req.header("authorization"));
  if (!creds) return c.json({ error: "unauthorized" }, 401);

  const auth = await authenticateKeys(creds.publicKey, creds.secretKey);
  if (!auth) return c.json({ error: "unauthorized" }, 401);

  c.set("projectId", auth.projectId);
  await next();
}
