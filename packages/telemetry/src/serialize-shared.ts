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
