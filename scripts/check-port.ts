#!/usr/bin/env bun
// Probes a single dev server for `bun run dev:status` (per-app turbo task).
const [name, portStr, path = "/"] = process.argv.slice(2);
if (!name || !portStr) {
  console.error("usage: check-port.ts <name> <port> [path]");
  process.exit(2);
}

const port = Number(portStr);
const url = `http://localhost:${port}${path}`;

try {
  const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
  console.log(`[dev:status] ${name} :${port}${path} -> ${res.status}`);
  process.exit(res.ok ? 0 : 1);
} catch (err) {
  console.error(`[dev:status] ${name} :${port}${path} -> unreachable (${(err as Error).message})`);
  process.exit(1);
}
