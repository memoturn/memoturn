import { isValidRegex, maxStarHeight } from "./regexsafety.js";

/**
 * The expression language behind CODE evaluators.
 *
 * A deterministic, dependency-free interpreter over a deliberately small subset: literals,
 * member access, comparisons, boolean/arithmetic operators, a ternary, and a fixed set of
 * builtin functions. It is NOT JavaScript — there is no `eval`, no `Function`, no host object
 * graph, no loops, no closures, no assignment, and no way to name anything the interpreter did
 * not bind. That is the point: an evaluator is user-authored config that runs inside the shared
 * ingest worker, so the language has to be safe by construction rather than by sandboxing.
 *
 * It is also fully portable — no `node:vm`, no WASM, no native deps — so it behaves identically
 * in the worker, the API, and a future edge deployment profile (ADR-0003).
 *
 * Termination is guaranteed structurally (no loops or recursion in the language) and bounded
 * additionally by a node budget, so even a deeply nested expression cannot run away.
 */

/** Values the language can produce. Mirrors JSON, since every input is JSON-derived. */
export type ExprValue = string | number | boolean | null | ExprValue[] | { [k: string]: ExprValue };

/** Variables bound for an evaluation. Everything else is out of scope by construction. */
export interface ExprContext {
  input: ExprValue;
  output: ExprValue;
  expected: ExprValue;
  metadata: ExprValue;
}

export class ExprError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExprError";
  }
}

/** Longest accepted expression source — a guard on parse cost, not a meaningful ceiling. */
export const MAX_EXPRESSION_LENGTH = 4000;
/** Max AST nodes evaluated per run. Bounds pathological nesting; normal checks use <100. */
const MAX_EVAL_STEPS = 20_000;
/** Max parser nesting depth — prevents a stack overflow from `((((((…))))))`. */
const MAX_DEPTH = 64;
/** Subject-length cap for `matches()`. Bounds regex work even on a backtracking-free pattern. */
const MAX_REGEX_SUBJECT = 20_000;

// ── Tokenizer ─────────────────────────────────────────────────────────────────

type TokenType = "num" | "str" | "ident" | "op" | "eof";
interface Token {
  type: TokenType;
  value: string;
  pos: number;
}

const OPERATORS = [
  "==",
  "!=",
  "<=",
  ">=",
  "&&",
  "||",
  "<",
  ">",
  "+",
  "-",
  "*",
  "/",
  "%",
  "(",
  ")",
  "[",
  "]",
  ",",
  ".",
  "?",
  ":",
  "!",
];

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    // Numbers (no leading '+/-': unary minus is parsed as an operator).
    if (c >= "0" && c <= "9") {
      const start = i;
      while (i < src.length && (src[i] as string) >= "0" && (src[i] as string) <= "9") i++;
      if (src[i] === ".") {
        i++;
        while (i < src.length && (src[i] as string) >= "0" && (src[i] as string) <= "9") i++;
      }
      tokens.push({ type: "num", value: src.slice(start, i), pos: start });
      continue;
    }
    // Strings, single- or double-quoted, with backslash escapes.
    if (c === '"' || c === "'") {
      const start = i;
      const quote = c;
      i++;
      let out = "";
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\") {
          const esc = src[i + 1];
          out +=
            esc === "n" ? "\n" : esc === "t" ? "\t" : esc === "r" ? "\r" : esc === undefined ? "" : (esc as string);
          i += 2;
        } else {
          out += src[i];
          i++;
        }
      }
      if (i >= src.length) throw new ExprError(`unterminated string starting at position ${start}`);
      i++; // closing quote
      tokens.push({ type: "str", value: out, pos: start });
      continue;
    }
    // Identifiers and word operators (and / or / not / true / false / null).
    if (/[A-Za-z_]/.test(c)) {
      const start = i;
      while (i < src.length && /[A-Za-z0-9_]/.test(src[i] as string)) i++;
      tokens.push({ type: "ident", value: src.slice(start, i), pos: start });
      continue;
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (!op) throw new ExprError(`unexpected character ${JSON.stringify(c)} at position ${i}`);
    tokens.push({ type: "op", value: op, pos: i });
    i += op.length;
  }
  tokens.push({ type: "eof", value: "", pos: src.length });
  return tokens;
}

// ── AST ───────────────────────────────────────────────────────────────────────

