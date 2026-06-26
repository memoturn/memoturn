import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

/**
 * Seed the dev org / project / user / API key the E2E suite logs in as. Idempotent
 * (the seed upserts). When DATABASE_URL is already in the env (CI), run with it;
 * otherwise load the repo-root .env (local dev).
 */
export default function globalSetup() {
  const seed = resolve(repoRoot, "scripts/seed.ts");
  const envFile = resolve(repoRoot, ".env");

  if (!process.env.DATABASE_URL && !existsSync(envFile)) {
    throw new Error("E2E seed: set DATABASE_URL in the environment or create a repo-root .env");
  }

  const args = process.env.DATABASE_URL ? [seed] : [`--env-file=${envFile}`, seed];
  execFileSync("bun", args, { cwd: repoRoot, stdio: "inherit" });
}
