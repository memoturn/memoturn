/**
 * PostToolUse hook (matcher: Edit|Write|MultiEdit).
 *
 * When an edited file is coupled to hand-maintained docs (per
 * .claude/doc-coupling.json), inject an advisory reminder into the conversation
 * so the matching docs get reviewed. Non-blocking: always exits 0.
 *
 * Wired in .claude/settings.json. Reads the hook payload as JSON on stdin.
 */
import { readFileSync } from "node:fs";
import { relative } from "node:path";

interface Coupling {
  match: string[];
  note: string;
}

// biome-ignore lint/suspicious/noUndeclaredEnvVars: CLAUDE_PROJECT_DIR is set by the Claude Code harness, not the build.
const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

const escapeRegex = (s: string): string => s.replace(/[.+^${}()|[\]\\]/g, "\\$&");

/** Glob match against a repo-relative path. Supports `*` (one segment) and `**` (any). */
function globMatch(pattern: string, path: string): boolean {
  const rx = pattern
    .split("**")
    .map((chunk) => chunk.split("*").map(escapeRegex).join("[^/]*"))
    .join(".*");
  return new RegExp(`^${rx}$`).test(path);
}

function main(): void {
  const raw = readFileSync(0, "utf8");
  if (!raw.trim()) return;

  let payload: { cwd?: string; tool_input?: { file_path?: string } };
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }

  const filePath = payload.tool_input?.file_path;
  if (!filePath) return;

  const root = payload.cwd ?? projectDir;
  const rel = relative(root, filePath);
  if (rel.startsWith("..")) return; // outside the repo

  let manifest: { couplings: Coupling[] };
  try {
    manifest = JSON.parse(readFileSync(`${projectDir}/.claude/doc-coupling.json`, "utf8"));
  } catch {
    return;
  }

  const notes = manifest.couplings.filter((c) => c.match.some((p) => globMatch(p, rel))).map((c) => c.note);
  if (notes.length === 0) return;

  const context = [
    `You edited \`${rel}\`, which is coupled to hand-maintained docs. Keep them in sync:`,
    ...notes.map((n) => `- ${n}`),
  ].join("\n");

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: context },
    }),
  );
}

main();
