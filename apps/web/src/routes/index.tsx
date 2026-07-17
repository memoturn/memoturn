import { Badge, BrandMark, Button } from "@memoturn/ui";
import { createFileRoute } from "@tanstack/react-router";
import { ArrowRightIcon } from "lucide-react";

import { DOCS_PUBLIC_URL, GITHUB_URL } from "../lib/public-urls.ts";

export const Route = createFileRoute("/")({
  component: Landing,
});

const GETTING_STARTED_URL = `${DOCS_PUBLIC_URL}/getting-started/`;
const USE_CASES_URL = `${DOCS_PUBLIC_URL}/use-cases/`;

// Ingestion surfaces — bring telemetry from any of these, no lock-in.
const BACKENDS = ["OpenTelemetry", "OpenAI", "Anthropic", "LangChain", "LiteLLM", "MCP"];

// The canonical three-leg grid. DESIGN.md permits the identical-card-grid
// exception only at a count of three; everything else lives in the ledger.
const FEATURES = [
  {
    eyebrow: "observability",
    title: "Every call, traced",
    body: "Traces, spans, generations, and scores with a waterfall timeline and sessions. Ingest from the SDKs, the OpenAI and LangChain wrappers, or any OpenTelemetry exporter — OTLP/JSON with GenAI semantic conventions.",
    tags: ["traces", "waterfall", "OTel"],
  },
  {
    eyebrow: "evaluation",
    title: "Evals, three ways",
    body: "Offline experiments over datasets, online evaluators sampling production traces, and human review queues with assignment. Every score lands in Doris and shows up on the trace it came from.",
    tags: ["offline", "online", "human review"],
  },
  {
    eyebrow: "prompts",
    title: "Prompts with deploy channels",
    body: "A versioned prompt registry with production, latest, and custom channels. Fetch with getPrompt, compile variables, and iterate in a multi-provider streaming playground — every run recorded as a trace.",
    tags: ["versioned", "channels", "playground"],
  },
];

// The rest of the surface, rendered as a hairline ledger rather than a
// second card grid (no four-up / six-up grids per DESIGN.md).
const CAPABILITIES = [
  {
    label: "metrics & dashboards",
    body: "Cost, tokens, and latency (p50/p95) over a Doris rollup, sliced by day and by model — plus custom widgets and saved views for the questions your team actually asks.",
    tags: ["cost", "tokens", "p95"],
  },
  {
    label: "datasets & experiments",
    body: "Dataset items and experiment runs that link every item to the trace it produced. Benchmark prompts and models side by side in a comparison matrix before anything ships.",
    tags: ["datasets", "experiments"],
  },
  {
    label: "playground",
    body: "Multi-provider — mock, Anthropic, OpenAI — with streaming, structured output, and tool calling. Every playground run is recorded as a trace, so exploration feeds observability.",
    tags: ["streaming", "multi-provider"],
  },
  {
    label: "MCP server",
    body: "Prompts, datasets, and review queues exposed as tools inside agent IDEs like Claude Code and Cursor — as a local stdio server or over Streamable HTTP per project, with per-tool RBAC.",
    tags: ["MCP", "agent IDEs"],
  },
  {
    label: "platform",
    body: "Organizations and projects on Better Auth with RBAC and read-only viewers, SSO (OIDC/SAML), API-key management, per-project rate limits, PII masking at ingest, audit logs, retention policies, and scheduled NDJSON exports — every one of these ships in the Apache-2.0 core, not an enterprise upsell.",
    tags: ["RBAC", "SSO", "PII masking"],
  },
  {
    label: "automations",
    body: "Trigger→action rules on platform events — score.created, trace.created, eval.completed — firing webhooks or Slack messages, plus PostHog export and per-project custom model prices.",
    tags: ["webhooks", "Slack", "PostHog"],
  },
];

// What you build with the primitives above. A numbered ledger, not a second
// card grid — DESIGN.md spends the identical-card-grid exception on FEATURES.
const USE_CASES = [
  {
    label: "Debug production LLM traffic",
    body: "Follow a request through every span and generation on the waterfall timeline, with full input/output payloads and session grouping across turns.",
    tags: ["traces", "sessions"],
  },
  {
    label: "Track spend by model & feature",
    body: "Cost, token, and latency rollups per day and per model out of Doris — know what each feature costs before the invoice tells you.",
    tags: ["cost", "Doris"],
  },
  {
    label: "Catch regressions before users do",
    body: "Online evaluators sample live production traces and score them continuously; automations turn a bad score into a Slack alert or webhook.",
    tags: ["online evals", "alerts"],
  },
  {
    label: "Ship prompts like code",
    body: "Versioned, immutable prompt registry with deployment channels — promote to production, roll back instantly, fetch from the SDK with getPrompt.",
    tags: ["channels", "rollback"],
  },
  {
    label: "Benchmark models & prompts",
    body: "Run experiments over datasets, score them with LLM-as-judge evaluators, and compare runs side by side before switching models.",
    tags: ["experiments", "LLM-as-judge"],
  },
  {
    label: "Self-host for compliance",
    body: "PII masking at ingest, audit logs, retention policies, and scheduled exports — with every byte of telemetry staying on your infrastructure.",
    tags: ["PII", "audit", "retention"],
  },
];

