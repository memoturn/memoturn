import { Badge, BrandMark, Button } from "@memoturn/ui";
import { createFileRoute } from "@tanstack/react-router";
import { ArrowRightIcon } from "lucide-react";

import { DOCS_PUBLIC_URL, GITHUB_URL } from "../lib/public-urls.ts";

export const Route = createFileRoute("/")({
  component: Landing,
});

const QUICKSTART_URL = `${DOCS_PUBLIC_URL}/quickstart/`;
const USE_CASES_URL = `${DOCS_PUBLIC_URL}/use-cases/`;

// Pluggable backends — the runtime ships interfaces, not lock-in.
const BACKENDS = ["Claude", "OpenAI", "Ollama", "Bedrock", "Docker", "gVisor"];

// The canonical three-leg grid. DESIGN.md permits the identical-card-grid
// exception only at a count of three; everything else lives in the ledger.
const FEATURES = [
  {
    eyebrow: "durable",
    title: "Agents that survive crashes",
    body: "Each agent is an in-process actor with its own SQLite store. Idle actors hibernate to disk and rehydrate on demand — durable state, zero cost when nothing's happening.",
    tags: ["actor", "SQLite", "hibernation"],
  },
  {
    eyebrow: "sandboxed",
    title: "Run code, not risk",
    body: "Untrusted Python executes in ephemeral sandboxes — Docker, gVisor, or subprocess — with zero ambient authority. Capabilities are granted explicitly, nothing is inherited.",
    tags: ["Docker", "gVisor", "capability RPC"],
  },
  {
    eyebrow: "interoperable",
    title: "MCP and A2A, both ways",
    body: "Every agent is an MCP server other tools can call, and an A2A agent other frameworks can discover. Mount external MCP tools and remote A2A agents as tools your agents call mid-turn.",
    tags: ["MCP", "A2A", "tools"],
  },
];

// The rest of the surface, rendered as a hairline ledger rather than a
// second card grid (no four-up / six-up grids per DESIGN.md).
const CAPABILITIES = [
  {
    label: "durability engine",
    body: "A SQLite checkpoint engine behind a `Durability` interface makes execution crash-safe — a fiber resumes from its last checkpoint, not from scratch. The engine is swappable behind the interface.",
    tags: ["checkpoint", "fibers", "crash-safe"],
  },
  {
    label: "workspace VFS",
    body: "A virtual filesystem per agent: SQLite for metadata, MinIO or any S3-compatible store for blobs. Durable, portable, and inspectable — the agent's working memory on disk.",
    tags: ["SQLite", "S3 / MinIO", "blobs"],
  },
  {
    label: "execution ladder",
    body: "Additive by design: an agent is useful at Tier 0 with just a durable filesystem and chat, and climbs to sandboxed code, browser, and full-OS only as the task needs it.",
    tags: ["Tier 0", "additive", "escalate"],
  },
  {
    label: "pluggable everywhere",
    body: "`Provider`, `Sandbox`, and `Durability` are interfaces. Ships with Anthropic, Docker, and SQLite-checkpoint implementations; swap in OpenAI, Ollama, Bedrock, or a gVisor-isolated sandbox without forking.",
    tags: ["Provider", "Sandbox", "interfaces"],
  },
  {
    label: "enterprise-ready",
    body: "Multi-tenant from day one, OpenTelemetry traces and metrics, API-key/JWT auth with RBAC, and a default-deny network posture. docker-compose on a single host, or the Helm chart on Kubernetes for elastic scale-out.",
    tags: ["OTel", "multi-tenant", "Helm"],
  },
  {
    label: "open core",
    body: "Apache-2.0 at the core. A self-hostable Enterprise Edition adds OIDC SSO, SCIM provisioning, audit export, and usage-metered billing for running Memoturn as a multi-tenant platform — still on infrastructure you own.",
    tags: ["SSO/SCIM", "audit", "metered billing"],
  },
];