export type ExprNode =
  | { t: "lit"; v: ExprValue }
  | { t: "var"; name: string }
  | { t: "member"; obj: ExprNode; name: string }
  | { t: "index"; obj: ExprNode; idx: ExprNode }
  | { t: "call"; name: string; args: ExprNode[]; pos: number }
  | { t: "unary"; op: "-" | "not"; arg: ExprNode }
  | { t: "bin"; op: string; l: ExprNode; r: ExprNode }
  | { t: "cond"; test: ExprNode; a: ExprNode; b: ExprNode };

const VARIABLES = ["input", "output", "expected", "metadata"];

// Binary precedence, loosest first. Ternary and unary are handled structurally.
const BINARY_PRECEDENCE: Record<string, number> = {
  or: 1,
  "||": 1,
  and: 2,
  "&&": 2,
  "==": 3,
  "!=": 3,
  "<": 4,
  "<=": 4,
  ">": 4,
  ">=": 4,
  "+": 5,
  "-": 5,
  "*": 6,
  "/": 6,
  "%": 6,
};

class Parser {
  private pos = 0;
  private depth = 0;

  constructor(private readonly tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    return this.tokens[this.pos++] as Token;
  }

  private expect(value: string): Token {
    const tok = this.next();
    if (tok.value !== value) {
      throw new ExprError(`expected ${JSON.stringify(value)} at position ${tok.pos}, got ${JSON.stringify(tok.value)}`);
    }
    return tok;
  }

  /** Word operators arrive as identifiers; treat them as operators when in operator position. */
  private operatorOf(tok: Token): string | null {
    if (tok.type === "op" && BINARY_PRECEDENCE[tok.value] !== undefined) return tok.value;
    if (tok.type === "ident" && (tok.value === "and" || tok.value === "or")) return tok.value;
    return null;
  }

  parse(): ExprNode {
    const node = this.parseExpression(0);
    const tail = this.peek();
    if (tail.type !== "eof") {
      throw new ExprError(`unexpected ${JSON.stringify(tail.value)} at position ${tail.pos}`);
    }
    return node;
  }

  private parseExpression(minPrecedence: number): ExprNode {
    if (++this.depth > MAX_DEPTH) throw new ExprError("expression nested too deeply");
    let left = this.parseUnary();
    for (;;) {
      const op = this.operatorOf(this.peek());
      if (op === null) break;
      const precedence = BINARY_PRECEDENCE[op] as number;
      if (precedence < minPrecedence) break;
      this.next();
      // Left-associative: the right operand binds tighter than this level.
      const right = this.parseExpression(precedence + 1);
      left = { t: "bin", op: op === "||" ? "or" : op === "&&" ? "and" : op, l: left, r: right };
    }
    // Ternary is lowest-precedence and right-associative.
    if (minPrecedence === 0 && this.peek().value === "?" && this.peek().type === "op") {
      this.next();
      const a = this.parseExpression(0);
      this.expect(":");
      const b = this.parseExpression(0);
      left = { t: "cond", test: left, a, b };
    }
    this.depth--;
    return left;
  }