function Landing() {
  return (
    <>
      <section
        aria-labelledby="hero-heading"
        className="relative overflow-hidden bg-background"
        style={{
          backgroundImage:
            "linear-gradient(to right, var(--rule-faint) 1px, transparent 1px), linear-gradient(to bottom, var(--rule-faint) 1px, transparent 1px)",
          backgroundSize: "96px 96px",
          backgroundPosition: "center",
          WebkitMaskImage: "radial-gradient(ellipse 88% 78% at 50% 45%, #000 50%, transparent 100%)",
          maskImage: "radial-gradient(ellipse 88% 78% at 50% 45%, #000 50%, transparent 100%)",
        }}
      >
        <div className="page-wrap relative max-w-6xl! pt-24 pb-22">
          <div className="mb-8 inline-flex items-center gap-3">
            <BrandMark gradient className="size-7 shrink-0" />
            <Badge
              variant="outline"
              className="border-primary/30 bg-foam dark:bg-primary/10 font-medium text-[0.6875rem] tracking-[0.08em] text-primary uppercase"
            >
              open source · Apache-2.0
            </Badge>
          </div>
          <h1
            id="hero-heading"
            className="display-title max-w-[22ch] text-balance text-[clamp(2.75rem,7vw,5.5rem)] font-bold leading-[1.02] tracking-[-0.025em] text-sea-ink dark:text-foreground"
          >
            See every LLM call, on infrastructure you own.
          </h1>
          <p className="mt-7 max-w-[56ch] text-pretty text-base leading-[1.55] text-sea-ink-soft dark:text-muted-foreground sm:text-lg">
            Memoturn is an open-source AI engineering platform — tracing, cost and latency metrics, offline, online, and
            human evals, versioned prompts with deploy channels, a playground, and datasets. OpenTelemetry-native,
            self-hostable, and nothing leaves your network.
          </p>
          <div className="mt-9 flex flex-wrap items-center gap-3">
            <Button asChild size="lg">
              <a href={GETTING_STARTED_URL} className="no-underline">
                Read the getting-started guide
              </a>
            </Button>
            <Button asChild variant="ghost" size="lg" className="group text-muted-foreground hover:text-foreground">
              <a href={GITHUB_URL} className="no-underline" target="_blank" rel="noreferrer">
                Star on GitHub
                <ArrowRightIcon className="size-4 transition-transform group-hover:translate-x-0.5" aria-hidden />
              </a>
            </Button>
          </div>
          <dl className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] tracking-[0.04em] text-muted-foreground">
            <div className="inline-flex items-center gap-1.5">
              <span aria-hidden className="size-1 rounded-full bg-primary/70" />
              <dt className="sr-only">License</dt>
              <dd>Apache-2.0</dd>
            </div>
            <div className="inline-flex items-center gap-1.5">
              <span aria-hidden className="size-1 rounded-full bg-primary/70" />
              <dt className="sr-only">Telemetry</dt>
              <dd>OpenTelemetry-native</dd>
            </div>
            <div className="inline-flex items-center gap-1.5">
              <span aria-hidden className="size-1 rounded-full bg-primary/70" />
              <dt className="sr-only">SDKs</dt>
              <dd>TS + Python SDKs</dd>
            </div>
            <div className="inline-flex items-center gap-1.5">
              <span aria-hidden className="size-1 rounded-full bg-primary/70" />
              <dt className="sr-only">Analytics store</dt>
              <dd>Apache Doris-backed</dd>
            </div>
          </dl>
        </div>
      </section>

      <section aria-label="Ingestion sources" className="border-y border-border/60 bg-background">
        <div className="page-wrap max-w-6xl! py-6">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <span className="kicker">works with</span>
            <ul className="m-0 flex list-none flex-wrap items-center gap-x-5 gap-y-2 p-0">
              {BACKENDS.map((name, idx) => (
                <li key={name} className="inline-flex items-center gap-x-5">
                  <span className="text-[15px] font-medium tracking-[-0.005em] text-foreground">{name}</span>
                  {idx < BACKENDS.length - 1 ? <span aria-hidden className="size-1 rounded-full bg-border" /> : null}
                </li>
              ))}
            </ul>
            <span className="ml-auto font-mono text-xs tracking-[0.04em] text-muted-foreground">
              <span aria-hidden className="text-primary">
                ↳{" "}
              </span>
              OTLP · GenAI semconv
            </span>
          </div>
        </div>
      </section>

      <section aria-labelledby="why-heading" className="bg-background">
        <div className="page-wrap max-w-6xl! py-24">
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,28rem)] lg:items-end">
            <div>
              <p className="kicker mb-4">why memoturn</p>
              <p
                id="why-heading"
                className="display-title max-w-[32ch] text-balance text-[clamp(1.75rem,3.8vw,2.75rem)] font-bold leading-[1.08] tracking-tight text-sea-ink dark:text-foreground"
              >
                LLM apps ship blind: no cost visibility, silent quality regressions, prompts versioned in a Slack
                thread.
              </p>
            </div>
            <p className="max-w-[44ch] text-pretty text-[0.9375rem] leading-[1.65] text-sea-ink-soft dark:text-muted-foreground">
              The observability stack the LLM SaaS vendors run — traces, eval pipelines, prompt registries — rebuilt on
              open infrastructure: Postgres, Apache Doris, Redis, S3. One docker compose away, and your telemetry never
              leaves your network.
            </p>
          </div>
        </div>
      </section>

      <section
        aria-labelledby="features-heading"
        className="relative overflow-hidden border-y border-border/60 bg-sand dark:bg-card/40"
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-0 opacity-[0.06]"
          style={{
            backgroundImage: "var(--pattern-topo)",
            backgroundSize: "360px 360px",
            backgroundPosition: "-120px -60px",
          }}
        />
        <div className="page-wrap relative max-w-6xl! py-24">
          <div className="mb-12 grid max-w-[60ch] gap-3">
            <p className="kicker">what you get</p>
            <h2
              id="features-heading"
              className="display-title text-balance text-[clamp(2rem,4vw,3rem)] font-bold leading-[1.05] tracking-tight text-sea-ink dark:text-foreground"
            >
              The full AI engineering loop, every piece open.
            </h2>
            <p className="max-w-[56ch] text-[0.9375rem] leading-[1.6] text-sea-ink-soft dark:text-muted-foreground">
              No proprietary cloud, no black boxes. Observe what your app does, evaluate whether it's good, and ship the
              next prompt — one platform you can inspect, extend, and self-host.
            </p>
          </div>
          <div className="grid border-t border-l border-[--rule] bg-background md:grid-cols-3">
            {FEATURES.map((f, i) => (
              <article
                key={f.eyebrow}
                className="group/card flex flex-col gap-4 border-r border-b border-[--rule] bg-background dark:bg-card pt-8 pr-7 pb-9 pl-7 transition-colors hover:bg-foam dark:hover:bg-muted/40 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-420"
                style={{ animationDelay: `${i * 60}ms`, animationFillMode: "backwards" }}
              >
                <p className="kicker text-primary">{f.eyebrow}</p>
                <h3 className="display-title text-[1.375rem] font-bold leading-tight tracking-tight text-sea-ink dark:text-foreground">
                  {f.title}
                </h3>
                <p className="text-[0.90625rem] leading-[1.6] text-sea-ink-soft dark:text-muted-foreground">{f.body}</p>
                <div className="mt-auto flex flex-wrap gap-1.5 border-t border-dashed border-[--rule] pt-4.5">
                  {f.tags.map((tag) => (
                    <span
                      key={tag}
                      className="rounded bg-primary/10 px-2 py-0.5 font-mono text-[0.6875rem] tracking-tight text-primary"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              </article>
            ))}
          </div>
          <div className="mt-10">
            <p className="kicker mb-4">also on the platform</p>
            <div className="border-t border-x border-[--rule] bg-background">
              {CAPABILITIES.map((c) => (
                <div
                  key={c.label}
                  className="grid grid-cols-1 gap-x-6 gap-y-2 border-b border-[--rule] px-7 py-5 sm:grid-cols-[11rem_minmax(0,1fr)_auto] sm:items-baseline"
                >
                  <p className="kicker text-primary">{c.label}</p>
                  <p className="text-[0.90625rem] leading-[1.6] text-sea-ink dark:text-foreground">{c.body}</p>
                  <div className="flex flex-wrap gap-1.5 sm:justify-end">
                    {c.tags.map((tag) => (
                      <span
                        key={tag}
                        className="rounded bg-primary/10 px-2 py-0.5 font-mono text-[0.6875rem] tracking-tight text-primary"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section aria-labelledby="use-cases-heading" className="bg-background">
        <div className="page-wrap max-w-6xl! py-24">
          <div className="mb-12 grid max-w-[60ch] gap-3">
            <p className="kicker">what you build</p>
            <h2
              id="use-cases-heading"
              className="display-title text-balance text-[clamp(2rem,4vw,3rem)] font-bold leading-[1.05] tracking-tight text-sea-ink dark:text-foreground"
            >
              From first trace to shipped prompt, one loop.
            </h2>
            <p className="max-w-[56ch] text-[0.9375rem] leading-[1.6] text-sea-ink-soft dark:text-muted-foreground">
              The same traces, scores, datasets, and prompt versions back every workflow — from debugging a single
              request to benchmarking a model swap — all on infrastructure you own.
            </p>
          </div>
          <div className="border-t border-x border-[--rule] bg-background">
            {USE_CASES.map((u, i) => (
              <div
                key={u.label}
                className="grid grid-cols-1 gap-x-6 gap-y-2 border-b border-[--rule] px-7 py-5 sm:grid-cols-[2rem_13rem_minmax(0,1fr)_auto] sm:items-baseline"
              >
                <p className="font-mono text-[0.8125rem] tracking-tight text-muted-foreground tabular-nums">
                  {String(i + 1).padStart(2, "0")}
                </p>
                <p className="font-semibold text-[0.9375rem] leading-snug tracking-tight text-sea-ink dark:text-foreground">
                  {u.label}
                </p>
                <p className="text-[0.90625rem] leading-[1.6] text-sea-ink-soft dark:text-muted-foreground">{u.body}</p>
                <div className="flex flex-wrap gap-1.5 sm:justify-end">
                  {u.tags.map((tag) => (
                    <span
                      key={tag}
                      className="rounded bg-primary/10 px-2 py-0.5 font-mono text-[0.6875rem] tracking-tight text-primary"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-8">
            <a
              href={USE_CASES_URL}
              className="group inline-flex items-center gap-1.5 font-mono text-xs tracking-[0.04em] text-muted-foreground no-underline transition-colors hover:text-foreground"
            >
              See all use cases
              <ArrowRightIcon className="size-4 transition-transform group-hover:translate-x-0.5" aria-hidden />
            </a>
          </div>
        </div>
      </section>

      <section
        aria-labelledby="closing-heading"
        className="atoll-band relative isolate overflow-hidden bg-[image:var(--gradient-atoll)] text-(--on-gradient-fg)"
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-0 mix-blend-screen opacity-[0.16]"
          style={{ backgroundImage: "var(--pattern-topo-light)", backgroundSize: "460px 460px" }}
        />
        <div className="page-wrap relative max-w-245 py-24 text-center">
          <div className="mx-auto mb-6 flex justify-center text-(--on-gradient-fg)">
            <BrandMark className="size-24 [filter:drop-shadow(0_6px_18px_rgba(0,0,0,0.28))] transition-transform duration-2400 ease-(--ease-tide,cubic-bezier(0.16,1,0.3,1)) hover:rotate-360 motion-reduce:transition-none" />
          </div>
          <p className="kicker mb-4 text-(--on-gradient-fg-soft)">ready when you are</p>
          <h2
            id="closing-heading"
            className="display-title mx-auto max-w-[22ch] text-balance text-[clamp(1.875rem,4.5vw,3.5rem)] font-bold leading-[1.05] tracking-tight"
          >
            Trace your first LLM call in minutes.
          </h2>
          <p className="mx-auto mt-5 max-w-[56ch] text-pretty text-base leading-[1.55] text-(--on-gradient-fg-soft) sm:text-lg">
            Open source, Apache-2.0. `bun run setup && bun run dev` locally, or docker compose for production — with
            Helm on Kubernetes when you outgrow one host.
          </p>
          <div className="mt-9 flex flex-wrap items-center justify-center gap-3.5">
            <Button
              asChild
              size="lg"
              className="bg-(--on-gradient-fg) text-sea-ink hover:bg-(--on-gradient-fg)/90 hover:text-sea-ink"
            >
              <a href={GETTING_STARTED_URL} className="no-underline">
                Get started
              </a>
            </Button>
            <Button
              asChild
              variant="outline"
              size="lg"
              className="border-(--on-gradient-border) bg-(--on-gradient-button-bg) text-(--on-gradient-fg) hover:border-(--on-gradient-fg) hover:bg-(--on-gradient-button-bg) hover:text-(--on-gradient-fg)"
            >
              <a href={GITHUB_URL} className="no-underline" target="_blank" rel="noreferrer">
                Star on GitHub
              </a>
            </Button>
          </div>
        </div>
      </section>
    </>
  );
}
