import { DorisTelemetryStore } from "./doris/store.js";
import { telemetryEngine } from "./engine.js";
import { PostgresTelemetryStore } from "./postgres/store.js";
import type { TelemetryStore } from "./store.js";

export * from "./copy.js";
// Direct store classes + copy/verify helpers for the engine-to-engine migration CLI
// (ADR-0004): the CLI needs BOTH engines in one process, so it can't use the singleton.
export { DorisTelemetryStore } from "./doris/store.js";
export { PostgresTelemetryStore } from "./postgres/store.js";
export type { TelemetryStore } from "./store.js";
export type * from "./types.js";

/**
 * Singleton telemetry store. The engine is selected by TELEMETRY_ENGINE (ADR-0002):
 * Apache Doris (default) or the Postgres tier for small installs. The connection pool
 * is created lazily on first use, mirroring the other @memoturn/db clients.
 */
let store: TelemetryStore | undefined;

export function telemetry(): TelemetryStore {
  if (!store) {
    store = telemetryEngine() === "postgres" ? new PostgresTelemetryStore() : new DorisTelemetryStore();
  }
  return store;
}
