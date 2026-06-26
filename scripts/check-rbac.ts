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
const EXEMPT_PATHS = new Set(["/v1/ingest", "/v1/otel/v1/traces", "/v1/playground/chat", "/v1/playground/stream"]);

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

for (const r of routes) {
  if (!MUTATING.has(r.method)) continue;
  if (EXEMPT_PATHS.has(r.path) || /rbac-exempt/.test(r.block)) {
    exempt++;
    continue;
  }
  checked++;
  const missing: string[] = [];
  if (!/denyIfReadOnly\(/.test(r.block)) missing.push("denyIfReadOnly(c)");
  if (!/\b403:/.test(r.block)) missing.push("403 response");
  if (missing.length > 0) {
    failures.push({ method: r.method, path: r.path, line: lineOf(r.index), missing });
  } else if (!/recordAudit\(/.test(r.block)) {
    noAudit.push({ method: r.method, path: r.path, line: lineOf(r.index) });
  }
}

const up = (m: string): string => m.toUpperCase().padEnd(6);
console.log(`rbac guard check — ${checked} mutating route(s), ${exempt} exempt\n`);

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
  console.log(`✗ ${failures.length} route(s) missing the read-only guard. Add denyIfReadOnly(c) + a 403,`);
  console.log(`  or mark intentional exceptions with an inline \`// rbac-exempt: <reason>\` comment.`);
  process.exit(1);
}
console.log("✓ all mutating routes enforce the read-only role gate.");
