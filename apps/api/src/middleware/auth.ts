import {
  auth,
  authenticateKeys,
  getUserProjectAccess,
  orgRequiresTwoFactor,
  parseBasicAuth,
  requiredScope,
  roleForScopes,
  type WorkspaceRole,
} from "@memoturn/server";
import type { Context, Next } from "hono";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const TRUSTED_ORIGINS = (process.env.AUTH_TRUSTED_ORIGINS ?? "http://localhost:3000")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

export type AuthVars = {
  /** Per-request correlation id — set by the first middleware in app.ts, before auth. */
  requestId: string;
  projectId: string;
  role: WorkspaceRole;
  actor: string;
  userId: string;
  organizationId: string;
  apiKeyId: string; // "" for session auth
  apiKeyRateLimit: number | null; // per-key override, null = none
};

/**
 * Authenticates two ways and resolves the active project + role:
 *  1. API key (Basic auth) — SDK/programmatic; scoped to its project. The role is DERIVED
 *     from the key's scopes (`roleForScopes`): MEMBER for the default read+write+ingest key,
 *     OWNER only when the key carries the explicit `admin` scope. A default key therefore
 *     passes `denyIfReadOnly` but not `denyIfNotAdmin` — a MEMBER who mints a key can't use
 *     it to reach OWNER-only surfaces (project delete, membership, DLQ replay).
 *  2. Better Auth session — dashboard; honors the `x-memoturn-project` header (project
 *     switcher) when the user has access, else their default project, with their role.
 */
export async function requireAuth(c: Context<{ Variables: AuthVars }>, next: Next) {
  const creds = parseBasicAuth(c.req.header("authorization"));
  if (creds) {
    const ctx = await authenticateKeys(creds.publicKey, creds.secretKey);
    if (!ctx) return c.json({ error: "unauthorized" }, 401);
    const need = requiredScope(c.req.method, c.req.path);
    if (!ctx.scopes.includes(need)) {
      return c.json({ error: `forbidden: API key lacks the '${need}' scope` }, 403);
    }
    c.set("projectId", ctx.projectId);
    c.set("role", roleForScopes(ctx.scopes));
    c.set("actor", `apikey:${creds.publicKey}`);
    c.set("userId", "");
    c.set("organizationId", "");
    c.set("apiKeyId", ctx.keyId);
    c.set("apiKeyRateLimit", ctx.rateLimitPerMinute);
    return next();
  }

  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: "unauthorized" }, 401);

  // CSRF defense-in-depth for cookie auth: reject cross-origin mutations from an untrusted
  // Origin. SameSite=Lax already blocks most cross-site cookies; this closes the gap for
  // browser-issued state changes. API-key auth (above) is exempt — it carries no cookie.
  if (MUTATING_METHODS.has(c.req.method)) {
    const origin = c.req.header("origin");
    if (origin && !TRUSTED_ORIGINS.includes(origin)) {
      return c.json({ error: "forbidden: untrusted origin" }, 403);
    }
  }

  // Prefer the switcher header; fall back to a `?project=` query so EventSource / SSE clients
  // (which can't set custom headers) can still target a specific project. Access is validated
  // by getUserProjectAccess either way.
  const requested = c.req.header("x-memoturn-project") || c.req.query("project") || undefined;
  const access = await getUserProjectAccess(session.user.id, requested, session.session.activeOrganizationId);
  if (!access) return c.json({ error: "no accessible project" }, 403);

  // Organization policy: members of an org that requires 2FA must have it enrolled.
  if (await orgRequiresTwoFactor(access.organizationId)) {
    const enrolled = (session.user as { twoFactorEnabled?: boolean | null }).twoFactorEnabled === true;
    if (!enrolled) {
      return c.json(
        {
          error: "your organization requires two-factor authentication — enrol in Settings → Security",
          code: "2fa_required",
        },
        403,
      );
    }
  }

  c.set("projectId", access.projectId);
  c.set("role", access.role);
  c.set("actor", session.user.email);
  c.set("userId", session.user.id);
  c.set("organizationId", access.organizationId);
  c.set("apiKeyId", "");
  c.set("apiKeyRateLimit", null);
  return next();
}

const WRITE_ROLES: WorkspaceRole[] = ["OWNER", "ADMIN", "MEMBER"];

/** Guard for mutating handlers: VIEWER is read-only. Returns a 403 response or null. */
export function denyIfReadOnly(c: Context<{ Variables: AuthVars }>) {
  return WRITE_ROLES.includes(c.get("role")) ? null : c.json({ error: "forbidden: read-only role" }, 403);
}

/**
 * Guard for admin-only surfaces (project lifecycle, membership, API keys, DLQ replay):
 * OWNER/ADMIN only. API-key principals reach OWNER only via the `admin` scope.
 */
export function denyIfNotAdmin(c: Context<{ Variables: AuthVars }>) {
  const role = c.get("role");
  return role === "OWNER" || role === "ADMIN" ? null : c.json({ error: "forbidden: admin only" }, 403);
}
