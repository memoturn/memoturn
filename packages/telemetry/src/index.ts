import { ClickHouseTelemetryStore } from "./clickhouse.js";
import type { TelemetryStore } from "./store.js";

export type { TelemetryStore } from "./store.js";
export type * from "./types.js";

/**
 * Singleton telemetry store. The connection is created lazily on first use, mirroring
 * the other @memoturn/db clients. Currently backed by the transitional ClickHouse
 * scaffold; the Apache Doris implementation replaces it in the engine swap.
 */
let store: TelemetryStore | undefined;

export function telemetry(): TelemetryStore {
  if (!store) store = new ClickHouseTelemetryStore();
  return store;
}