  private parseUnary(): ExprNode {
    const tok = this.peek();
    if (
      (tok.type === "op" && (tok.value === "-" || tok.value === "!")) ||
      (tok.type === "ident" && tok.value === "not")
    ) {
      this.next();
      const arg = this.parseUnary();
      return { t: "unary", op: tok.value === "-" ? "-" : "not", arg };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): ExprNode {
    let node = this.parsePrimary();
    for (;;) {
      const tok = this.peek();
      if (tok.type === "op" && tok.value === ".") {
        this.next();
        const name = this.next();
        if (name.type !== "ident") throw new ExprError(`expected a property name at position ${name.pos}`);
        node = { t: "member", obj: node, name: name.value };
      } else if (tok.type === "op" && tok.value === "[") {
        this.next();
        const idx = this.parseExpression(0);
        this.expect("]");
        node = { t: "index", obj: node, idx };
      } else {
        return node;
      }
    }
  }

  private parsePrimary(): ExprNode {
    const tok = this.next();
    if (tok.type === "num") return { t: "lit", v: Number(tok.value) };
    if (tok.type === "str") return { t: "lit", v: tok.value };
    if (tok.type === "op" && tok.value === "(") {
      const node = this.parseExpression(0);
      this.expect(")");
      return node;
    }
    if (tok.type === "ident") {
      if (tok.value === "true") return { t: "lit", v: true };
      if (tok.value === "false") return { t: "lit", v: false };
      if (tok.value === "null") return { t: "lit", v: null };
      // A call is only ever to a builtin by bare name — there are no callable values, so
      // `output.foo()` and `x = someFn` are unrepresentable rather than merely disallowed.
      if (this.peek().type === "op" && this.peek().value === "(") {
        this.next();
        const args: ExprNode[] = [];
        if (!(this.peek().type === "op" && this.peek().value === ")")) {
          for (;;) {
            args.push(this.parseExpression(0));
            if (this.peek().type === "op" && this.peek().value === ",") {
              this.next();
              continue;
            }
            break;
          }
        }
        this.expect(")");
        if (!Object.hasOwn(BUILTINS, tok.value)) {
          throw new ExprError(`unknown function ${JSON.stringify(tok.value)} at position ${tok.pos}`);
        }
        return { t: "call", name: tok.value, args, pos: tok.pos };
      }
      if (!VARIABLES.includes(tok.value)) {
        throw new ExprError(
          `unknown name ${JSON.stringify(tok.value)} at position ${tok.pos} — available: ${VARIABLES.join(", ")}`,
        );
      }
      return { t: "var", name: tok.value };
    }
    throw new ExprError(`unexpected ${JSON.stringify(tok.value || "end of input")} at position ${tok.pos}`);
  }
}

// ── Builtins ──────────────────────────────────────────────────────────────────

const str = (v: ExprValue): string => (typeof v === "string" ? v : v === null ? "" : JSON.stringify(v));
const num = (v: ExprValue): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

/** Structural equality over JSON values — key order and reference identity are irrelevant. */
function deepEqual(a: ExprValue, b: ExprValue): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i] as ExprValue));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a);
    const kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    return ka.every(
      (k) =>
        Object.hasOwn(b as object, k) &&
        deepEqual((a as Record<string, ExprValue>)[k] as ExprValue, (b as Record<string, ExprValue>)[k] as ExprValue),
    );
  }
  return false;
}

/** Read a `$.a.b[0]`-style path out of a JSON value. Returns null for any miss. */
function jsonPath(value: ExprValue, path: string): ExprValue {
  const parts = path
    .replace(/^\$\.?/, "")
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter((p) => p !== "");
  let cur: ExprValue = value;
  for (const part of parts) {
    if (cur === null || typeof cur !== "object") return null;
    if (Array.isArray(cur)) {
      const idx = Number(part);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return null;
      cur = cur[idx] as ExprValue;
    } else {
      if (!Object.hasOwn(cur, part)) return null;
      cur = (cur as Record<string, ExprValue>)[part] as ExprValue;
    }
  }
  return cur;
}

type Builtin = { arity: [number, number]; fn: (args: ExprValue[]) => ExprValue };

const BUILTINS: Record<string, Builtin> = {
  len: { arity: [1, 1], fn: ([v]) => lengthOf(v as ExprValue) },
  contains: {
    arity: [2, 2],
    fn: ([h, n]) =>
      Array.isArray(h)
        ? h.some((x) => deepEqual(x, n as ExprValue))
        : str(h as ExprValue).includes(str(n as ExprValue)),
  },
  startsWith: { arity: [2, 2], fn: ([s, p]) => str(s as ExprValue).startsWith(str(p as ExprValue)) },
  endsWith: { arity: [2, 2], fn: ([s, p]) => str(s as ExprValue).endsWith(str(p as ExprValue)) },
  lower: { arity: [1, 1], fn: ([s]) => str(s as ExprValue).toLowerCase() },
  upper: { arity: [1, 1], fn: ([s]) => str(s as ExprValue).toUpperCase() },
  trim: { arity: [1, 1], fn: ([s]) => str(s as ExprValue).trim() },
  words: {
    arity: [1, 1],
    fn: ([s]) =>
      str(s as ExprValue)
        .split(/\s+/)
        .filter((w) => w !== ""),
  },
  matches: {
    arity: [2, 2],
    fn: ([s, p]) => {
      const pattern = str(p as ExprValue);
      // Same static ReDoS guard the masking policy uses — a user-authored evaluator runs in the
      // shared ingest worker, so a backtracking pattern there is a cross-tenant hazard.
      if (!isValidRegex(pattern))
        throw new ExprError(`matches(): invalid regex ${JSON.stringify(pattern.slice(0, 60))}`);
      if (maxStarHeight(pattern) >= 2) {
        throw new ExprError("matches(): pattern rejected — nested repetition risks catastrophic backtracking");
      }
      const subject = str(s as ExprValue);
      if (subject.length > MAX_REGEX_SUBJECT) {
        throw new ExprError(`matches(): subject longer than ${MAX_REGEX_SUBJECT} characters`);
      }
      return new RegExp(pattern).test(subject);
    },
  },
  exactMatch: { arity: [2, 2], fn: ([a, b]) => deepEqual(a as ExprValue, b as ExprValue) },
  jsonValid: {
    arity: [1, 1],
    fn: ([s]) => {
      try {
        JSON.parse(str(s as ExprValue));
        return true;
      } catch {
        return false;
      }
    },
  },
  jsonParse: {
    arity: [1, 1],
    fn: ([s]) => {
      try {
        return JSON.parse(str(s as ExprValue)) as ExprValue;
      } catch {
        return null;
      }
    },
  },
  jsonPath: { arity: [2, 2], fn: ([v, p]) => jsonPath(v as ExprValue, str(p as ExprValue)) },
  has: {
    arity: [2, 2],
    fn: ([o, k]) => o !== null && typeof o === "object" && !Array.isArray(o) && Object.hasOwn(o, str(k as ExprValue)),
  },
  num: { arity: [1, 1], fn: ([v]) => num(v as ExprValue) },
  abs: { arity: [1, 1], fn: ([v]) => Math.abs(num(v as ExprValue) ?? 0) },
  round: { arity: [1, 1], fn: ([v]) => Math.round(num(v as ExprValue) ?? 0) },
  min: { arity: [2, 2], fn: ([a, b]) => Math.min(num(a as ExprValue) ?? 0, num(b as ExprValue) ?? 0) },
  max: { arity: [2, 2], fn: ([a, b]) => Math.max(num(a as ExprValue) ?? 0, num(b as ExprValue) ?? 0) },
  isEmpty: { arity: [1, 1], fn: ([v]) => lengthOf(v as ExprValue) === 0 },
  coalesce: { arity: [2, 2], fn: ([a, b]) => (a === null ? (b as ExprValue) : (a as ExprValue)) },
};

