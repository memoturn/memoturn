import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * SSRF protection for user-configured outbound targets (webhooks, automations, the
 * analytics sink). Users supply arbitrary URLs that the server then fetches, so without
 * validation an authenticated user could probe internal services (databases, the cloud
 * metadata endpoint, other tenants' admin ports).
 *
 * `assertPublicUrl` is called twice: at WRITE time (reject the config with a 400) and
 * again at DISPATCH time (DNS can rebind between the two). Strict in EVERY environment —
 * a self-host that forgets NODE_ENV=production must not silently run with SSRF off.
 * Set ALLOW_PRIVATE_WEBHOOK_TARGETS=1 (shipped in .env.example for local dev) to permit
 * http:// and private/loopback ranges for local/self-hosted LAN use.
 */
export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
  }
}

function allowPrivate(): boolean {
  // Strict by default everywhere; localhost targets need the explicit opt-in.
  return process.env.ALLOW_PRIVATE_WEBHOOK_TARGETS === "1";
}

/** Is an already-parsed IP address in a blocked (private/loopback/link-local/ULA/metadata) range? */
export function isBlockedIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const parts = ip.split(".").map(Number);
    const a = parts[0] ?? 0;
    const b = parts[1] ?? 0;
    if (a === 127) return true; // loopback
    if (a === 10) return true; // private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 169 && b === 254) return true; // link-local + cloud metadata (169.254.169.254)
    if (a === 0) return true; // "this" network
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  if (v === 6) {
    const lower = ip.toLowerCase().replace(/^\[|\]$/g, "");
    if (lower === "::1" || lower === "::") return true; // loopback / unspecified
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique local fc00::/7
    if (lower.startsWith("fe80")) return true; // link-local
    // IPv4-mapped (::ffff:a.b.c.d) — re-check the embedded v4.
    const mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped?.[1]) return isBlockedIp(mapped[1]);
    return false;
  }
  return false;
}

/**
 * Validate that a URL is safe to fetch server-side. Requires https:// (http:// only when
 * private targets are allowed) and resolves the host, rejecting private/loopback IPs.
 * Throws SsrfError on rejection.
 */
export async function assertPublicUrl(rawUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfError("invalid URL");
  }

  const permissive = allowPrivate();
  if (url.protocol !== "https:" && !(url.protocol === "http:" && permissive)) {
    throw new SsrfError(
      "only https:// URLs are allowed (set ALLOW_PRIVATE_WEBHOOK_TARGETS=1 for local http:// targets)",
    );
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (permissive) return; // dev / explicit LAN opt-in: skip IP resolution checks

  // Literal IP in the host — check directly.
  if (isIP(host)) {
    if (isBlockedIp(host))
      throw new SsrfError(
        "URL resolves to a private or reserved address (set ALLOW_PRIVATE_WEBHOOK_TARGETS=1 for LAN targets)",
      );
    return;
  }

  // Resolve the hostname and reject if ANY resolved address is private.
  let addrs: { address: string }[];
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    throw new SsrfError("could not resolve host");
  }
  if (addrs.length === 0) throw new SsrfError("host did not resolve");
  for (const a of addrs) {
    if (isBlockedIp(a.address))
      throw new SsrfError(
        "URL resolves to a private or reserved address (set ALLOW_PRIVATE_WEBHOOK_TARGETS=1 for LAN targets)",
      );
  }
}

/** Best-effort variant for dispatch time: returns true if safe, false if blocked (never throws). */
export async function isPublicUrl(rawUrl: string): Promise<boolean> {
  try {
    await assertPublicUrl(rawUrl);
    return true;
  } catch {
    return false;
  }
}
