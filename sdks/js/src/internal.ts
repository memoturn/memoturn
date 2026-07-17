// Internal helpers shared by the SDK's HTTP call sites. Not part of the public API.

/** Default per-request timeout (ms) for every SDK HTTP call. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/** Build the `Authorization: Basic …` header value from an API key pair. */
export function basicAuth(publicKey: string, secretKey: string): string {
  return `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}`;
}

/** Cap server-provided text embedded in thrown errors so error messages stay bounded. */
export function truncate(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const warnedOrigins = new Set<string>();

/**
 * Warn once per origin when API keys would be sent over cleartext http to a non-local
 * host. Never throws — plain-http LAN self-hosted deployments are legitimate; the
 * escape hatch is `allowInsecureHttp` or `MEMOTURN_ALLOW_HTTP=1`.
 */
export function warnIfInsecure(baseUrl: string, allowInsecureHttp: boolean | undefined): void {
  if (allowInsecureHttp || process.env.MEMOTURN_ALLOW_HTTP === "1") return;
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return;
  }
  if (url.protocol !== "http:" || LOCAL_HOSTS.has(url.hostname) || warnedOrigins.has(url.origin)) return;
  warnedOrigins.add(url.origin);
  console.warn(`memoturn: sending API keys over cleartext http to ${url.host} — use https or set allowInsecureHttp`);
}
