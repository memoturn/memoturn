import {
  oauthProvider,
  oauthProviderAuthServerMetadata,
  oauthProviderOpenIdConfigMetadata,
} from "@better-auth/oauth-provider";
import { passkey } from "@better-auth/passkey";
import { sso } from "@better-auth/sso";
import { prisma } from "@memoturn/db";
import { redisConnection } from "@memoturn/db/queue";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { verifyJwsAccessToken } from "better-auth/oauth2";
import { emailOTP, jwt, magicLink, twoFactor } from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import { admin } from "better-auth/plugins/admin";
import { haveIBeenPwned } from "better-auth/plugins/haveibeenpwned";
import { organization } from "better-auth/plugins/organization";
import { adminAc, defaultStatements, memberAc, ownerAc } from "better-auth/plugins/organization/access";
import { recordAuthAudit } from "./audit.js";
import { isProduction } from "./env.js";
import { mailerStatus, sendEmail } from "./mailer.js";

/**
 * Better Auth instance — email/password auth + the organization plugin (tenancy) + SSO
 * (external OIDC/SAML identity providers) on the Prisma (Postgres) adapter. Lives in
 * @memoturn/server so the API (handler + session checks) and the seed script
 * (server-side signup) share one configured instance. Mounted at /auth/* by the API;
 * the console reaches it via its dev proxy (/api/auth/* -> /auth/*).
 */

// The console origin — the first trusted origin (project switcher, invite/reset links,
// and the OAuth authorize login/consent pages all bounce here). Overridable via AUTH_TRUSTED_ORIGINS.
const consoleOrigin =
  (process.env.AUTH_TRUSTED_ORIGINS ?? "http://localhost:3000").split(",")[0] ?? "http://localhost:3000";

// The API's own base URL + derived OAuth identities. Better Auth appends basePath to
// baseURL for its context, so the OAuth issuer (JWT `iss`) is `${authBaseURL}/auth`.
// `apiOrigin` is the canonical OAuth resource identifier: the protected-resource metadata
// advertises it, spec-compliant MCP clients request it as the `resource` (RFC 8707), and
// it becomes the JWT `aud` that verifyMcpBearer checks — strict audience binding, so a
// token minted for another resource can't be replayed against the MCP endpoint.
const authBaseURL = process.env.AUTH_BASE_URL ?? `http://localhost:${process.env.API_PORT ?? 3001}`;
const apiOrigin = new URL(authBaseURL).origin;
const oauthIssuer = `${authBaseURL}/auth`;

/**
 * Social providers, included only when both the id and secret are set — so an unconfigured
 * provider is simply absent (the console hides its button rather than showing a dead one).
 * Add a provider here and to `authMethods()` below to surface it. Callback URLs are
 * `${AUTH_BASE_URL}/auth/callback/<provider>`.
 */
function socialProvidersFromEnv() {
  const providers: Record<string, { clientId: string; clientSecret: string }> = {};
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    providers.google = { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET };
  }
  if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
    providers.github = { clientId: process.env.GITHUB_CLIENT_ID, clientSecret: process.env.GITHUB_CLIENT_SECRET };
  }
  return providers;
}
const socialProviders = socialProvidersFromEnv();

// Passwordless (magic-link / email-OTP) is only usable when email can actually be delivered —
// i.e. a transport is configured, or we're in development where the mailer logs links to
// stderr. In production with no transport, hide it rather than offer a dead button.
const passwordlessUsable = mailerStatus().configured || !isProduction();

// WebAuthn relying-party identity for passkeys. rpID must be the registrable domain (no
// scheme/port) and `origin` the full console origin. Defaults derive from the console origin;
// override per-deploy with PASSKEY_RP_ID / PASSKEY_ORIGIN (e.g. behind a custom domain).
const passkeyOrigin = process.env.PASSKEY_ORIGIN ?? consoleOrigin;
const passkeyRpId = process.env.PASSKEY_RP_ID ?? new URL(passkeyOrigin).hostname;

/**
 * Map an SSO IdP's claims to an organization role. A federated user is auto-joined to the
 * organization bound to their provider (organizationProvisioning below); they land as
 * "member" unless the IdP asserts a group/role in SSO_ADMIN_GROUPS (comma-separated, matched
 * case-insensitively against the common `groups` / `roles` / `role` claims) — then "admin".
 */
const ssoAdminGroups = (process.env.SSO_ADMIN_GROUPS ?? "")
  .split(",")
  .map((g) => g.trim().toLowerCase())
  .filter(Boolean);
