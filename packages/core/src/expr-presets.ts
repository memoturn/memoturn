/**
 * Prebuilt CODE-evaluator expressions — the "check builder" surface.
 *
 * Every preset is just an expression string, so picking one and then editing it is a smooth
 * ramp rather than a mode switch: the menu is a starting point, not a walled garden. Presets
 * with `{{placeholders}}` expect the author to substitute a value before saving; the console
 * renders those as inputs.
 */

export interface ExprPreset {
  /** Stable key (e.g. "contains-phrase"). */
  key: string;
  /** Default evaluator name on instantiation. */
  name: string;
  /** Human-facing one-liner for the preset menu. */
  description: string;
  /** The expression, possibly containing `{{placeholder}}` tokens to fill in. */
  expression: string;
  /** Placeholders in `expression`, in the order the console should prompt for them. */
  placeholders: { key: string; label: string; example: string }[];
}

export const EXPR_PRESETS: ExprPreset[] = [
  {
    key: "contains-phrase",
    name: "contains-phrase",
    description: "Passes when the output contains a phrase (case-insensitive).",
    expression: 'contains(lower(output), lower("{{phrase}}"))',
    placeholders: [{ key: "phrase", label: "Phrase", example: "order number" }],
  },
  {
    key: "does-not-contain",
    name: "does-not-contain",
    description: "Passes when the output does NOT contain a phrase — a cheap refusal or leak check.",
    expression: 'not contains(lower(output), lower("{{phrase}}"))',
    placeholders: [{ key: "phrase", label: "Phrase", example: "i cannot" }],
  },
  {
    key: "regex-match",
    name: "regex-match",
    description: "Passes when the output matches a regular expression.",
    expression: 'matches(output, "{{pattern}}")',
    placeholders: [{ key: "pattern", label: "Pattern", example: "^[A-Z]{3}-[0-9]{4}$" }],
  },
  {
    key: "exact-match",
    name: "exact-match",
    description: "Passes when the output equals the expected output exactly (structural, not textual).",
    expression: "exactMatch(output, expected)",
    placeholders: [],
  },
  {
    key: "exact-match-normalized",
    name: "exact-match-normalized",
    description: "Exact match ignoring case and surrounding whitespace.",
    expression: "lower(trim(output)) == lower(trim(expected))",
    placeholders: [],
  },
  {
    key: "valid-json",
    name: "valid-json",
    description: "Passes when the output parses as JSON — the basic structured-output contract.",
    expression: "jsonValid(output)",
    placeholders: [],
  },
  {
    key: "json-field-equals",
    name: "json-field-equals",
    description: "Passes when a JSON path in the output equals a value.",
    expression: 'jsonValid(output) and jsonPath(jsonParse(output), "{{path}}") == "{{value}}"',
    placeholders: [
      { key: "path", label: "JSON path", example: "$.status" },
      { key: "value", label: "Expected value", example: "ok" },
    ],
  },
  {
    key: "json-has-fields",
    name: "json-has-fields",
    description: "Passes when the parsed output has two required fields.",
    expression: 'jsonValid(output) and has(jsonParse(output), "{{first}}") and has(jsonParse(output), "{{second}}")',
    placeholders: [
      { key: "first", label: "First field", example: "id" },
      { key: "second", label: "Second field", example: "status" },
    ],
  },
  {
    key: "max-length",
    name: "max-length",
    description: "Passes when the output is at most N characters — a conciseness guard.",
    expression: "len(output) <= {{max}}",
    placeholders: [{ key: "max", label: "Max characters", example: "500" }],
  },
  {
    key: "min-length",
    name: "min-length",
    description: "Passes when the output is at least N characters — catches empty or stub answers.",
    expression: "len(trim(output)) >= {{min}}",
    placeholders: [{ key: "min", label: "Min characters", example: "20" }],
  },
  {
    key: "not-empty",
    name: "not-empty",
    description: "Passes when the output is non-empty after trimming.",
    expression: "not isEmpty(trim(output))",
    placeholders: [],
  },
  {
    key: "word-count-range",
    name: "word-count-range",
    description: "Passes when the output's word count falls inside a range.",
    expression: "len(words(output)) >= {{min}} and len(words(output)) <= {{max}}",
    placeholders: [
      { key: "min", label: "Min words", example: "10" },
      { key: "max", label: "Max words", example: "200" },
    ],
  },
  {
    key: "expected-substring",
    name: "expected-substring",
    description: "Passes when the output contains the expected output — a lenient correctness check.",
    expression: "contains(lower(output), lower(expected))",
    placeholders: [],
  },
  {
    key: "graded-length",
    name: "graded-length",
    description: "A graded (non-binary) score: fraction of a target length reached, capped at 1.",
    expression: "min(1, len(words(output)) / {{target}})",
    placeholders: [{ key: "target", label: "Target word count", example: "50" }],
  },
];

export function getExprPreset(key: string): ExprPreset | undefined {
  return EXPR_PRESETS.find((p) => p.key === key);
}

/**
 * Substitute `{{placeholder}}` tokens in a preset's expression. Unknown placeholders are left
 * as-is so the resulting expression fails to compile loudly rather than silently scoring on a
 * literal `{{max}}`.
 */
export function fillExprPreset(preset: ExprPreset, values: Record<string, string>): string {
  return preset.expression.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : match,
  );
}
