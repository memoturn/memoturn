/**
 * Engine-neutral serialization helpers shared by the Doris and Postgres dialects.
 *
 * The 'YYYY-MM-DD HH:MM:SS.mmm' literal form is valid input for both Doris DATETIME(3)
 * and Postgres timestamp(3); rows carry ISO-8601 UTC strings and sessions are pinned to
 * UTC on both engines.
 */

/** ISO-8601 → engine DATETIME/timestamp literal ('YYYY-MM-DD HH:MM:SS.mmm', UTC). */
export function toDorisDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid timestamp: ${iso}`);
  return d.toISOString().slice(0, 23).replace("T", " ");
}

/** Engine DATETIME string (or ISO input) → ISO-8601 UTC. */
export function toIso(dorisDateTime: string): string {
  return `${dorisDateTime.replace(" ", "T").slice(0, 19)}Z`;
}

/** Parse an engine string-array value (native array or JSON text) into strings. */
export function parseTags(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string" || value === "") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * Keyset predicate for `scanRows`: rows strictly after `cursor` in primary-key order,
 * as a tuple comparison expanded to plain AND/OR (engine-portable — Doris has no
 * reliable row-value comparison). Column names come from TELEMETRY_PRIMARY_KEYS,
 * never user input.
 */
export function keysetAfter(pk: string[], cursor: string[]): { frag: string; params: unknown[] } {
  if (pk.length !== cursor.length) throw new Error(`scan cursor arity ${cursor.length} != key arity ${pk.length}`);
  const alts: string[] = [];
  const params: unknown[] = [];
  for (let i = 0; i < pk.length; i++) {
    const eqs = pk.slice(0, i).map((c) => `${c} = ?`);
    alts.push(`(${[...eqs, `${pk[i]} > ?`].join(" AND ")})`);
    params.push(...cursor.slice(0, i + 1));
  }
  return { frag: `(${alts.join(" OR ")})`, params };
}

/** Parse an engine float-array value (native array, JSON text, or pgvector '[…]' text). */
export function parseVector(value: unknown): number[] {
  const arr = Array.isArray(value)
    ? value
    : typeof value === "string" && value !== ""
      ? (() => {
          try {
            return JSON.parse(value);
          } catch {
            return [];
          }
        })()
      : [];
  return Array.isArray(arr) ? arr.map(Number).filter((n) => Number.isFinite(n)) : [];
}
