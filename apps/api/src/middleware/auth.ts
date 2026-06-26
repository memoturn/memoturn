import { auth, authenticateKeys, getUserProjectAccess, parseBasicAuth, type WorkspaceRole } from "@memoturn/server";
import type { Context, Next } from "hono";

export type AuthVars = {
  projectId: string;
  role: WorkspaceRole;
  actor: string;
  userId: string;
  organizationId: string;
};

/**
 * Authenticates two ways and resolves the active project + role:
 *  1. API key (Basic auth) — SDK/programmatic; full access to its project (role OWNER).
 *  2. Better Auth session — dashboard; honors the `x-memoturn-project` header (project
 *     switcher) when the user has access, else their default project, with their role.
 */
export async function requireAuth(c: Context<{ Variables: AuthVars }>, next: Next) {
  const creds = parseBasicAuth(c.req.header("authorization"));
  if (creds) {
    const ctx = await authenticateKeys(creds.publicKey, creds.secretKey);
    if (!ctx) return c.json({ error: "unauthorized" }, 401);
    c.set("projectId", ctx.projectId);
    c.set("role", "OWNER");
    c.set("actor", `apikey:${creds.publicKey}`);
    c.set("userId", "");
    c.set("organizationId", "");
    return next();
  }

  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: "unauthorized" }, 401);

  const requested = c.req.header("x-memoturn-project") || undefined;
  const access = await getUserProjectAccess(session.user.id, requested, session.session.activeOrganizationId);
  if (!access) return c.json({ error: "no accessible project" }, 403);

  c.set("projectId", access.projectId);
  c.set("role", access.role);
  c.set("actor", session.user.email);
  c.set("userId", session.user.id);
  c.set("organizationId", access.organizationId);
  return next();
}

const WRITE_ROLES: WorkspaceRole[] = ["OWNER", "ADMIN", "MEMBER"];

/** Guard for mutating handlers: VIEWER is read-only. Returns a 403 response or null. */
export function denyIfReadOnly(c: Context<{ Variables: AuthVars }>) {
  return WRITE_ROLES.includes(c.get("role")) ? null : c.json({ error: "forbidden: read-only role" }, 403);
}
