/**
 * A small RFC 4180 CSV reader, for importing dataset items from a spreadsheet export.
 *
 * Hand-written rather than pulled in as a dependency: the surface we need is one function, and
 * the failure modes that matter — a quoted field containing a comma, a newline inside a quoted
 * field, an escaped quote — are exactly the cases a naive `split(",")` gets wrong and a test
 * can pin down. Spreadsheet exports hit all three routinely.
 */

export interface ParsedCsv {
  headers: string[];
  /** One record per row, keyed by header. Missing trailing cells read as "". */
  rows: Record<string, string>[];
}

/** Split CSV text into rows of raw cells. Handles quoted fields, escaped quotes, and CRLF. */
function splitRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  // Strip a UTF-8 BOM — Excel writes one and it would otherwise become part of the first header.
  if (text.charCodeAt(0) === 0xfeff) i = 1;

  for (; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'; // "" is a literal quote inside a quoted field
          i++;
        } else {
          quoted = false;
        }
        continue;
      }
      field += ch;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (ch === "\r") continue; // CRLF → LF
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    field += ch;
  }
  // Trailing record with no newline. A file ending in a newline must not produce a blank row.
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Parse CSV text into header-keyed records. Throws when there is no header row, or when a
 * header repeats — a duplicate column name would make the mapping silently ambiguous.
 */
export function parseCsv(text: string): ParsedCsv {
  const raw = splitRows(text).filter((r) => !(r.length === 1 && r[0]?.trim() === ""));
  const headerRow = raw[0];
  if (!headerRow || headerRow.every((h) => h.trim() === "")) throw new Error("CSV has no header row");

  const headers = headerRow.map((h) => h.trim());
  const dupes = headers.filter((h, i) => headers.indexOf(h) !== i);
  if (dupes.length > 0) throw new Error(`duplicate CSV column: ${[...new Set(dupes)].join(", ")}`);

  const rows = raw.slice(1).map((cells) => {
    const record: Record<string, string> = {};
    headers.forEach((h, i) => {
      record[h] = cells[i] ?? "";
    });
    return record;
  });
  return { headers, rows };
}

/**
 * Interpret a cell: JSON when it parses as an object or array, the raw string otherwise.
 *
 * Deliberately narrow — a bare `123` or `true` stays a string, because a dataset column of
 * order numbers or ids should not silently become numeric and change how it compares.
 */
export function cellValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return raw;
  try {
    return JSON.parse(trimmed);
  } catch {
    return raw;
  }
}
