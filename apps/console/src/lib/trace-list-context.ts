/**
 * The trace list's current page of ids, recorded so the full-page trace detail can offer
 * prev/next stepping through the list the user came from. sessionStorage (not URL) — it's
 * ephemeral navigation context, not shareable state.
 */
const KEY = "memoturn.traces.listContext";

export function writeTraceListContext(ids: string[]) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(ids));
  } catch {
    /* storage unavailable — prev/next just won't render */
  }
}

export function readTraceListContext(): string[] {
  try {
    const raw = sessionStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}
