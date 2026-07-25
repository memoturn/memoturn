#!/usr/bin/env node
/**
 * `mt` — the memoturn CLI. Its headline command is `mt eval`, which gates a dataset run's
 * evaluator scores against thresholds and exits non-zero when they regress — so you can drop
 * it into CI to fail a PR on eval regressions ("LLM unit tests"). It is a thin wrapper over the
 * existing gate endpoint (`POST /v1/datasets/{name}/runs/{run}/gate`, see `evaluateGate`); the
 * run itself is produced however you like (client-recorded via the SDK, or a server experiment).
 *
 * Exit codes: 0 = gate passed, 1 = gate failed (a threshold was violated), 2 = usage/runtime error.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { type Creds, evaluateGate, type GateResult, type GateThreshold } from "./dataset.js";

/** Shape of an `mt eval` config file (referenced with `--config`). CLI flags override it. */
export interface EvalConfig {
  dataset?: string;
  run?: string;
  baseline?: string;
  baseUrl?: string;
  thresholds?: Record<string, GateThreshold>;
}

export interface ParsedEvalArgs {
  config?: string;
  dataset?: string;
  run?: string;
  baseline?: string;
  baseUrl?: string;
  json: boolean;
  thresholds: Record<string, GateThreshold>;
}

const USAGE = `mt eval — gate a dataset run's evaluator scores for CI

Usage:
  mt eval [--config <file>] --dataset <name> --run <run> [options]

Options:
  --config <file>            JSON config: { dataset, run, baseline?, thresholds }
  --dataset <name>           Dataset name (overrides config)
  --run <run>                Run name to gate (overrides config)
  --baseline <run>           Baseline run for --max-regression checks
  --base-url <url>           API base URL (default env MEMOTURN_BASE_URL or http://localhost:3001)
  --min <name>=<n>           Require score's mean >= n     (repeatable)
  --max <name>=<n>           Require score's mean <= n     (repeatable)
  --max-regression <name>=<n>  Require mean >= baseline - n (repeatable; needs --baseline)
  --json                     Print the raw gate result as JSON
  -h, --help                 Show this help

Auth: MEMOTURN_PUBLIC_KEY / MEMOTURN_SECRET_KEY (HTTP Basic).

Exit codes: 0 gate passed · 1 gate failed · 2 usage/runtime error.`;

function setThreshold(map: Record<string, GateThreshold>, spec: string, key: keyof GateThreshold): void {
  const eq = spec.indexOf("=");
  if (eq < 0) throw new Error(`expected <name>=<number>, got "${spec}"`);
  const name = spec.slice(0, eq).trim();
  const value = Number(spec.slice(eq + 1));
  if (!name || !Number.isFinite(value)) throw new Error(`invalid threshold "${spec}"`);
  map[name] = { ...(map[name] ?? {}), [key]: value };
}

