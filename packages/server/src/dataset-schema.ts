import { cellValue, parseCsv } from "@memoturn/core";

/**
 * Dataset item schemas + CSV import — what turns a dataset from a bag of JSON into a contract.
 *
 * An eval dataset that accumulates items from several people over months drifts: one row's
 * input is `{question}`, another's is `{query}`, a third is a bare string. Nothing notices
 * until an experiment produces nonsense. A declared schema makes the drift a rejected insert
 * with a per-field reason instead.
 *
 * The schema is a deliberate SUBSET of JSON Schema — object shape, field types, required
 * fields, enums — not the whole spec. It covers what dataset items actually look like, and a
 * subset we fully implement beats a superset we half-implement and silently ignore.
 */

/** Supported field types. `any` accepts whatever is present (but still enforces `required`). */
export type FieldType = "string" | "number" | "boolean" | "object" | "array" | "any";
const FIELD_TYPES = new Set<string>(["string", "number", "boolean", "object", "array", "any"]);

export interface FieldSchema {
  type?: FieldType;
  /** Allowed values, for a categorical field. */
  enum?: string[];
}

export interface ObjectSchema {
  type?: "object" | "string" | "number" | "boolean" | "array" | "any";
  required?: string[];
  properties?: Record<string, FieldSchema>;
}

/** What a dataset declares about its items. Any part may be omitted (= unconstrained). */
export interface DatasetItemSchema {
  input?: ObjectSchema;
  expectedOutput?: ObjectSchema;
  metadata?: ObjectSchema;
}

/** One reason a single item was rejected, addressed to the field that caused it. */
export interface ItemValidationError {
  /** Position in the submitted batch, so a caller can map it back to a CSV row. */
  index: number;
  field: string;
  message: string;
}

const typeOf = (v: unknown): FieldType => {
  if (Array.isArray(v)) return "array";
  if (v === null) return "any";
  const t = typeof v;
  return t === "string" || t === "number" || t === "boolean" || t === "object" ? (t as FieldType) : "any";
};

/** Coerce the stored Json column into a usable schema (a malformed one constrains nothing). */
export function parseItemSchema(json: unknown): DatasetItemSchema {
  if (!json || typeof json !== "object" || Array.isArray(json)) return {};
  const raw = json as Record<string, unknown>;
  const part = (key: string): ObjectSchema | undefined => {
    const v = raw[key];
    return v && typeof v === "object" && !Array.isArray(v) ? (v as ObjectSchema) : undefined;
  };
  const out: DatasetItemSchema = {};
  const input = part("input");
  const expectedOutput = part("expectedOutput");
  const metadata = part("metadata");
  if (input) out.input = input;
  if (expectedOutput) out.expectedOutput = expectedOutput;
  if (metadata) out.metadata = metadata;
  return out;
}

/** True when the schema constrains nothing — used to skip validation entirely. */
export function isEmptySchema(schema: DatasetItemSchema): boolean {
  return !schema.input && !schema.expectedOutput && !schema.metadata;
}

/** Reject a schema we can't honor, so a typo isn't stored as a constraint that never fires. */
export function validateSchemaShape(schema: DatasetItemSchema): string[] {
  const problems: string[] = [];
  for (const [part, obj] of Object.entries(schema) as [string, ObjectSchema][]) {
    if (obj.type && !FIELD_TYPES.has(obj.type)) problems.push(`${part}.type: unknown type "${obj.type}"`);
    for (const [name, field] of Object.entries(obj.properties ?? {})) {
      if (field.type && !FIELD_TYPES.has(field.type)) {
        problems.push(`${part}.${name}.type: unknown type "${field.type}"`);
      }
      if (field.enum && (!Array.isArray(field.enum) || field.enum.length === 0)) {
        problems.push(`${part}.${name}.enum: must be a non-empty list`);
      }
    }
    // `required` naming a field with no declared property is almost always a typo; it would
    // otherwise "work" while checking nothing about the field's shape.
    for (const name of obj.required ?? []) {
      if (obj.properties && !(name in obj.properties)) {
        problems.push(`${part}.required: "${name}" is required but not declared in properties`);
      }
    }
  }
  return problems;
}