function mapSsoRole(userInfo: Record<string, unknown>): "member" | "admin" {
  if (ssoAdminGroups.length === 0) return "member";
  const claims: string[] = [];
  for (const key of ["groups", "roles", "role"]) {
    const v = userInfo[key];
    if (Array.isArray(v)) claims.push(...v.map((x) => String(x).toLowerCase()));
    else if (typeof v === "string") claims.push(...v.split(/[,\s]+/).map((x) => x.toLowerCase()));
  }
  return claims.some((c) => ssoAdminGroups.includes(c)) ? "admin" : "member";
}

// Platform superadmins (cloud ops): user IDs that always pass admin-plugin authorization,
// independent of the user.role column. Comma-separated env; empty in self-host by default.
const superadminUserIds = (process.env.SUPERADMIN_USER_IDS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Headers a fronting proxy sets with the real client IP (e.g. cf-connecting-ip behind
// Cloudflare, x-real-ip behind nginx). Better Auth keys its rate limiter on this IP — left
// unset it trusts x-forwarded-for, which a direct-to-origin client can spoof to dodge the
// brute-force limits. Deployments behind a proxy should pin the header they control.
const ipHeaders = (process.env.AUTH_IP_HEADERS ?? "")
  .split(",")
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

/**
 * Redis-backed storage for Better Auth's built-in auth-route rate limiter, so the limit is
 * consistent across API replicas (the default in-memory store is per-process). Isolated to
 * rate limiting via `rateLimit.customStorage` — sessions stay in Postgres. Fails open (a
 * Redis blip must never lock users out of signing in); the stored value's `lastRequest`
 * drives the window, so the Redis TTL is only garbage collection.
 */
// In-process fallback so a Redis OUTAGE degrades to per-replica throttling instead of removing
// the auth rate limit entirely (a fully-open limiter is a brute-force window on password + OTP).
// Bounded and pruned so it can't grow unbounded; only consulted when Redis is unreachable.
type RlEntry = { count: number; lastRequest: number };
const localRl = new Map<string, RlEntry>();
const LOCAL_RL_MAX = 10_000;
function localRlSet(key: string, value: RlEntry) {
  if (localRl.size >= LOCAL_RL_MAX) {
    const cutoff = Date.now() - 120_000;
    for (const [k, v] of localRl) if (v.lastRequest < cutoff) localRl.delete(k);
    if (localRl.size >= LOCAL_RL_MAX) localRl.clear(); // still full of fresh entries — hard reset
  }
  localRl.set(key, value);
}

const rateLimitStorage = {
  get: async (key: string) => {
    try {
      const raw = await redisConnection().get(`memoturn:ba-rl:${key}`);
      return raw ? JSON.parse(raw) : undefined;
    } catch {
      return localRl.get(key); // Redis down — fall back to the per-replica counter
    }
  },
  set: async (key: string, value: RlEntry) => {
    localRlSet(key, value); // bounded per-replica mirror, so a mid-window outage still throttles
    try {
      // TTL a little beyond the max window keeps stale counters from lingering.
      await redisConnection().set(`memoturn:ba-rl:${key}`, JSON.stringify(value), "EX", 120);
    } catch {
      // fall back to the local mirror written above
    }
  },
};

/**
 * Which auth methods are enabled, for the console to render the right sign-in surfaces.
 * Served publicly (unauthenticated) at `/auth-config` — see apps/api. Derived from the
 * same env the plugins above read, so the UI never drifts from what the server accepts.
 */
export function authMethods() {
  return {
    password: {
      enabled: true,
      signupDisabled: process.env.AUTH_DISABLE_PASSWORD_SIGNUP === "true",
    },
    social: {
      google: "google" in socialProviders,
      github: "github" in socialProviders,
    },
    magicLink: passwordlessUsable,
    emailOtp: passwordlessUsable,
    passkey: true,
    emailConfigured: mailerStatus().configured,
  };
}

/**
 * A minimal branded transactional email (plain-text + light HTML) with a single call-to-
 * action link. Used for password reset, email verification, and org invitations. Delivery
 * is best-effort via the shared mailer — when email is unconfigured the link is logged to
 * stderr in development (see mailer.ts), so local auth flows stay testable without SMTP.
 */
function actionEmail(opts: { subject: string; intro: string; action: string; url: string }) {
  const text = `${opts.intro}\n\n${opts.action}: ${opts.url}\n\nIf you didn't expect this email, you can safely ignore it.`;
  const html = `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#0f172a">
  <p style="font-size:15px;line-height:1.5">${opts.intro}</p>
  <p style="margin:24px 0"><a href="${opts.url}" style="background:#328f97;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-size:14px;font-weight:600">${opts.action}</a></p>
  <p style="font-size:12px;color:#64748b">Or paste this link into your browser:<br><a href="${opts.url}" style="color:#328f97">${opts.url}</a></p>
  <p style="font-size:12px;color:#94a3b8;margin-top:24px">If you didn't expect this email, you can safely ignore it.</p>
</div>`;
  return { subject: opts.subject, text, html };
}

// Four-role access model: owner/admin/member inherit the org plugin defaults; viewer is
// a read-only role (no org permissions) enforced as read-only at the API layer too.
const ac = createAccessControl(defaultStatements);
export const orgRoles = {
  owner: ownerAc,
  admin: adminAc,
  member: memberAc,
  viewer: ac.newRole({}),
};

export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  emailAndPassword: {
    // Kept as the zero-dependency bootstrap path (fresh self-host / airgapped installs and
    // local dev can sign in without SMTP or an external IdP). The console leads with social +
    // passwordless; password is the fallback. Cloud can disable *new* password signups (still
    // allowing existing bootstrap logins) with AUTH_DISABLE_PASSWORD_SIGNUP=true.
    enabled: true,
    disableSignUp: process.env.AUTH_DISABLE_PASSWORD_SIGNUP === "true",
    // 12-char floor (NIST leans length-over-complexity; HIBP below rejects breached ones).
    // Only gates NEW passwords — existing shorter passwords still sign in.
    minPasswordLength: Number(process.env.AUTH_MIN_PASSWORD_LENGTH) || 12,
    // Cloud/enterprise deployments flip this on to require a verified email before sign-in;
    // default off so existing dev/self-host accounts aren't locked out.
    requireEmailVerification: process.env.AUTH_REQUIRE_EMAIL_VERIFICATION === "true",
    // A password reset is a recovery from possible compromise — kill every other session.
    revokeSessionsOnPasswordReset: true,
    onPasswordReset: async ({ user }) => {
      await recordAuthAudit({ userId: user.id, action: "password.reset", target: user.email });
    },
    // Password reset via emailed link. The client calls requestPasswordReset({ email,
    // redirectTo: "/reset-password" }); Better Auth verifies the token then bounces to that
    // console route with ?token=… where authClient.resetPassword completes the change.
    sendResetPassword: async ({ user, url }) => {
      await sendEmail({
        to: user.email,
        ...actionEmail({
          subject: "Reset your memoturn password",
          intro: "We received a request to reset the password on your memoturn account.",
          action: "Reset password",
          url,
        }),
      });
    },
  },
  // Email verification (opt-in for now — requireEmailVerification stays off so existing
  // dev/self-host accounts aren't locked out; cloud can flip it on). Sent on sign-up.
  emailVerification: {
    sendOnSignUp: true,
    sendVerificationEmail: async ({ user, url }) => {
      await sendEmail({
        to: user.email,
        ...actionEmail({
          subject: "Verify your memoturn email",
          intro: "Confirm your email address to finish setting up your memoturn account.",
          action: "Verify email",
          url,
        }),
      });
    },
  },
  // Social sign-in (Google/GitHub) — present only for providers whose env is configured.
  socialProviders,
  basePath: "/auth",
  baseURL: authBaseURL,
  // The jwt plugin's /token endpoint mints session-bearer JWTs we don't use (OAuth access
  // tokens come from /oauth2/token); disable it rather than expose a second token surface.
  disabledPaths: ["/token"],
  secret: process.env.BETTER_AUTH_SECRET ?? "dev-only-change-me",
  trustedOrigins: (process.env.AUTH_TRUSTED_ORIGINS ?? "http://localhost:3000").split(","),
  // 7-day sessions, refreshed at most daily. cookieCache serves getSession from a short-lived
  // SIGNED cookie instead of a Postgres query — the single biggest auth read on the API (every
  // console request calls getSession in requireAuth). Tradeoff: an admin ban / session revoke
  // takes up to maxAge (default 5 min) to bite on an already-issued cookie. RBAC changes are
  // NOT delayed — role/project resolution stays a live query in getUserProjectAccess.
  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
    cookieCache: {
      enabled: process.env.AUTH_COOKIE_CACHE_DISABLED !== "true",
      maxAge: Number(process.env.AUTH_COOKIE_CACHE_MAX_AGE) || 300,
    },
  },
  // Self-host posture: never phone home, explicitly (the default is off; this pins it).
  telemetry: { enabled: false },
  // Brute-force protection on the auth routes (login/signup/reset). On by default in every
  // env (Better Auth only auto-enables in production). Backed by Redis (customStorage) so the
  // counter is shared across API replicas instead of per-process in-memory. Set
  // AUTH_RATE_LIMIT_DISABLED=true only for test suites that sign in repeatedly (e2e) — never
  // in production; the built-in sign-in sub-limit otherwise 429s the rapid logins.
  rateLimit: {
    enabled: process.env.AUTH_RATE_LIMIT_DISABLED !== "true",
    window: 60,
    max: 30,
    customStorage: rateLimitStorage,
  },
  advanced: {
    cookiePrefix: "memoturn",
    // Secure cookies in production; httpOnly + SameSite=Lax always (CSRF defense-in-depth).
    useSecureCookies: process.env.NODE_ENV === "production",
    defaultCookieAttributes: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    },
    // Pin the client-IP header to the one the fronting proxy controls (see ipHeaders above).
    ...(ipHeaders.length > 0 ? { ipAddress: { ipAddressHeaders: ipHeaders } } : {}),
  },
  plugins: [
    // Reject passwords found in known breaches at signup/change (k-anonymity HIBP check).
    // The check FAILS CLOSED: if api.pwnedpasswords.com is unreachable, signup/password-change
    // 500s — airgapped/offline self-hosts must set AUTH_HIBP_DISABLED=true.
    haveIBeenPwned({ enabled: process.env.AUTH_HIBP_DISABLED !== "true" }),
    // Signing keys for JWT OAuth access tokens (jwks table; served at /auth/jwks). Required
    // by oauthProvider() below; its standalone /token endpoint is disabled via disabledPaths.
    jwt(),
    // OAuth 2.1 authorization for remote MCP clients (memoturn cloud) — replaces the
    // deprecated mcp() plugin. Turns this Better Auth instance into the OAuth server that
    // agent IDEs discover + sign into for the remote MCP endpoint (apps/api /v1/mcp/:projectId).
    // PKCE (S256) is mandatory, refresh tokens rotate, and access tokens are JWTs verified
    // statelessly by verifyMcpBearer below. `loginPage`/`consentPage` are console routes the
    // authorize flow bounces to with a SIGNED query string the pages must round-trip verbatim.
    // Composes with sso() so enterprise users can complete the flow via their own IdP.
    // Adds oauthClient/oauthRefreshToken/oauthAccessToken/oauthConsent tables (schema.prisma).
    oauthProvider({
      loginPage: process.env.MCP_LOGIN_PAGE ?? `${consoleOrigin}/login`,
      consentPage: process.env.MCP_CONSENT_PAGE ?? `${consoleOrigin}/consent`,
      // MCP IDE clients self-register (RFC 7591). Unauthenticated registration is what the
      // MCP spec currently requires of authorization servers; revisit when the protocol
      // settles on Client ID Metadata Documents.
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      // Exact-match audience allowlist for requested `resource` values. The origin is the
      // canonical resource for all per-project MCP URLs (prefix rule, RFC 9728); the issuer
      // is accepted too for clients that default the audience to the auth server.
      validAudiences: [apiOrigin, oauthIssuer],
    }),
    // Passwordless sign-in via an emailed one-time link. Delivery is best-effort through the
    // shared mailer (dev logs the link to stderr when email is unconfigured).
    magicLink({
      sendMagicLink: async ({ email, url }) => {
        await sendEmail({
          to: email,
          ...actionEmail({
            subject: "Your memoturn sign-in link",
            intro: "Click below to sign in to memoturn. This link expires shortly.",
            action: "Sign in to memoturn",
            url,
          }),
        });
      },
    }),
    // One-time codes over email: passwordless sign-in, email verification, and OTP-based
    // password reset. Same mailer path as magic-link.
    emailOTP({
      sendVerificationOTP: async ({ email, otp, type }) => {
        const purpose =
          type === "sign-in"
            ? "sign in to memoturn"
            : type === "email-verification"
              ? "verify your email"
              : "reset your password";
        await sendEmail({
          to: email,
          subject: `Your memoturn code: ${otp}`,
          text: `Your one-time code to ${purpose} is: ${otp}\n\nIt expires in 5 minutes. If you didn't request this, you can ignore this email.`,
          html: `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#0f172a">
  <p style="font-size:15px">Your one-time code to ${purpose}:</p>
  <p style="font-size:32px;font-weight:700;letter-spacing:6px;color:#328f97;margin:16px 0">${otp}</p>
  <p style="font-size:12px;color:#64748b">Expires in 5 minutes. If you didn't request this, you can ignore this email.</p>
</div>`,
        });
      },
    }),
    // Second factor: TOTP (authenticator apps) + backup codes, with built-in lockout after
    // repeated failures. The optional email-OTP factor reuses the shared mailer. Secrets and
    // backup codes are stored encrypted by the plugin (twoFactor table).
    twoFactor({
      issuer: "memoturn",
      otpOptions: {
        sendOTP: async ({ user, otp }) => {
          await sendEmail({
            to: user.email,
            subject: `Your memoturn verification code: ${otp}`,
            text: `Your two-factor verification code is: ${otp}\n\nIt expires shortly. If you didn't try to sign in, change your password.`,
          });
        },
      },
    }),
    // Passkeys (WebAuthn/FIDO2) — phishing-resistant passwordless sign-in. rpID/origin above.
    passkey({ rpID: passkeyRpId, rpName: "memoturn", origin: passkeyOrigin }),
    // Platform administration (cloud ops): list/ban/unban users, force session revoke, and
    // impersonation for support. Authorizes callers whose user.role is "admin" or whose id is
    // in SUPERADMIN_USER_IDS. This is a global platform role, distinct from org member roles.
    admin({ adminRoles: ["admin"], adminUserIds: superadminUserIds }),
    // Let customers sign into memoturn with their own IdP (OIDC/SAML), mapped by email domain.
    // organizationProvisioning auto-joins a federated user to the organization bound to their
    // provider, with a role mapped from IdP claims (see mapSsoRole) — the enterprise SSO path.
    sso({
      organizationProvisioning: {
        defaultRole: "member",
        getRole: async ({ userInfo }) => mapSsoRole(userInfo as Record<string, unknown>),
      },
    }),
    organization({
      ac,
      roles: orgRoles,
      creatorRole: "owner",
      // The plugin's defaults (100 members, 100 pending invitations per org) are a wall an
      // enterprise tenant hits mid-rollout. Raised here; tune per-deploy via env.
      membershipLimit: Number(process.env.AUTH_ORG_MEMBERSHIP_LIMIT) || 10_000,
      invitationLimit: Number(process.env.AUTH_ORG_INVITATION_LIMIT) || 1_000,
      // Re-inviting someone supersedes their older pending invite instead of stacking a
      // second live credential-bearing link.
      cancelPendingInvitationsOnReInvite: true,
      // Email an invited teammate a link to accept. Without this, invitations were persisted
      // (pending row + UI badge) but never delivered. The console /accept-invite route reads
      // the id and calls authClient.organization.acceptInvitation.
      sendInvitationEmail: async (data) => {
        const url = `${consoleOrigin}/accept-invite?id=${data.id}`;
        await sendEmail({
          to: data.email,
          ...actionEmail({
            subject: `You're invited to ${data.organization.name} on memoturn`,
            intro: `${data.inviter.user.name || data.inviter.user.email} invited you to join ${data.organization.name} on memoturn as ${data.role}.`,
            action: "Accept invitation",
            url,
          }),
        });
      },
      organizationHooks: {
        // Every new org gets a default project so it's immediately usable.
        afterCreateOrganization: async ({ organization: org }) => {
          await prisma.project.upsert({
            where: { organizationId_slug: { organizationId: org.id, slug: "default" } },
            update: {},
            create: { organizationId: org.id, name: "Default Project", slug: "default" },
          });
        },
        // Auth-lifecycle audit: membership + invitation changes → the per-project audit log.
        // These after-hooks are AWAITED by the plugin, so a throw would fail the underlying
        // operation — every handler accesses payload fields defensively and never throws.
        afterAddMember: async (data) => {
          const d = data as Record<string, any>;
          await recordAuthAudit({
            organizationId: d.organization?.id,
            actor: d.user?.email,
            action: "member.added",
            target: d.user?.email ?? d.member?.userId ?? "unknown",
            metadata: { role: d.member?.role },
          });
        },
        afterUpdateMemberRole: async (data) => {
          const d = data as Record<string, any>;
          await recordAuthAudit({
            organizationId: d.organization?.id,
            actor: d.user?.email,
            action: "member.role.updated",
            target: d.user?.email ?? d.member?.userId ?? "unknown",
            metadata: { role: d.member?.role },
          });
        },
        afterRemoveMember: async (data) => {
          const d = data as Record<string, any>;
          await recordAuthAudit({
            organizationId: d.organization?.id,
            actor: d.user?.email,
            action: "member.removed",
            target: d.user?.email ?? "unknown",
          });
        },
        afterCreateInvitation: async (data) => {
          const d = data as Record<string, any>;
          await recordAuthAudit({
            organizationId: d.organization?.id,
            actor: d.inviter?.user?.email ?? "system",
            action: "invitation.created",
            target: d.invitation?.email ?? "unknown",
            metadata: { role: d.invitation?.role },
          });
        },
        afterAcceptInvitation: async (data) => {
          const d = data as Record<string, any>;
          await recordAuthAudit({
            organizationId: d.organization?.id,
            actor: d.user?.email,
            action: "invitation.accepted",
            target: d.user?.email ?? "unknown",
          });
        },
      },
    }),
  ],
  databaseHooks: {
    session: {
      create: {
        // Default a new session's active organization to the user's first membership,
        // so project resolution works without the client calling setActiveOrganization.
        before: async (session) => {
          const m = await prisma.member.findFirst({
            where: { userId: session.userId },
            orderBy: { createdAt: "asc" },
          });
          return { data: { ...session, activeOrganizationId: m?.organizationId ?? null } };
        },
        // Auth-lifecycle audit: every new session is a sign-in — regardless of method
        // (password, social, SSO, magic-link, OTP, passkey). Attaches to the active org.
        after: async (session) => {
          await recordAuthAudit({
            userId: session.userId,
            organizationId: (session.activeOrganizationId as string | null | undefined) ?? null,
            action: "signin",
            target: session.userId,
            metadata: { ipAddress: session.ipAddress ?? undefined },
          });
        },
      },
    },
  },
});

