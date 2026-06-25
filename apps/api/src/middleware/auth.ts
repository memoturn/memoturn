import { auth, authenticateKeys, parseBasicAuth, resolveDefaultProjectForUser } from "@memoturn/server";
import type { Context, Next } from "hono";

/**
 * Hono middleware that authenticates a request two ways and resolves a projectId:
 *  1. API key (Basic auth, publicKey:secretKey) — for SDKs / programmatic access.
 *  2. Better Auth session cookie — for the dashboard; resolves the user's default project.
 * Either path stashes projectId on the context for downstream handlers.
 */
export async function requireAuth(c: Context<{ Variables: { projectId: string } }>, next: Next) {
  const creds = parseBasicAuth(c.req.header("authorization"));
  if (creds) {
    const ctx = await authenticateKeys(creds.publicKey, creds.secretKey);
    if (!ctx) return c.json({ error: "unauthorized" }, 401);
    c.set("projectId", ctx.projectId);
    return next();
  }

  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: "unauthorized" }, 401);

  const projectId = await resolveDefaultProjectForUser(session.user.id);
  if (!projectId) return c.json({ error: "no accessible project" }, 403);

  c.set("projectId", projectId);
  return next();
}
