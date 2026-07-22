import { BrandMark, Button } from "@memoturn/ui";
import { createFileRoute } from "@tanstack/react-router";
import { ArrowRightIcon } from "lucide-react";

import heroDashboard from "../assets/shots/hero-dashboard.png";
import shotEvaluators from "../assets/shots/shot-evaluators.png";
import shotPrompt from "../assets/shots/shot-prompt.png";
import shotWaterfall from "../assets/shots/shot-waterfall.png";
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
// Each leg is anchored by a real console capture, not an icon.
const FEATURES = [
  {
    key: "observability",
    title: "Every call, traced",
    body: "Traces, spans, generations, and scores on a waterfall timeline, with sessions and per-user rollups. Ingest from the SDKs, the OpenAI and LangChain wrappers, or any OpenTelemetry exporter speaking OTLP/JSON with GenAI semantic conventions.",
    tags: ["traces", "waterfall", "OTel"],
    shot: shotWaterfall,
    shotAlt:
      "An agent-loop trace in the memoturn console: eight observations on a waterfall timeline, tool spans in green, generations in blue, the failing final-answer call accented in red.",
    shotSize: { width: 2880, height: 1400 },
  },
  {
    key: "evaluation",
    title: "Evals, three ways",
    body: "Offline experiments over datasets, online evaluators sampling production traces, and human review queues with one-click scoring. Every score lands in Doris and shows up on the trace it came from.",
    tags: ["offline", "online", "human review"],
    shot: shotEvaluators,
    shotAlt:
      "The evaluators page in the memoturn console: score trends per evaluator and the evaluator registry with online sampling rates.",
    shotSize: { width: 2880, height: 1500 },
  },
  {
    key: "prompts",
    title: "Prompts with deploy channels",
    body: "A versioned prompt registry with production, staging, and custom channels, plus A/B experiments that split live traffic between versions and compare arms by score. Fetch with getPrompt and iterate in a multi-provider streaming playground.",
    tags: ["versioned", "channels", "A/B tests"],
    shot: shotPrompt,
    shotAlt:
      "A prompt in the memoturn console: deployment channels, an A/B experiment form splitting traffic between versions, and cost attributed per version.",
    shotSize: { width: 2880, height: 1500 },
  },
];

// The rest of the surface, rendered as a hairline ledger rather than a
// second card grid (no four-up / six-up grids per DESIGN.md).
const CAPABILITIES = [
  {
    label: "metrics & dashboards",
    body: "Cost, tokens, and latency (p50/p95) over a Doris rollup, sliced by day, model, user, session, and tool. Pin filtered metrics to custom dashboards and saved views.",
  },
  {
    label: "monitors & automations",
    body: "Stateful alert rules and cost budgets evaluated every minute, plus trigger-to-action rules on platform events that fire webhooks or Slack messages when a score drops or spend spikes.",
  },
  {
    label: "datasets & experiments",
    body: "Dataset items and experiment runs that link every item to the trace it produced. Benchmark prompts and models side by side in a comparison matrix before anything ships.",
  },
  {
    label: "embeddings & search",
    body: "Embedding projections over your traces and semantic find-similar search, so one bad generation leads you to every trace that means the same thing.",
  },
  {
    label: "playground",
    body: "Multi-provider with streaming, structured output, and tool calling. Every playground run is recorded as a trace, and any trace payload opens back into the playground.",
  },
  {
    label: "MCP server",
    body: "Prompts, datasets, and review queues exposed as tools inside agent IDEs like Claude Code and Cursor, as a local stdio server or over Streamable HTTP per project, with per-tool RBAC.",
  },
];

