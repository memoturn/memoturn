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
    // Any IPv6 form that embeds an IPv4 address — IPv4-mapped (::ffff:a.b.c.d, which the URL
    // parser normalizes to the hex form ::ffff:a9fe:a9fe), IPv4-compatible (::a.b.c.d), 6to4
    // (2002:V4::/16) and NAT64 (64:ff9b::/96) — is re-checked against the v4 rules. A regex on
    // the dotted form alone missed the hex-normalized encodings and let metadata IPs through.
    const groups = expandIpv6(lower);
    const embedded = groups && embeddedIpv4(groups);
    if (embedded) return isBlockedIp(embedded);
    return false;
  }
  return false;
}

/** Expand an IPv6 literal into its eight 16-bit groups, or null if unparseable. */
function expandIpv6(ip: string): number[] | null {
  let s = ip.replace(/^\[|\]$/g, "");
  // Fold a trailing dotted-quad (e.g. ::ffff:1.2.3.4) into two hex groups first.
  const dotted = s.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted?.[1]) {
    const o = dotted[1].split(".").map(Number);
    if (o.some((n) => n > 255)) return null;
    s = `${s.slice(0, s.length - dotted[1].length)}${(((o[0] ?? 0) << 8) | (o[1] ?? 0)).toString(16)}:${(((o[2] ?? 0) << 8) | (o[3] ?? 0)).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const toGroups = (p: string) => (p ? p.split(":").map((h) => Number.parseInt(h, 16)) : []);
  const head = toGroups(halves[0] ?? "");
  const tail = halves.length === 2 ? toGroups(halves[1] ?? "") : [];
  const gap = 8 - head.length - tail.length;
  // No "::" means the address must already be a full 8 groups; "::" stands for ≥1 zero group.
  if (halves.length === 1 ? gap !== 0 : gap < 1) return null;
  const groups = [...head, ...Array(Math.max(gap, 0)).fill(0), ...tail];
  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff)) return null;
  return groups;
}

/** Extract the embedded IPv4 (dotted) from a v4-in-v6 encoding, or null if there isn't one. */
function embeddedIpv4(g: number[]): string | null {
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  // ::ffff:V4 (mapped) and ::V4 (deprecated compatible): first five groups zero, sixth 0xffff or 0.
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return v4(g[6] ?? 0, g[7] ?? 0);
  if (g[0] === 0x2002) return v4(g[1] ?? 0, g[2] ?? 0); // 6to4 2002:V4::/16
  if (g[0] === 0x0064 && g[1] === 0xff9b) return v4(g[6] ?? 0, g[7] ?? 0); // NAT64 64:ff9b::/96
  return null;
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
