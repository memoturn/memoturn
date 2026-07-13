/**
 * Deterministic doc-drift checker for the memoturn monorepo.
 *
 * The repo restates concrete facts (script names, dev credentials, ports, cron
 * schedules, MCP tool names) by hand across CLAUDE.md / README.md / CONTRIBUTING.md
 * and docs/*.md. Those facts live in code; this script asserts the prose still
 * matches the code, so stale docs are caught mechanically instead of by review.
 *
 * Read-only. Exits non-zero when any check finds drift — safe to wire into
 * lefthook pre-push or CI as-is. Run with: `bun run docs:check`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
const tryRead = (rel: string): string | null => {
  try {
    return read(rel);
  } catch {
    return null;
  }
};

// The public docs site (apps/docs) restates the same facts — every content page
// is checked, discovered dynamically so new pages can't dodge the checker.
const SITE_DOC_FILES = readdirSync(join(ROOT, "apps/docs/src/content/docs"))
  .filter((f) => f.endsWith(".md") || f.endsWith(".mdx"))
  .map((f) => `apps/docs/src/content/docs/${f}`);

// Every prose surface that hand-restates code facts.
const DOC_FILES = [
  "CLAUDE.md",
  "README.md",
  "CONTRIBUTING.md",
  "docs/README.md",
  "docs/getting-started.md",
  "docs/architecture.md",
  "docs/concepts.md",
  "docs/configuration.md",
  "docs/deployment.md",
  "docs/evaluation.md",
  "docs/api.md",
  "docs/integrations.md",
  "docs/prompts.md",
  "docs/sdk-typescript.md",
  "docs/sdk-python.md",
  "docs/roadmap.md",
  ...SITE_DOC_FILES,
];

interface Finding {
  doc: string;
  line: number;
  message: string;
}

interface CheckResult {
  name: string;
  findings: Finding[];
}

/** Yield each line of `text` with a 1-based line number. */
function lines(text: string): { n: number; text: string }[] {
  return text.split("\n").map((text, i) => ({ n: i + 1, text }));
}

/** 1. Script names referenced in docs must exist in root package.json `scripts`. */
function checkScriptNames(): CheckResult {
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
  const known = new Set(Object.keys(pkg.scripts));
  const findings: Finding[] = [];
  const re = /(?:bun|pnpm|npm) run ([a-z0-9:_-]+)/g;
  for (const doc of DOC_FILES) {
    const body = tryRead(doc);
    if (!body) continue;
    for (const { n, text } of lines(body)) {
      for (const m of text.matchAll(re)) {
        const script = m[1]!;
        if (!known.has(script)) {
          findings.push({ doc, line: n, message: `references \`run ${script}\` — no such script in package.json` });
        }
      }
    }
  }
  return { name: "Script names (docs → package.json)", findings };
}

/** 2. Dev credentials in docs must match the constants in scripts/seed.ts. */
function checkCredentials(): CheckResult {
  const seed = read("scripts/seed.ts");
  const constOf = (name: string): string => seed.match(new RegExp(`${name}\\s*=\\s*"([^"]+)"`))?.[1] ?? "";
  const publicKey = constOf("DEV_PUBLIC_KEY");
  const secretKey = constOf("DEV_SECRET_KEY");
  const email = constOf("DEV_EMAIL");
  const password = constOf("DEV_PASSWORD");

  // token shape → canonical value: any matching token in a doc must equal canonical.
  const rules: { label: string; re: RegExp; expected: string }[] = [
    { label: "public key", re: /pk-mt-[a-z0-9-]+/g, expected: publicKey },
    { label: "secret key", re: /sk-mt-[a-z0-9-]+/g, expected: secretKey },
    { label: "login email", re: /[a-z0-9._-]+@memoturn\.dev/g, expected: email },
    { label: "login password", re: /memoturn-dev-\d+/g, expected: password },
  ];

  const findings: Finding[] = [];
  for (const doc of DOC_FILES) {
    const body = tryRead(doc);
    if (!body) continue;
    for (const { n, text } of lines(body)) {
      for (const { label, re, expected } of rules) {
        for (const m of text.matchAll(re)) {
          if (expected && m[0] !== expected) {
            findings.push({ doc, line: n, message: `${label} \`${m[0]}\` ≠ seed.ts \`${expected}\`` });
          }
        }
      }
    }
  }
  return { name: "Dev credentials (docs → scripts/seed.ts)", findings };
}

