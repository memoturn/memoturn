/**
 * Telemetry migration entrypoint — dispatches on TELEMETRY_ENGINE (ADR-0002):
 *   doris (default) → infra/doris/*.sql via src/doris/migrate.ts
 *   postgres        → infra/postgres-telemetry/*.sql via src/postgres/migrate.ts
 *
 * Run with: bun run db:telemetry
 */
import { telemetryEngine } from "./engine.js";

async function main() {
  if (telemetryEngine() === "postgres") {
    const { migratePostgres } = await import("./postgres/migrate.js");
    await migratePostgres();
  } else {
    const { migrateDoris } = await import("./doris/migrate.js");
    await migrateDoris();
  }
}

main().catch((err) => {
  console.error("Telemetry migration failed:", err);
  process.exit(1);
});