function lengthOf(v: ExprValue): number {
  if (typeof v === "string") return v.length;
  if (Array.isArray(v)) return v.length;
  if (v !== null && typeof v === "object") return Object.keys(v).length;
  return 0;
}

/** Names a user can call. Exported so the console can offer completion without duplicating the list. */
export const EXPR_BUILTIN_NAMES = Object.keys(BUILTINS).sort();
export const EXPR_VARIABLE_NAMES = [...VARIABLES];

// ── Evaluation ────────────────────────────────────────────────────────────────

/** Property names that must never be readable, even though inputs are plain JSON. */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function readMember(obj: ExprValue, key: string): ExprValue {
  if (FORBIDDEN_KEYS.has(key)) throw new ExprError(`access to ${JSON.stringify(key)} is not allowed`);
  if (typeof obj === "string") return key === "length" ? obj.length : null;
  if (Array.isArray(obj)) {
    if (key === "length") return obj.length;
    const idx = Number(key);
    return Number.isInteger(idx) && idx >= 0 && idx < obj.length ? (obj[idx] as ExprValue) : null;
  }
  if (obj !== null && typeof obj === "object") {
    return Object.hasOwn(obj, key) ? ((obj as Record<string, ExprValue>)[key] as ExprValue) : null;
  }
  return null;
}

/** Truthiness: JS-like, except an empty object/array is falsy (it reads as "nothing there"). */
function truthy(v: ExprValue): boolean {
  if (typeof v === "boolean") return v;
  if (v === null) return false;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v.length > 0;
  return lengthOf(v) > 0;
}

function compare(op: string, l: ExprValue, r: ExprValue): ExprValue {
  if (op === "==") return deepEqual(l, r);
  if (op === "!=") return !deepEqual(l, r);
  // Ordering compares numbers when both coerce, otherwise strings — so "a" < "b" works.
  const ln = num(l);
  const rn = num(r);
  const [a, b]: [number | string, number | string] = ln !== null && rn !== null ? [ln, rn] : [str(l), str(r)];
  switch (op) {
    case "<":
      return a < b;
    case "<=":
      return a <= b;
    case ">":
      return a > b;
    default:
      return a >= b;
  }
}

function arithmetic(op: string, l: ExprValue, r: ExprValue): ExprValue {
  // `+` concatenates when either side is a string, mirroring the obvious reading.
  if (op === "+" && (typeof l === "string" || typeof r === "string")) return str(l) + str(r);
  const a = num(l);
  const b = num(r);
  if (a === null || b === null) throw new ExprError(`operator ${JSON.stringify(op)} needs numbers`);
  switch (op) {
    case "+":
      return a + b;
    case "-":
      return a - b;
    case "*":
      return a * b;
    case "/":
      return b === 0 ? 0 : a / b;
    default:
      return b === 0 ? 0 : a % b;
  }
}

