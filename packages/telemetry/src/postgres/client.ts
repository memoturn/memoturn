import pg from "pg";

/**
 * Shared Postgres connection pool for the telemetry tier (ADR-0002).
 *
 * Mirrors doris/client.ts: lazy singleton pool, UTC pinned, retry-once on fatal
 * connection errors. The session `search_path` leads with the `telemetry` schema so all
 * ported SQL keeps bare table names (maximal 1:1 diff against the Doris dialect), and
 * `TimeZone=UTC` is set in the startup packet — active before the first query, no
 * checkout race. Telemetry columns are `timestamp without time zone` (UTC by
 * convention), so reads are TimeZone-invariant regardless; the pin covers now().
 *
 * All ported SQL keeps the mysql2 `?` placeholder convention; `pgQuery` rewrites to
 * `$n` and reproduces mysql2's array expansion for `IN (?)`. Values destined for real
 * array columns (tags) are wrapped in `SqlArray` to disambiguate from IN-lists.
 */
let pool: pg.Pool | undefined;

export interface PgTelemetryConfig {
  connectionString: string;
  schema: string;
}

/** Marker for a parameter that is an array COLUMN VALUE (e.g. tags text[]), not an IN-list. */
export class SqlArray {
  constructor(readonly values: readonly unknown[]) {}
}

export function pgTelemetryConfig(): PgTelemetryConfig {
  const raw = process.env.TELEMETRY_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!raw) throw new Error("TELEMETRY_DATABASE_URL or DATABASE_URL must be set for the postgres telemetry engine");
  // Strip the Prisma-only `schema` query param — node-pg would reject/ignore it and the
  // telemetry schema is selected via search_path, not the URL.
  const url = new URL(raw);
  url.searchParams.delete("schema");
  const schema = process.env.TELEMETRY_PG_SCHEMA ?? "telemetry";
  if (!/^[a-zA-Z0-9_]+$/.test(schema)) throw new Error(`invalid TELEMETRY_PG_SCHEMA: ${schema}`);
  return { connectionString: url.toString(), schema };
}

function poolOptions(config: Partial<PgTelemetryConfig> = {}): pg.PoolConfig {
  const resolved = { ...pgTelemetryConfig(), ...config };
  return {
    connectionString: resolved.connectionString,
    max: 10,
    idleTimeoutMillis: 60_000,
    keepAlive: true,
    // Startup-packet session config: active before the first query on every connection.
    options: `-c search_path=${resolved.schema},public -c TimeZone=UTC`,
  };
}

/** True for errors that mean the pooled connection is dead — safe to retry on a fresh one. */
export function isFatalConnectionError(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  if (!e) return false;
  const code = e.code ?? "";
  if (code === "ECONNRESET" || code === "EPIPE" || code === "ETIMEDOUT" || code === "ECONNREFUSED") return true;
  // 57P01 admin_shutdown, 57P02 crash_shutdown, 57P03 cannot_connect_now, class 08 connection exceptions.
  if (code === "57P01" || code === "57P02" || code === "57P03" || code.startsWith("08")) return true;
  const msg = e.message ?? "";
  return msg.includes("Connection terminated") || msg.includes("ECONNRESET");
}

/** Create a standalone pool (used by the migration runner). */
export function createPgPool(config: Partial<PgTelemetryConfig> = {}): pg.Pool {
  const p = new pg.Pool(poolOptions(config));
  // Without a handler, an error on an idle client is an uncaught exception that
  // crashes the process (node-pg-specific hazard; mysql2 swallows these).
  p.on("error", () => {});
  return p;
}

export function pgPool(): pg.Pool {
  if (!pool) pool = createPgPool();
  return pool;
}

/**
 * Rewrite mysql2-style `?` placeholders to Postgres `$n`, expanding plain-array
 * params to `($n, $n+1, …)` (mysql2 `IN (?)` semantics) and passing `SqlArray`
 * values through as single array params. Skips `?` inside single-quoted string
 * literals ('' escapes handled) and `--` line comments. All SQL is first-party, so
 * this covers everything the ported dialect produces; the jsonb `?` operator is
 * banned in ported SQL by convention (JSON access goes through telemetry.json_text).
 */
export function rewritePlaceholders(sql: string, params: unknown[]): { text: string; values: unknown[] } {
  let text = "";
  const values: unknown[] = [];
  let paramIdx = 0;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'") {
      // Copy the string literal verbatim ('' is an escaped quote).
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j++;
      }
      text += sql.slice(i, j + 1);
      i = j + 1;
    } else if (ch === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      const end = nl === -1 ? sql.length : nl;
      text += sql.slice(i, end);
      i = end;
    } else if (ch === "?") {
      if (paramIdx >= params.length) throw new Error(`placeholder count exceeds params (${params.length})`);
      const value = params[paramIdx++];
      if (value instanceof SqlArray) {
        values.push(value.values);
        text += `$${values.length}`;
      } else if (Array.isArray(value)) {
        if (value.length === 0) throw new Error("empty array bound to IN (?) — guard the call site");
        // Expand WITHOUT parens (mysql2 semantics) — the SQL already wraps the `?` in
        // `IN (…)`; adding parens would turn a multi-element list into a record comparison.
        const parts: string[] = [];
        for (const v of value) {
          values.push(v);
          parts.push(`$${values.length}`);
        }
        text += parts.join(", ");
      } else {
        values.push(value);
        text += `$${values.length}`;
      }
      i++;
    } else {
      text += ch;
      i++;
    }
  }
  if (paramIdx !== params.length) {
    throw new Error(`params (${params.length}) exceed placeholders (${paramIdx})`);
  }
  return { text, values };
}

/**
 * Run a query against the app pool, retrying once if the pooled connection was dead
 * (server restart / network reset). Returns rows only — the callers' result shape is
 * normalized at the store boundary like the Doris impl.
 */
export async function pgQuery<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const { text, values } = rewritePlaceholders(sql, params);
  try {
    const res = await pgPool().query(text, values);
    return res.rows as T[];
  } catch (err) {
    if (!isFatalConnectionError(err)) throw err;
    const res = await pgPool().query(text, values);
    return res.rows as T[];
  }
}

export async function closePgPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