// The wedge: platform capabilities competitors gate behind an enterprise
// tier, shipped in the Apache-2.0 core. Rendered as its own section, not a
// ledger row — this is the one claim a self-hosting evaluator can't get
// elsewhere for free.
const PLATFORM = [
  { label: "SSO", body: "OIDC and SAML via your own IdP, mapped by email domain." },
  { label: "RBAC", body: "Owner, admin, member, and read-only viewer roles per organization." },
  { label: "Audit logs", body: "Every mutating action recorded with actor, action, and target." },
  { label: "PII masking", body: "Masking rules applied at ingest, before anything is stored." },
  { label: "Retention & exports", body: "Per-project retention policies and scheduled NDJSON exports to blob." },
  { label: "Keys & rate limits", body: "API-key management and per-project rate limits." },
];

// What you build with the primitives above. A hairline ledger, not a second
// card grid — DESIGN.md spends the identical-card-grid exception on FEATURES.
const USE_CASES = [
  {
    label: "Debug production LLM traffic",
    body: "Follow a request through every span and generation on the waterfall timeline, with full input/output payloads and session grouping across turns.",
  },
  {
    label: "Track spend by model & feature",
    body: "Cost, token, and latency rollups per day, model, user, and tool out of Doris. Know what each feature costs before the invoice tells you.",
  },
  {
    label: "Catch regressions before users do",
    body: "Online evaluators sample live production traces and score them continuously; monitors turn a bad score or a cost spike into a Slack alert or webhook.",
  },
  {
    label: "Ship prompts like code",
    body: "Versioned, immutable prompt registry with deployment channels: promote to production, A/B test challengers on live traffic, roll back instantly.",
  },
  {
    label: "Benchmark models & prompts",
    body: "Run experiments over datasets, score them with LLM-as-judge evaluators, and compare runs side by side before switching models.",
  },
  {
    label: "Self-host for compliance",
    body: "PII masking at ingest, audit logs, retention policies, and scheduled exports, with every byte of telemetry staying on your infrastructure.",
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
          WebkitMaskImage: "radial-gradient(ellipse 88% 78% at 50% 35%, #000 55%, transparent 100%)",
          maskImage: "radial-gradient(ellipse 88% 78% at 50% 35%, #000 55%, transparent 100%)",
        }}
      >
        <div className="page-wrap relative max-w-6xl! pt-24 pb-20">
          <div className="mb-8 inline-flex items-center gap-3">
            <BrandMark gradient className="size-7 shrink-0" />
            <p className="m-0 font-mono text-xs tracking-[0.04em] text-muted-foreground">open source · Apache-2.0</p>
          </div>
          <h1
            id="hero-heading"
            className="display-title max-w-[24ch] text-[clamp(2.75rem,6.5vw,5.25rem)] text-foreground"
          >
            See every LLM call. <span className="tone-soft">On infrastructure you own.</span>
          </h1>
          <p className="mt-7 max-w-[58ch] text-pretty text-base leading-[1.6] text-muted-foreground sm:text-lg">
            Memoturn is an open-source AI engineering platform: tracing, cost and latency metrics, offline, online, and
            human evals, versioned prompts with deploy channels, monitors, and datasets. OpenTelemetry-native,
            self-hostable, and nothing leaves your network.
          </p>
          <div className="mt-9 flex flex-wrap items-center gap-3">
            <Button asChild size="lg" className="bg-foam text-sea-ink hover:bg-foam/90 hover:text-sea-ink">
              <a href={GETTING_STARTED_URL} className="no-underline">
                Get started
              </a>
            </Button>
            <Button asChild variant="outline" size="lg" className="group">
              <a href={GITHUB_URL} className="no-underline" target="_blank" rel="noreferrer">
                Star on GitHub
                <ArrowRightIcon className="size-4 transition-transform group-hover:translate-x-0.5" aria-hidden />
              </a>
            </Button>
          </div>
          <dl className="mt-7 flex flex-wrap items-center gap-x-4 gap-y-1.5 font-mono text-xs tracking-[0.04em] text-muted-foreground">
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
              <dd>TS + Python + Go SDKs</dd>
            </div>
            <div className="inline-flex items-center gap-1.5">
              <span aria-hidden className="size-1 rounded-full bg-primary/70" />
              <dt className="sr-only">Analytics store</dt>
              <dd>Apache Doris-backed</dd>
            </div>
          </dl>

          {/* The product, above the fold. One signature entrance; the bottom
              edge dissolves into the canvas so the console reads as part of
              the page, not a pasted rectangle. */}
          <div
            className="rise-in relative mt-14"
            style={{
              WebkitMaskImage: "linear-gradient(to bottom, #000 78%, transparent 100%)",
              maskImage: "linear-gradient(to bottom, #000 78%, transparent 100%)",
            }}
          >
            <div className="frame-shot">
              <img
                src={heroDashboard}
                width={2880}
                height={1660}
                alt="The memoturn dashboard: traces, generations, errors, tokens, and cost tiles above a 30-day cost chart, with p95 latency at hand."
                fetchPriority="high"
              />
            </div>
          </div>
        </div>
      </section>

      <section aria-label="Ingestion sources" className="border-y border-border/60 bg-background">
        <div className="page-wrap max-w-6xl! py-6">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <span className="font-mono text-xs tracking-[0.04em] text-muted-foreground">works with</span>
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
            <h2
              id="why-heading"
              className="display-title max-w-[30ch] text-[clamp(1.875rem,3.8vw,2.875rem)] text-foreground"
            >
              LLM apps ship blind.{" "}
              <span className="tone-soft">
                No cost visibility, silent quality regressions, prompts versioned in a Slack thread.
              </span>
            </h2>
            <p className="max-w-[44ch] text-pretty text-[0.9375rem] leading-[1.7] text-muted-foreground">
              The observability stack the LLM SaaS vendors run — traces, eval pipelines, prompt registries — rebuilt on
              open infrastructure: Postgres, Apache Doris, Redis, S3. One docker compose away, and your telemetry never
              leaves your network.
            </p>
          </div>
        </div>
      </section>

      <section aria-labelledby="features-heading" className="border-y border-border/60 bg-card/50">
        <div className="page-wrap relative max-w-6xl! py-24">
          <div className="mb-12 grid max-w-[62ch] gap-4">
            <h2 id="features-heading" className="display-title text-[clamp(2rem,4vw,3rem)] text-foreground">
              The full AI engineering loop. <span className="tone-soft">Every piece open.</span>
            </h2>
            <p className="max-w-[56ch] text-[0.9375rem] leading-[1.65] text-muted-foreground">
              No proprietary cloud, no black boxes. Observe what your app does, evaluate whether it's good, and ship the
              next prompt: one platform you can inspect, extend, and self-host.
            </p>
          </div>
          <div className="grid border-t border-l border-[--rule] bg-background md:grid-cols-3">
            {FEATURES.map((f) => (
              <article key={f.key} className="glow-panel flex flex-col gap-4 border-r border-b border-[--rule] pb-8">
                <div className="overflow-hidden border-b border-[--rule]" style={{ aspectRatio: "16 / 10" }}>
                  <img
                    src={f.shot}
                    width={f.shotSize.width}
                    height={f.shotSize.height}
                    alt={f.shotAlt}
                    loading="lazy"
                    className="size-full object-cover object-top"
                  />
                </div>
                <div className="flex grow flex-col gap-3.5 px-7">
                  <h3 className="display-title text-[1.375rem] text-foreground">{f.title}</h3>
                  <p className="text-[0.90625rem] leading-[1.65] text-muted-foreground">{f.body}</p>
                  <div className="mt-auto flex flex-wrap gap-1.5 border-t border-dashed border-[--rule] pt-4.5">
                    {f.tags.map((tag) => (
                      <span
                        key={tag}
                        className="rounded bg-primary/10 px-2 py-0.5 font-mono text-xs tracking-tight text-primary"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
              </article>
            ))}
          </div>
          <div className="mt-14">
            <h3 className="display-title mb-5 text-[1.125rem] text-foreground">Also on the platform</h3>
            <div className="border-t border-x border-[--rule] bg-background">
              {CAPABILITIES.map((c) => (
                <div
                  key={c.label}
                  className="grid grid-cols-1 gap-x-6 gap-y-1.5 border-b border-[--rule] px-7 py-5 sm:grid-cols-[13rem_minmax(0,1fr)] sm:items-baseline"
                >
                  <p className="font-semibold text-[0.9375rem] tracking-[-0.005em] text-foreground">{c.label}</p>
                  <p className="text-[0.90625rem] leading-[1.65] text-muted-foreground">{c.body}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section aria-labelledby="platform-heading" className="bg-background">
        <div className="page-wrap max-w-6xl! py-24">
          <div className="grid gap-10 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] lg:gap-16">
            <div className="grid content-start gap-4">
              <h2 id="platform-heading" className="display-title text-[clamp(1.875rem,3.8vw,2.875rem)] text-foreground">
                The enterprise tier <span className="tone-soft">is the free tier.</span>
              </h2>
              <p className="max-w-[44ch] text-[0.9375rem] leading-[1.7] text-muted-foreground">
                SSO, RBAC, audit logs, and PII masking are where observability vendors put the paywall. In memoturn,
                every one of these ships in the Apache-2.0 core. Self-host it, pass your security review, and pay
                nobody.
              </p>
            </div>
            <dl className="m-0 grid border-t border-l border-[--rule] bg-background sm:grid-cols-2">
              {PLATFORM.map((p) => (
                <div key={p.label} className="glow-panel grid gap-1.5 border-r border-b border-[--rule] px-6 py-5">
                  <dt className="font-semibold text-[0.9375rem] tracking-[-0.005em] text-foreground">{p.label}</dt>
                  <dd className="m-0 text-[0.875rem] leading-[1.6] text-muted-foreground">{p.body}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </section>

      <section aria-labelledby="use-cases-heading" className="border-t border-border/60 bg-card/50">
        <div className="page-wrap max-w-6xl! py-24">
          <div className="mb-12 grid max-w-[62ch] gap-4">
            <h2 id="use-cases-heading" className="display-title text-[clamp(2rem,4vw,3rem)] text-foreground">
              From first trace to shipped prompt. <span className="tone-soft">One loop.</span>
            </h2>
            <p className="max-w-[56ch] text-[0.9375rem] leading-[1.65] text-muted-foreground">
              The same traces, scores, datasets, and prompt versions back every workflow, from debugging a single
              request to benchmarking a model swap, all on infrastructure you own.
            </p>
          </div>
          <div className="border-t border-x border-[--rule] bg-background">
            {USE_CASES.map((u) => (
              <div
                key={u.label}
                className="grid grid-cols-1 gap-x-6 gap-y-1.5 border-b border-[--rule] px-7 py-5 sm:grid-cols-[16rem_minmax(0,1fr)] sm:items-baseline"
              >
                <p className="font-semibold text-[0.9375rem] leading-snug tracking-[-0.005em] text-foreground">
                  {u.label}
                </p>
                <p className="text-[0.90625rem] leading-[1.65] text-muted-foreground">{u.body}</p>
              </div>
            ))}
          </div>
          <div className="mt-8">
            <a
              href={USE_CASES_URL}
              className="group inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground no-underline transition-colors hover:text-foreground"
            >
              See all use cases in the docs
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
          <h2 id="closing-heading" className="display-title mx-auto max-w-[22ch] text-[clamp(1.875rem,4.5vw,3.5rem)]">
            Trace your first LLM call in minutes.
          </h2>
          <p className="mx-auto mt-5 max-w-[56ch] text-pretty text-base leading-[1.6] text-(--on-gradient-fg-soft) sm:text-lg">
            Open source, Apache-2.0. Run <code className="bg-white/12 text-inherit">bun run setup && bun run dev</code>{" "}
            locally, or docker compose for production, with Helm on Kubernetes when you outgrow one host.
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