/** Parse `mt eval` argv (everything after the `eval` subcommand). Throws on malformed input. */
export function parseEvalArgs(argv: string[]): ParsedEvalArgs {
  const out: ParsedEvalArgs = { json: false, thresholds: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${a}`);
      return v;
    };
    switch (a) {
      case "--config":
        out.config = next();
        break;
      case "--dataset":
        out.dataset = next();
        break;
      case "--run":
        out.run = next();
        break;
      case "--baseline":
        out.baseline = next();
        break;
      case "--base-url":
        out.baseUrl = next();
        break;
      case "--min":
        setThreshold(out.thresholds, next(), "min");
        break;
      case "--max":
        setThreshold(out.thresholds, next(), "max");
        break;
      case "--max-regression":
        setThreshold(out.thresholds, next(), "maxRegression");
        break;
      case "--json":
        out.json = true;
        break;
      default:
        throw new Error(`unknown option "${a}"`);
    }
  }
  return out;
}

function loadConfig(path: string): EvalConfig {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`cannot read config "${path}": ${(e as Error).message}`);
  }
  try {
    return JSON.parse(raw) as EvalConfig;
  } catch (e) {
    throw new Error(`config "${path}" is not valid JSON: ${(e as Error).message}`);
  }
}

/** Merge a config file (if given) under CLI flags, and validate the result is runnable. */
export function resolveEvalPlan(args: ParsedEvalArgs): {
  dataset: string;
  run: string;
  baseline?: string;
  baseUrl?: string;
  thresholds: Record<string, GateThreshold>;
} {
  const cfg = args.config ? loadConfig(args.config) : {};
  const dataset = args.dataset ?? cfg.dataset;
  const run = args.run ?? cfg.run;
  const baseline = args.baseline ?? cfg.baseline;
  const baseUrl = args.baseUrl ?? cfg.baseUrl;
  // CLI thresholds take precedence per-score over config thresholds.
  const thresholds = { ...(cfg.thresholds ?? {}), ...args.thresholds };
  if (!dataset) throw new Error("no dataset (pass --dataset or set it in --config)");
  if (!run) throw new Error("no run (pass --run or set it in --config)");
  if (Object.keys(thresholds).length === 0) throw new Error("no thresholds (pass --min/--max or set them in --config)");
  return { dataset, run, baseline, baseUrl, thresholds };
}

const REASON_LABEL: Record<string, string> = {
  below_min: "below min",
  above_max: "above max",
  regression: "regressed",
  missing_score: "missing",
};

/** Human-readable gate report (returned, not printed, so it is testable). */
export function formatReport(result: GateResult): string {
  const lines: string[] = [];
  lines.push(`gate ${result.passed ? "PASS" : "FAIL"} — dataset "${result.dataset}" run "${result.run}"`);
  if (result.baselineRun) lines.push(`baseline: "${result.baselineRun}"`);
  const failed = new Set(result.failures.map((f) => f.scoreName));
  for (const s of result.scores) {
    const mark = failed.has(s.name) ? "✗" : "✓";
    lines.push(`  ${mark} ${s.name}: mean ${s.mean.toFixed(3)} (n=${s.count})`);
  }
  for (const f of result.failures) {
    const val = f.value === null ? "—" : f.value.toFixed(3);
    const base = f.baseline !== undefined ? `, baseline ${f.baseline.toFixed(3)}` : "";
    lines.push(`  ! ${f.scoreName}: ${REASON_LABEL[f.reason] ?? f.reason} (value ${val}, bound ${f.bound}${base})`);
  }
  return lines.join("\n");
}

/** Run the `mt eval` command; resolves to a process exit code (0 pass / 1 fail / 2 error). */
export async function runEval(argv: string[]): Promise<number> {
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  let plan: ReturnType<typeof resolveEvalPlan>;
  try {
    plan = resolveEvalPlan(parseEvalArgs(argv));
  } catch (e) {
    process.stderr.write(`mt eval: ${(e as Error).message}\n\n${USAGE}\n`);
    return 2;
  }

  const creds: Creds = { baseUrl: plan.baseUrl };
  let result: GateResult;
  try {
    result = await evaluateGate(creds, plan.dataset, plan.run, plan.thresholds, { baselineRun: plan.baseline });
  } catch (e) {
    process.stderr.write(`mt eval: ${(e as Error).message}\n`);
    return 2;
  }

  process.stdout.write(`${argv.includes("--json") ? JSON.stringify(result, null, 2) : formatReport(result)}\n`);
  return result.passed ? 0 : 1;
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "-h" || command === "--help") {
    process.stdout.write(
      `memoturn CLI\n\nCommands:\n  eval    Gate a dataset run's evaluator scores for CI\n\n${USAGE}\n`,
    );
    return command ? 0 : 2;
  }
  if (command === "--version" || command === "-v") {
    process.stdout.write("mt (memoturn sdk)\n");
    return 0;
  }
  if (command === "eval") return runEval(rest);
  process.stderr.write(`mt: unknown command "${command}"\n`);
  return 2;
}

// Run only when invoked as the executable, not when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`mt: ${(e as Error).message}\n`);
      process.exit(2);
    },
  );
}
