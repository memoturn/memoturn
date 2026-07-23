/** Wait until the dev infra (Postgres, Redis, Doris, MinIO) is reachable. */
import { createConnection } from "node:net";

const TIMEOUT_MS = 60_000;
const INTERVAL_MS = 1_000;

function tcp(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ host, port });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(2_000);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

async function http(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return res.ok;
  } catch {
    return false;
  }
}

// The doris check only applies when the doris telemetry engine is active — the
// postgres profile (ADR-0002, TELEMETRY_ENGINE=postgres) runs no Doris containers.
const engine = (process.env.TELEMETRY_ENGINE ?? "doris").toLowerCase();
const dorisActive = engine !== "postgres" && engine !== "pg";

const checks: { name: string; check: () => Promise<boolean> }[] = [
  { name: "postgres", check: () => tcp("localhost", Number(process.env.PG_PORT ?? 5433)) },
  { name: "redis", check: () => tcp("localhost", Number(process.env.REDIS_PORT ?? 6380)) },
  // FE answers /api/bootstrap once metadata is ready; the BE registers itself shortly
  // after, and doris-fe reports queryable only when a BE heartbeat is alive (SELECT 1
  // works FE-only, so also require the MySQL port).
  ...(dorisActive
    ? [
        {
          name: "doris",
          check: async () => (await http("http://localhost:8030/api/bootstrap")) && tcp("localhost", 9030),
        },
      ]
    : []),
  { name: "minio", check: () => http("http://localhost:9000/minio/health/live") },
];

const deadline = Date.now() + TIMEOUT_MS;
const pending = new Set(checks.map((c) => c.name));

while (pending.size > 0) {
  await Promise.all(
    checks
      .filter((c) => pending.has(c.name))
      .map(async (c) => {
        if (await c.check()) {
          pending.delete(c.name);
          console.log(`  ${c.name}`);
        }
      }),
  );
  if (pending.size === 0) break;
  if (Date.now() > deadline) {
    console.error(`infra not ready in ${TIMEOUT_MS / 1000}s: ${[...pending].join(", ")}`);
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, INTERVAL_MS));
}

console.log("infra ready.");
