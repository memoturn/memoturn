import { type ClickHouseClient, createClient } from "@clickhouse/client";

/**
 * Shared ClickHouse client. memoturn writes telemetry through the worker and reads
 * it back for the trace API / dashboards. Async inserts are enabled so high-volume
 * batches are buffered server-side.
 */
let client: ClickHouseClient | undefined;

export function clickhouse(): ClickHouseClient {
  if (!client) {
    client = createClient({
      url: process.env.CLICKHOUSE_URL ?? "http://localhost:8123",
      username: process.env.CLICKHOUSE_USER ?? "memoturn",
      password: process.env.CLICKHOUSE_PASSWORD ?? "memoturn",
      database: process.env.CLICKHOUSE_DB ?? "memoturn",
      clickhouse_settings: {
        async_insert: 1,
        wait_for_async_insert: 1,
        // Accept ISO-8601 timestamps (with 'T' and 'Z') directly in inserts.
        date_time_input_format: "best_effort",
      },
    });
  }
  return client;
}

export type { ClickHouseClient };
