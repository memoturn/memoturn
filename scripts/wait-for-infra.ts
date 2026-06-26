/** Wait until the dev infra (Postgres, Redis, ClickHouse, MinIO) is reachable. */
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

const checks: { name: string; check: () => Promise<boolean> }[] = [
  { name: "postgres", check: () => tcp("localhost", Number(process.env.PG_PORT ?? 5433)) },
  { name: "redis", check: () => tcp("localhost", Number(process.env.REDIS_PORT ?? 6380)) },
  { name: "clickhouse", check: () => http("http://localhost:8123/ping") },
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
