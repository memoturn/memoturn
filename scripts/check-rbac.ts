/**
 * Deterministic RBAC guard checker for the memoturn API.
 *
 * Invariant (CLAUDE.md "Add a mutating endpoint"): every mutating /v1 route
 * (POST/PUT/PATCH/DELETE) must call `denyIfReadOnly(c)` and declare a `403`
 * response — otherwise a VIEWER (read-only role) can write. A handful of
 * ingest/compute routes legitimately bypass the write-role gate; those are
 * exempt (built-in list below, or an inline `// rbac-exempt: <reason>` marker).
 *
 * `recordAudit(...)` is applied selectively in this codebase (creates + notable
 * ops, not every delete), so missing-audit is reported as ADVISORY only and
 * never fails the build.
 *
 * Read-only. Exits non-zero when a mutating route is missing the guard or the
 * 403 — safe to wire into lefthook pre-push or CI. Run: `bun run rbac:check`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const APP = "apps/api/src/app.ts";
const src = readFileSync(join(ROOT, APP), "utf8");

const MUTATING = new Set(["post", "put", "patch", "delete"]);

// Routes that legitimately bypass the write-role gate: SDK ingest (API-key OWNER)
// and stateless compute. Everything else that mutates must guard.
const EXEMPT_PATHS = new Set(["/v1/ingest", "/v1/otel/v1/traces"]);

// Admin-only surfaces: routes that manage credentials, membership, the project's lifecycle,
// or the ingest pipeline must ALSO call `denyIfNotAdmin(c)` (OWNER/ADMIN — API keys only via
// the `admin` scope) and record an audit entry. A MEMBER reaching any of these — directly or
// through a key they minted — is the privilege-escalation class this list guards against.
// Matched by path prefix so new sub-routes inherit the requirement.
const ADMIN_PREFIXES = [
  "/v1/api-keys",
  "/v1/projects/{id}",
  "/v1/ingest/dlq",
  "/v1/ingest/health",
  "/v1/sso",
  "/v1/organizations/{id}/members",
  "/v1/users/{userId}/data",
];
// Reads that enumerate credentials or pipeline internals are admin-only too; other reads
// under an admin prefix (e.g. listing members) stay open to any member.
const ADMIN_READ_PATHS = new Set(["/v1/api-keys", "/v1/ingest/health"]);
const isAdminPath = (method: string, path: string): boolean =>
  MUTATING.has(method)
    ? ADMIN_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))
    : ADMIN_READ_PATHS.has(path);

interface Route {
  method: string;
  path: string;
  index: number;
  block: string;
}

// Anchor every route: @hono/zod-openapi `createRoute({ method, path })` blocks and
// plain `app.<verb>("/path", …)` handlers. Each route's block runs to the next anchor.
const anchors: { method: string; path: string; index: number }[] = [];
for (const m of src.matchAll(/createRoute\(\{/g)) {
  const win = src.slice(m.index, m.index + 600);
  const method = win.match(/method:\s*"(\w+)"/)?.[1];
  const path = win.match(/path:\s*"([^"]+)"/)?.[1];
  if (method && path) anchors.push({ method, path, index: m.index as number });
}
for (const m of src.matchAll(/app\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g)) {
  anchors.push({ method: m[1]!, path: m[2]!, index: m.index as number });
}
anchors.sort((a, b) => a.index - b.index);

const routes: Route[] = anchors.map((a, i) => ({
  ...a,
  block: src.slice(a.index, anchors[i + 1]?.index ?? src.length),
}));

const lineOf = (index: number): number => src.slice(0, index).split("\n").length;

interface Finding {
  method: string;
  path: string;
  line: number;
  missing: string[];
}

const failures: Finding[] = [];
const noAudit: { method: string; path: string; line: number }[] = [];
let checked = 0;
let exempt = 0;
let adminChecked = 0;

for (const r of routes) {
  const admin = isAdminPath(r.method, r.path);
  // Admin surfaces are checked on every method (a GET that lists credentials is still admin-only).
  if (!MUTATING.has(r.method) && !admin) continue;
  if (EXEMPT_PATHS.has(r.path) || /rbac-exempt/.test(r.block)) {
    exempt++;
    continue;
  }
  const missing: string[] = [];
  if (MUTATING.has(r.method)) {
    checked++;
    if (!/denyIfReadOnly\(/.test(r.block)) missing.push("denyIfReadOnly(c)");
  }
  if (admin) {
    adminChecked++;
    if (!/denyIfNotAdmin\(/.test(r.block)) missing.push("denyIfNotAdmin(c)");
    if (MUTATING.has(r.method) && !/recordAudit\(|recordAuthAudit\(/.test(r.block)) {
      missing.push("recordAudit(...) (required on admin routes)");
    }
  }
  if (!/\b403:/.test(r.block)) missing.push("403 response");
  if (missing.length > 0) {
    failures.push({ method: r.method, path: r.path, line: lineOf(r.index), missing });
  } else if (MUTATING.has(r.method) && !/recordAudit\(/.test(r.block)) {
    noAudit.push({ method: r.method, path: r.path, line: lineOf(r.index) });
  }
}

const up = (m: string): string => m.toUpperCase().padEnd(6);
console.log(`rbac guard check — ${checked} mutating route(s), ${adminChecked} admin-only route(s), ${exempt} exempt\n`);

if (failures.length === 0) {
  console.log("  OK    every mutating route guards denyIfReadOnly + declares 403");
} else {
  for (const f of failures) {
    console.log(`  DRIFT ${up(f.method)} ${f.path}  (${APP}:${f.line})`);
    console.log(`        missing: ${f.missing.join(", ")}`);
  }
}

if (noAudit.length > 0) {
  console.log(`\n  advisory — mutating routes with no recordAudit (audit-trail gap, not a failure):`);
  for (const n of noAudit) console.log(`        ${up(n.method)} ${n.path}  (${APP}:${n.line})`);
}

console.log("");
if (failures.length > 0) {
  console.log(`✗ ${failures.length} route(s) missing a guard. Add denyIfReadOnly(c) (+ denyIfNotAdmin(c) and`);
  console.log(`  recordAudit on admin surfaces) and a 403, or mark intentional exceptions with an inline`);
  console.log(`  \`// rbac-exempt: <reason>\` comment.`);
  process.exit(1);
}
console.log("✓ all mutating routes enforce the read-only role gate.");
