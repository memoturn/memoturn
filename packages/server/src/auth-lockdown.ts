/**
 * Auth lockdown for a public read-only deployment, where the sign-in credentials are published.
 *
 * `/auth/*` goes straight to Better Auth, so the `/v1` role gates never see it: a shared viewer
 * could otherwise create an org and own it, change the published password, or enrol 2FA and lock
 * every other visitor out. This is an allowlist rather than a blocklist so an endpoint added by a
 * future plugin stays closed by default.
 */
const ALLOWED_AUTH_ROUTES = new Set([
  "GET /get-session",
  "POST /sign-in/email",
  "POST /sign-out",
  "GET /organization/list",
  "GET /organization/get-full-organization",
  "POST /organization/set-active",
]);

export function authLockdownEnabled(): boolean {
  return process.env.AUTH_LOCKDOWN === "true";
}

/** `path` is the request path including the `/auth` mount. Anything not matched exactly is denied. */
export function isAuthRouteAllowed(method: string, path: string): boolean {
  if (!authLockdownEnabled()) return true;
  return ALLOWED_AUTH_ROUTES.has(`${method.toUpperCase()} ${path.replace(/^\/auth(?=\/)/, "")}`);
}

/**
 * Viewers can read the audit log, and on a shared login every visitor is the same viewer. Sign-in
 * audit entries copy the session's IP, so keeping it would show visitors each other's addresses.
 * Rate limiting is unaffected: it reads the live request, not the stored session.
 */
export function withoutVisitorIdentity<T extends object>(session: T): T {
  return authLockdownEnabled() ? { ...session, ipAddress: null, userAgent: null } : session;
}

/**
 * The credentials the console's "View live demo" button signs in with. Served only under lockdown,
 * so setting these on an ordinary install can never publish a working login.
 */
export function publicDemoLogin(): { email: string; password: string } | null {
  const email = process.env.PUBLIC_DEMO_EMAIL;
  const password = process.env.PUBLIC_DEMO_PASSWORD;
  return authLockdownEnabled() && email && password ? { email, password } : null;
}
