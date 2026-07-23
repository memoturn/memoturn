/**
 * Dev-infra compose wrapper (ADR-0002 deployment profiles). The doris-fe/doris-be
 * services carry the compose profile "doris"; this wrapper activates it unless the
 * telemetry engine is postgres, so `bun run infra:up` starts exactly the containers
 * the selected engine needs. Teardown/logs/status always include every profile so
 * switching engines never orphans containers.
 *
 * Bun auto-loads .env from the repo root, so TELEMETRY_ENGINE set there applies.
 */
import { spawnSync } from "node:child_process";

const [command, ...rest] = process.argv.slice(2);
if (!command) {
  console.error("usage: bun scripts/infra.ts <up|down|logs|status> [extra compose args]");
  process.exit(2);
}

const engine = (process.env.TELEMETRY_ENGINE ?? "doris").toLowerCase();
const dorisActive = engine !== "postgres" && engine !== "pg";
// `up` starts only what the engine needs; everything else operates on all profiles.
const profiles = command === "up" && !dorisActive ? [] : ["--profile", "doris"];

const compose: Record<string, string[]> = {
  up: ["up", "-d"],
  down: ["down"],
  logs: ["logs", "-f"],
  status: ["ps"],
};
const sub = compose[command];
if (!sub) {
  console.error(`unknown command: ${command}`);
  process.exit(2);
}

const args = ["compose", "-f", "infra/docker-compose.dev.yml", ...profiles, ...sub, ...rest];
const res = spawnSync("docker", args, { stdio: "inherit" });
process.exit(res.status ?? 1);
