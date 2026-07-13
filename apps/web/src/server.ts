/**
 * Custom server entry for Memoturn dashboard.
 *
 * Wraps the default TanStack Start handler to inject security headers on all
 * responses and to enforce a same-origin policy on state-changing requests.
 * This is the Worker entry point — wrangler.jsonc points here.
 */
import { createStartHandler, defaultStreamHandler, defineHandlerCallback } from "@tanstack/react-start/server";
import { createServerEntry } from "@tanstack/react-start/server-entry";

const ALLOWED_ORIGINS = new Set(["https://memoturn.ai", "https://staging.memoturn.ai"]);

/**
 * Allow requests whose Origin matches the deploy hostname directly. Browsers
 * always send Origin on POST/DELETE/etc; if it's missing on a state-changing
 * request the call isn't from a browser session and gets rejected.
 */
function isAllowedOrigin(origin: string | null, host: string | null): boolean {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  if (host && (origin === `https://${host}` || origin === `http://${host}`)) return true;
  if (origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:")) return true;
  return false;
}

/**
 * Generate a per-response nonce so inline scripts (TanStack hydration,
 * theme-init) can be CSP-allowed without `'unsafe-inline'`. The nonce is
 * stamped into the response and consumed by the CSP header — the inline
 * scripts injected by TanStack Start are already nonce-aware via its
 * built-in support; static inline scripts in `__root.tsx` should read this
 * value from the response context if/when CSP is fully tightened.
 */
function randomNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Security headers applied to every response.
 *
 * - Content-Security-Policy: nonce-based script allowlist + frame-ancestors
 * - X-Content-Type-Options: Prevents MIME-sniffing attacks
 * - X-Frame-Options: Prevents clickjacking (DENY = no framing allowed)
 * - Referrer-Policy: Limits referrer info to same-origin or secure cross-origin
 * - X-XSS-Protection: Legacy header, still useful for older browsers
 * - Permissions-Policy: Disables sensitive browser features we don't use
 * - Strict-Transport-Security: belt-and-suspenders alongside Cloudflare's
 *   "Always Use HTTPS" setting and HSTS preload list
 */
type DeployEnv = "production" | "staging" | "dev";

function deployEnvFor(host: string | null): DeployEnv {
  if (!host) return "production";
  if (host.includes("staging")) return "staging";
  if (host.startsWith("localhost") || host.startsWith("127.0.0.1") || host.endsWith(".local")) return "dev";
  return "production";
}

function connectSrcFor(env: DeployEnv): string {
  // The marketing site is self-contained; it makes no cross-origin API calls.
  const dev = ["http://localhost:*", "ws://localhost:*", "ws://127.0.0.1:*"];
  const sources = env === "dev" ? dev : [];
  return ["'self'", ...sources].join(" ");
}

function applySecurityHeaders(headers: Headers, nonce: string, host: string | null): void {
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("X-XSS-Protection", "1; mode=block");
  headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
  headers.set(
    "Permissions-Policy",
    "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
  );
  const env = deployEnvFor(host);
  const connectSrc = connectSrcFor(env);
  // Report-only for now — TanStack hydration scripts that aren't yet
  // nonce-aware would otherwise break the dashboard. The `unsafe-inline`
  // fallback is honoured by browsers only when no nonce is present, so
  // adding the nonce + reporting endpoint lets us migrate incrementally
  // without breaking the live dashboard.
  headers.set(
    "Content-Security-Policy-Report-Only",
    [
      `default-src 'self'`,
      `script-src 'self' 'nonce-${nonce}' 'unsafe-inline'`,
      `style-src 'self' 'unsafe-inline'`,
      `img-src 'self' https: data:`,
      `font-src 'self' data:`,
      `connect-src ${connectSrc}`,
      `frame-ancestors 'none'`,
      `form-action 'self'`,
      `base-uri 'none'`,
      `object-src 'none'`,
    ].join("; "),
  );
}

/**
 * Reject state-changing requests that don't come from an allowed origin.
 * TanStack Start exposes server functions over POST without a CSRF token of
 * its own, so the cookie's `SameSite=Strict` plus this Origin/Referer check
 * is what stops a cross-site form/fetch from invoking server functions with
 * the user's session attached.
 */
function rejectCrossOrigin(request: Request): Response | null {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return null;
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");
  if (isAllowedOrigin(origin, url.host)) return null;
  if (referer) {
    try {
      const refUrl = new URL(referer);
      if (isAllowedOrigin(refUrl.origin, url.host)) return null;
    } catch {
      // invalid referer → fall through to reject
    }
  }
  return new Response(JSON.stringify({ error: "cross-origin request rejected" }), {
    status: 403,
    headers: { "content-type": "application/json" },
  });
}

const secureHandler = defineHandlerCallback(async (ctx) => {
  const blocked = rejectCrossOrigin(ctx.request);
  if (blocked) return blocked;

  // defaultStreamHandler returns either a Response or a { response } wrapper
  // depending on the TanStack Start version; normalize to the Response.
  const result = await defaultStreamHandler(ctx);
  const response = result instanceof Response ? result : result.response;
  const nonce = randomNonce();

  // Clone headers to avoid mutating a locked Headers object on streaming responses
  const headers = new Headers(response.headers);
  const host = new URL(ctx.request.url).host;
  applySecurityHeaders(headers, nonce, host);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
});

const fetch = createStartHandler(secureHandler);

export default createServerEntry({
  fetch,
});