function checkPart(
  part: string,
  schema: ObjectSchema | undefined,
  value: unknown,
  index: number,
): ItemValidationError[] {
  if (!schema) return [];
  const errors: ItemValidationError[] = [];
  const declaredType = schema.type ?? (schema.properties || schema.required ? "object" : "any");

  if (declaredType !== "any") {
    const actual = typeOf(value);
    if (value === undefined) {
      // A part that is absent entirely is only an error when the schema asks for fields.
      if ((schema.required ?? []).length > 0) {
        errors.push({ index, field: part, message: `${part} is required` });
      }
      return errors;
    }
    if (actual !== declaredType) {
      errors.push({ index, field: part, message: `expected ${declaredType}, got ${actual}` });
      return errors; // the field checks below would all be noise
    }
  }

  if (declaredType !== "object" || value === undefined) return errors;
  const obj = (value ?? {}) as Record<string, unknown>;
  for (const name of schema.required ?? []) {
    if (obj[name] === undefined || obj[name] === null || obj[name] === "") {
      errors.push({ index, field: `${part}.${name}`, message: "required" });
    }
  }
  for (const [name, field] of Object.entries(schema.properties ?? {})) {
    const v = obj[name];
    if (v === undefined) continue; // absence is `required`'s business, not the type's
    if (field.type && field.type !== "any" && typeOf(v) !== field.type) {
      errors.push({ index, field: `${part}.${name}`, message: `expected ${field.type}, got ${typeOf(v)}` });
      continue;
    }
    if (field.enum && !field.enum.includes(String(v))) {
      errors.push({ index, field: `${part}.${name}`, message: `must be one of: ${field.enum.join(", ")}` });
    }
  }
  return errors;
}

export interface DatasetItemLike {
  input: unknown;
  expectedOutput?: unknown;
  metadata?: Record<string, unknown>;
}

/** Every reason this item doesn't satisfy the schema. Empty means it's accepted. */
export function validateItem(schema: DatasetItemSchema, item: DatasetItemLike, index: number): ItemValidationError[] {
  return [
    ...checkPart("input", schema.input, item.input, index),
    ...checkPart("expectedOutput", schema.expectedOutput, item.expectedOutput, index),
    ...checkPart("metadata", schema.metadata, item.metadata, index),
  ];
}

/** Which CSV columns become which part of an item. Unmapped columns are ignored. */
export interface CsvMapping {
  /** One column (its cell becomes the input) or several (an object keyed by column name). */
  input: string | string[];
  expectedOutput?: string;
  metadata?: string[];
}

export interface CsvImportResult {
  items: DatasetItemLike[];
  /** Rows that couldn't be turned into an item at all (index is the 1-based CSV data row). */
  errors: ItemValidationError[];
}

/**
 * Turn CSV text into dataset items using a column mapping. Structural problems (a mapped column
 * that isn't in the file) fail the whole import — that is a mistake in the mapping, not in one
 * row, and importing half a file under a wrong mapping is worse than importing none of it.
 */
export function csvToItems(csv: string, mapping: CsvMapping): CsvImportResult {
  const { headers, rows } = parseCsv(csv);
  const known = new Set(headers);
  const mapped = [
    ...(Array.isArray(mapping.input) ? mapping.input : [mapping.input]),
    ...(mapping.expectedOutput ? [mapping.expectedOutput] : []),
    ...(mapping.metadata ?? []),
  ];
  const missing = mapped.filter((c) => !known.has(c));
  if (missing.length > 0) throw new Error(`CSV has no column named: ${[...new Set(missing)].join(", ")}`);
  if (mapped.length === 0) throw new Error("mapping selects no columns");

  const errors: ItemValidationError[] = [];
  const items: DatasetItemLike[] = [];
  rows.forEach((row, i) => {
    const input = Array.isArray(mapping.input)
      ? Object.fromEntries(mapping.input.map((c) => [c, cellValue(row[c] ?? "")]))
      : cellValue(row[mapping.input] ?? "");
    // A row whose input is entirely blank is a spreadsheet artifact, not an item.
    const blank = Array.isArray(mapping.input)
      ? mapping.input.every((c) => (row[c] ?? "").trim() === "")
      : String(input).trim() === "";
    if (blank) {
      errors.push({ index: i, field: "input", message: "row has no input value" });
      return;
    }
    items.push({
      input,
      expectedOutput: mapping.expectedOutput ? cellValue(row[mapping.expectedOutput] ?? "") : undefined,
      metadata: mapping.metadata?.length
        ? (Object.fromEntries(mapping.metadata.map((c) => [c, cellValue(row[c] ?? "")])) as Record<string, unknown>)
        : undefined,
    });
  });
  return { items, errors };
}