// What you build with the primitives above. A numbered ledger, not a second
// card grid — DESIGN.md spends the identical-card-grid exception on FEATURES.
const USE_CASES = [
  {
    label: "Long-running autonomous workers",
    body: "Agents that run for hours or days — research, migrations, monitoring — and resume from their last checkpoint after a crash or restart, not from scratch.",
    tags: ["fibers", "checkpoints", "hibernation"],
  },
  {
    label: "Code-interpreter & data agents",
    body: "Let an agent write and run its own Python over your data, in an ephemeral sandbox with zero ambient authority — without handing it your machine.",
    tags: ["sandbox", "gVisor", "capability RPC"],
  },
  {
    label: "Multi-tenant agent platforms",
    body: "Run agents for every customer or team from one deployment — each tenant isolated, each agent owned by a single replica via consistent-hash leases.",
    tags: ["multi-tenant", "scale-out", "leases"],
  },
  {
    label: "Memory-centric assistants",
    body: "Assistants that remember across sessions and can recall exactly what they knew at any past turn, with history compaction that extracts memories before dropping turns.",
    tags: ["memory", "as-of-turn", "sessions"],
  },
  {
    label: "Tool & agent hubs",
    body: "Mount external MCP servers and remote A2A agents as tools, and expose your own agents the same way — interop in both directions, mid-turn.",
    tags: ["MCP", "A2A", "interop"],
  },
  {
    label: "Self-hosted & air-gapped agents",
    body: "Run fully offline against local Ollama on infrastructure you own — no proprietary cloud, no per-idle-minute bill, nothing leaving your network.",
    tags: ["self-hosted", "Ollama", "offline"],
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
            Durable AI agents, on infrastructure you own.
          </h1>
          <p className="mt-7 max-w-[56ch] text-pretty text-base leading-[1.55] text-sea-ink-soft dark:text-muted-foreground sm:text-lg">
            Memoturn runs persistent, per-task agents that survive crashes, cost nothing when idle, and execute code in
            sandboxes with zero ambient authority — a self-hostable, Docker-based runtime you run anywhere. No
            proprietary cloud required.
          </p>
          <div className="mt-9 flex flex-wrap items-center gap-3">
            <Button asChild size="lg">
              <a href={QUICKSTART_URL} className="no-underline">
                Read the quickstart
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
              <dt className="sr-only">Runtime</dt>
              <dd>Docker-based</dd>
            </div>
            <div className="inline-flex items-center gap-1.5">
              <span aria-hidden className="size-1 rounded-full bg-primary/70" />
              <dt className="sr-only">Protocols</dt>
              <dd>MCP + A2A</dd>
            </div>
            <div className="inline-flex items-center gap-1.5">
              <span aria-hidden className="size-1 rounded-full bg-primary/70" />
              <dt className="sr-only">Sandbox</dt>
              <dd>zero ambient authority</dd>
            </div>
          </dl>
        </div>
      </section>

      <section aria-label="Pluggable backends" className="border-y border-border/60 bg-background">
        <div className="page-wrap max-w-6xl! py-6">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <span className="kicker">swap in</span>
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
              pluggable interfaces
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
                Today's agents are ephemeral, locked to one device, expensive when idle, and unsafe to let run code.
              </p>
            </div>
            <p className="max-w-[44ch] text-pretty text-[0.9375rem] leading-[1.65] text-sea-ink-soft dark:text-muted-foreground">
              The durable-agent capabilities that used to require a proprietary cloud — durable actors, hibernation,
              sandboxed execution, crash-safe fibers — rebuilt on open infrastructure you can run anywhere Docker runs.
              Useful at Tier 0 alone, and additive from there.
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
              A durable runtime, every primitive open.
            </h2>
            <p className="max-w-[56ch] text-[0.9375rem] leading-[1.6] text-sea-ink-soft dark:text-muted-foreground">
              No proprietary cloud, no black boxes. The actor, the sandbox, the durability engine, and the workspace are
              all interfaces you can inspect, swap, and self-host.
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
            <p className="kicker mb-4">also in the runtime</p>
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
              Durable primitives, composed into real workflows.
            </h2>
            <p className="max-w-[56ch] text-[0.9375rem] leading-[1.6] text-sea-ink-soft dark:text-muted-foreground">
              The same actor, sandbox, fiber, and memory primitives back a range of agents — from long-running workers
              to multi-tenant platforms — all on infrastructure you own.
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
            Run persistent AI agents on infrastructure you own.
          </h2>
          <p className="mx-auto mt-5 max-w-[56ch] text-pretty text-base leading-[1.55] text-(--on-gradient-fg-soft) sm:text-lg">
            Open source, Apache-2.0. Spin it up with `docker compose` on a single host, or Helm on Kubernetes for
            production.
          </p>
          <div className="mt-9 flex flex-wrap items-center justify-center gap-3.5">
            <Button
              asChild
              size="lg"
              className="bg-(--on-gradient-fg) text-sea-ink hover:bg-(--on-gradient-fg)/90 hover:text-sea-ink"
            >
              <a href={QUICKSTART_URL} className="no-underline">
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