/** 3. Any localhost:<port> in docs must be one of the canonical ports from .env.example. */
function checkPorts(): CheckResult {
  const env = read(".env.example");
  const canonical = new Set<string>(["9001"]); // MinIO console — known-good, not in .env.example
  for (const m of env.matchAll(/localhost:(\d{4,5})/g)) canonical.add(m[1]!);
  for (const m of env.matchAll(/_PORT=(\d{4,5})/g)) canonical.add(m[1]!);

  const findings: Finding[] = [];
  for (const doc of DOC_FILES) {
    const body = tryRead(doc);
    if (!body) continue;
    for (const { n, text } of lines(body)) {
      for (const m of text.matchAll(/localhost:(\d{4,5})/g)) {
        if (!canonical.has(m[1]!)) {
          findings.push({
            doc,
            line: n,
            message: `port ${m[1]} is not a canonical port (${[...canonical].sort().join(", ")})`,
          });
        }
      }
    }
  }
  return { name: "Ports (docs → .env.example)", findings };
}

/** 4. Every worker cron pattern must be documented in CLAUDE.md. */
function checkCrons(): CheckResult {
  const worker = read("apps/worker/src/index.ts");
  const claude = read("CLAUDE.md");
  const patterns = [...worker.matchAll(/pattern:\s*"([^"]+)"/g)].map((m) => m[1]!);
  const findings: Finding[] = [];
  for (const pattern of patterns) {
    if (!claude.includes(pattern)) {
      findings.push({ doc: "CLAUDE.md", line: 0, message: `worker cron \`${pattern}\` is not documented` });
    }
  }
  return { name: "Worker crons (apps/worker/src/index.ts → CLAUDE.md)", findings };
}

/** 5. Every MCP tool name must be listed in apps/mcp/README.md. */
function checkMcpTools(): CheckResult {
  const tools = read("packages/server/src/mcp-tools.ts");
  const readme = read("apps/mcp/README.md");
  const names = [...tools.matchAll(/name:\s*"([a-z_]+)"/g)].map((m) => m[1]!);
  const findings: Finding[] = [];
  for (const name of names) {
    if (!readme.includes(name)) {
      findings.push({ doc: "apps/mcp/README.md", line: 0, message: `MCP tool \`${name}\` is not documented` });
    }
  }
  return { name: "MCP tools (packages/server/src/mcp-tools.ts → apps/mcp/README.md)", findings };
}

/** 6. Every agent + skill must be listed in the .claude/README roster. */
function checkClaudeRoster(): CheckResult {
  const readme = tryRead(".claude/README.md");
  const findings: Finding[] = [];
  if (readme === null) {
    return { name: "Claude roster (.claude/agents,skills → .claude/README.md)", findings };
  }
  const ls = (rel: string): string[] => {
    try {
      return readdirSync(join(ROOT, rel));
    } catch {
      return [];
    }
  };
  const agents = ls(".claude/agents")
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""));
  const skills = ls(".claude/skills").filter((d) => !d.includes("."));
  for (const name of agents) {
    if (!readme.includes(name)) {
      findings.push({ doc: ".claude/README.md", line: 0, message: `agent \`${name}\` is not in the roster` });
    }
  }
  for (const name of skills) {
    if (!readme.includes(name)) {
      findings.push({ doc: ".claude/README.md", line: 0, message: `skill \`${name}\` is not in the roster` });
    }
  }
  return { name: "Claude roster (.claude/agents,skills → .claude/README.md)", findings };
}

const checks = [checkScriptNames, checkCredentials, checkPorts, checkCrons, checkMcpTools, checkClaudeRoster];

let drift = 0;
console.log("doc-drift check\n");
for (const run of checks) {
  const { name, findings } = run();
  if (findings.length === 0) {
    console.log(`  OK    ${name}`);
    continue;
  }
  drift += findings.length;
  console.log(`  DRIFT ${name}`);
  for (const f of findings) {
    const at = f.line > 0 ? `${f.doc}:${f.line}` : f.doc;
    console.log(`        ${at} — ${f.message}`);
  }
}

console.log("");
if (drift > 0) {
  console.log(`✗ ${drift} drift issue(s) found. Update the docs (or run the doc-sync-auditor agent).`);
  process.exit(1);
}
console.log("✓ docs are in sync with code.");