function evalNode(node: ExprNode, ctx: ExprContext, steps: { n: number }): ExprValue {
  if (++steps.n > MAX_EVAL_STEPS) throw new ExprError("expression exceeded its evaluation budget");
  switch (node.t) {
    case "lit":
      return node.v;
    case "var":
      return ctx[node.name as keyof ExprContext] ?? null;
    case "member":
      return readMember(evalNode(node.obj, ctx, steps), node.name);
    case "index": {
      const obj = evalNode(node.obj, ctx, steps);
      const idx = evalNode(node.idx, ctx, steps);
      return readMember(obj, typeof idx === "number" ? String(idx) : str(idx));
    }
    case "unary": {
      if (node.op === "not") return !truthy(evalNode(node.arg, ctx, steps));
      const v = num(evalNode(node.arg, ctx, steps));
      if (v === null) throw new ExprError("unary '-' needs a number");
      return -v;
    }
    case "bin": {
      // Short-circuit: `and`/`or` must not evaluate the right side unnecessarily, both for
      // cost and so `has(x, "k") and x.k > 1` is safe to write.
      if (node.op === "and") {
        return truthy(evalNode(node.l, ctx, steps)) ? truthy(evalNode(node.r, ctx, steps)) : false;
      }
      if (node.op === "or") {
        return truthy(evalNode(node.l, ctx, steps)) ? true : truthy(evalNode(node.r, ctx, steps));
      }
      const l = evalNode(node.l, ctx, steps);
      const r = evalNode(node.r, ctx, steps);
      if (["==", "!=", "<", "<=", ">", ">="].includes(node.op)) return compare(node.op, l, r);
      return arithmetic(node.op, l, r);
    }
    case "cond":
      return truthy(evalNode(node.test, ctx, steps)) ? evalNode(node.a, ctx, steps) : evalNode(node.b, ctx, steps);
    case "call": {
      const builtin = BUILTINS[node.name] as Builtin;
      const [minArgs, maxArgs] = builtin.arity;
      if (node.args.length < minArgs || node.args.length > maxArgs) {
        throw new ExprError(
          `${node.name}() takes ${minArgs === maxArgs ? minArgs : `${minArgs}-${maxArgs}`} argument(s), got ${node.args.length}`,
        );
      }
      return builtin.fn(node.args.map((a) => evalNode(a, ctx, steps)));
    }
  }
}

/**
 * Parse an expression, throwing ExprError with a position on any syntax or name error.
 * Callers validate at WRITE time with this so a broken evaluator is a 400, not a silent
 * per-event failure in the worker.
 */
export function compileExpression(source: string): ExprNode {
  if (source.trim() === "") throw new ExprError("expression is empty");
  if (source.length > MAX_EXPRESSION_LENGTH) {
    throw new ExprError(`expression longer than ${MAX_EXPRESSION_LENGTH} characters`);
  }
  return new Parser(tokenize(source)).parse();
}

/**
 * Evaluate an expression to its raw value, with no coercion to a score.
 *
 * This is the honest primitive: `runExpression` coerces and therefore *throws* on a result that
 * isn't score-shaped, which is exactly the case where a user testing an expression most needs to
 * see what it actually produced. The console's "test" affordance uses this.
 */
export function evaluateExpression(source: string | ExprNode, ctx: ExprContext): ExprValue {
  const ast = typeof source === "string" ? compileExpression(source) : source;
  return evalNode(ast, ctx, { n: 0 });
}

export interface ExprRunResult {
  score: number;
  /** The raw value the expression produced, before coercion to a score. */
  value: ExprValue;
}

/**
 * Evaluate an expression and coerce the result to a score in [0, 1].
 *
 * A boolean maps to 1/0 — that is the common case (a check passes or it doesn't). A number is
 * taken as-is and must already be in range: silently clamping a 42 would turn an authoring
 * mistake into a plausible-looking score, which is worse than failing.
 */
export function runExpression(source: string | ExprNode, ctx: ExprContext): ExprRunResult {
  const value = evaluateExpression(source, ctx);
  if (typeof value === "boolean") return { score: value ? 1 : 0, value };
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new ExprError(`expression produced ${value}, but a score must be a number in [0, 1] or a boolean`);
    }
    return { score: value, value };
  }
  throw new ExprError(
    `expression produced ${value === null ? "null" : Array.isArray(value) ? "an array" : typeof value}, but a score must be a number in [0, 1] or a boolean`,
  );
}
