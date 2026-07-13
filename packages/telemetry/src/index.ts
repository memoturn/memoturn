import { DorisTelemetryStore } from "./doris/store.js";
import type { TelemetryStore } from "./store.js";

export type { TelemetryStore } from "./store.js";
export type * from "./types.js";

/**
 * Singleton telemetry store, backed by Apache Doris. The connection pool is created
 * lazily on first use, mirroring the other @memoturn/db clients.
 */
let store: TelemetryStore | undefined;

export function telemetry(): TelemetryStore {
  if (!store) store = new DorisTelemetryStore();
  return store;
}
