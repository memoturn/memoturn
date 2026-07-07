# Product

## Register

product

## Users

AI engineers and platform teams instrumenting LLM applications. They arrive mid-task — debugging a bad generation, comparing eval runs, checking cost/latency regressions — usually with a trace ID or dashboard already in hand. Fluent in tools like Langfuse, Datadog, Grafana, and Linear; they expect dense, scannable telemetry UI that stays out of the way.

## Product Purpose

memoturn is an open-source, self-hostable AI engineering platform: LLM observability (traces, spans, generations, scores), metrics dashboards, prompt management, playground, datasets, and evals. Success means an engineer can go from "something's off in production" to the exact generation, payload, and cost that explains it in a few clicks.

## Brand Personality

Precise, quiet, technical. The console is an instrument panel, not a marketing surface: monochrome neutrals (shadcn "sera" style, square corners), semantic color reserved for telemetry meaning (blue = generation, emerald = span, amber = event, red = error), tabular numerals for every metric.

## Anti-references

- Consumer-SaaS gloss: gradients, glassmorphism, rounded-everything, decorative motion.
- Dashboard-vendor noise: hero metrics with sparkline confetti, rainbow chart palettes.
- Anything that makes telemetry harder to scan than a terminal.

## Design Principles

- **Data first, chrome last** — density and scannability beat whitespace; tables and monospace IDs are the norm.
- **Color is semantics** — a hue always means the same observation kind or state; never decoration.
- **Familiar over novel** — standard affordances (tables, tabs, accordions, breadcrumbs) so the tool disappears into the task.
- **Numbers align** — tabular-nums, right-aligned metrics, consistent units (ms, tokens, $).
- **Every state shipped** — loading skeletons, empty states, error states, read-only (VIEWER) disabling on every mutating control.

## Accessibility & Inclusion

WCAG AA contrast in both light and dark themes (theme toggle is first-class). Keyboard: command palette, focus-visible rings from shadcn defaults. Respect prefers-reduced-motion; motion is state feedback only.