export type AuthSession = typeof auth.$Infer.Session;

/**
 * OAuth discovery documents for remote MCP clients, bound to this auth instance. The
 * oauthProvider() plugin also serves auth-server + OIDC metadata under /auth/.well-known/*,
 * but MCP clients probe them at the domain root — the API mounts these at `/.well-known/*`
 * (see apps/api). Each is a Fetch handler `(Request) => Promise<Response>`.
 */
export const mcpAuthorizationServerMetadata = oauthProviderAuthServerMetadata(auth);
export const mcpOpenIdConfigMetadata = oauthProviderOpenIdConfigMetadata(auth);

/**
 * RFC 9728 protected-resource metadata for the MCP endpoints. The authorization server
 * doesn't publish this (it describes the RESOURCE, not the auth server): `resource` is the
 * canonical identifier MCP clients send as the `resource` param (a prefix of every
 * /v1/mcp/:projectId URL), and `authorization_servers` points them at our issuer for
 * the /.well-known/oauth-authorization-server discovery step.
 */
export const mcpProtectedResourceMetadata = async (_request: Request): Promise<Response> =>
  Response.json({
    resource: apiOrigin,
    authorization_servers: [oauthIssuer],
    bearer_methods_supported: ["header"],
    scopes_supported: ["openid", "profile", "email", "offline_access"],
  });

// Stable identity for verifyJwsAccessToken's JWKS cache (keyed by object identity).
const mcpJwksCacheKey = {};

/**
 * Verify an OAuth 2.1 bearer token (JWT access token) from an MCP request — statelessly,
 * against the jwt plugin's local JWKS (no DB hit per call, unlike the old getMcpSession).
 * Strict issuer + audience checks; expiry/nbf enforced by jose. Returns the token's user
 * (`sub`) and granted scopes, or null for anything invalid.
 */
export async function verifyMcpBearer(
  authorization: string | null | undefined,
): Promise<{ userId: string; scopes: string[] } | null> {
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length).trim();
  if (!token) return null;
  try {
    const payload = await verifyJwsAccessToken(token, {
      jwksFetch: async () => await auth.api.getJwks(),
      jwksCacheKey: mcpJwksCacheKey,
      verifyOptions: { issuer: oauthIssuer, audience: [apiOrigin, oauthIssuer] },
    });
    if (!payload.sub) return null;
    const scopes = typeof payload.scope === "string" ? payload.scope.split(" ").filter(Boolean) : [];
    return { userId: payload.sub, scopes };
  } catch {
    return null; // expired, bad signature, wrong issuer/audience — all just "unauthorized"
  }
}
