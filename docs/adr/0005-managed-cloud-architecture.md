# ADR 0005 — Managed cloud: multi-tenant architecture on the self-host codebase

- **Status:** Proposed (trigger-gated — see [Build phases & triggers](#build-phases--triggers)).
  Depends on **ADR-0002** (Postgres tier — implemented) and, for the serverless path,
  **ADR-0003** (edge profile — proposed).
- **Date:** 2026-07-23
- **Context tags:** multi-tenancy, control plane, deployment profiles, cloud

## Context

memoturn ships as a self-hostable stack today. A hosted, multi-tenant **memoturn cloud** is
planned alongside it. This ADR records *how* cloud is built on the existing codebase and *when*
each layer gets built — not the pricing, packaging, or go-to-market, which are product/business
concerns kept in the internal roadmap (deliberately out of the public repo).

Much of the substrate already exists and was built cloud-aware (the standing design lens: seams
over coupling, no long-lived-process assumptions, per-tenant metering hooks):

- **Multi-tenancy** — the Better Auth organization plugin: `Organization` → `Project`, every
  telemetry row and metadata row scoped by `organizationId`/`projectId`, RBAC enforced on every
  route (the multi-tenant invariant). This is the isolation primitive cloud reuses unchanged.
- **Remote MCP OAuth 2.1** (per-project resource URLs) and the **admin plugin**
  (ban/impersonate external users via `SUPERADMIN_USER_IDS`) — the auth + tenant-support surface.
- **Postgres telemetry tier** (ADR-0002) — a Neon-viable, low-footprint data plane for a tenant.
- **Usage metering** (bytes/events/traces per project per day, measured pre-sampling) — the
  per-tenant volume signal any billing plugs into.
- **Cost controls** (head + tail sampling) and **graduation** (ADR-0004 `scanRows` copy path).

What is *not* defined: the tenancy/isolation model at scale, the **control plane** (tenant
lifecycle — provision, route, suspend, delete), and how these pieces assemble into a running
SaaS. This ADR defines those.

**Hard constraint:** one codebase across OSS self-host, enterprise self-host, and cloud — **no
fork**. Cloud-only behavior is config/flags, never divergent code. And per the project's
monetization policy, billing/paywall infrastructure is deferred until there are paying customers;
this ADR gates the *build* of each layer behind an explicit trigger and does not build billing.

## Decision

**Cloud is the same images plus a thin control plane — not a new product.**

1. **One codebase, two new things.** Cloud runs the same `apps/api` + `apps/worker` + `apps/console`
   on either the **edge profile** (ADR-0003: Workers + Neon + R2 + Queues) or the container-scale
   profile. The only genuinely new architecture is (a) a **tenant registry + connection-routing
   resolver** and (b) a **control plane** for tenant lifecycle. Everything else is reuse.

2. **Isolation model: shared control plane, a per-tenant data-plane spectrum.**
   - **Default (small tenants): shared data plane.** One Postgres + one telemetry store; isolation
     is the row-level `organizationId`/`projectId` scoping the codebase *already* enforces
     everywhere. No new isolation mechanism — the multi-tenant invariant is the isolation.
   - **Large / noisy / enterprise tenants: dedicated data plane.** A tenant gets its own telemetry
     store (a Neon project, or Doris) resolved per-request through the `TelemetryStore` seam; the
     ADR-0004 graduation path moves a tenant shared → dedicated with no downtime. Same code,
     different connection resolution.

3. **The connection-routing resolver** is the one new load-bearing piece: a per-request map from
   the authenticated tenant (org) to its data-plane connection(s) — telemetry store, and
   optionally a dedicated Postgres. Backed by a **tenant registry** (a Postgres table in the
   control-plane database) and cached. Self-host resolves to a single static connection (the
   resolver is a no-op there), so this stays behind the same seam and doesn't fork behavior.

4. **The control plane** (new, thin, built on existing plugins): **provision** (signup → create org
   + default project + API keys + registry row + connection routing) → **operate** (usage already
   metered per project; admin plugin for support/abuse) → **lifecycle** (suspend / resume / delete
   a tenant, cascading through the existing `onDelete: Cascade` graph + telemetry
   `deleteProjectData`). Regions, per-tenant backups, and status/SLA are cloud-ops work this ADR
   flags but does not specify.

5. **Billing is out of scope here — by design.** The metering *signal* exists (per-org usage
   aggregation is a thin rollup over `UsageDaily`); this ADR records the **hook** billing plugs
   into (a per-org usage total + a limits/enforcement point at the ingest gate, sibling to the
   existing rate limiter), not the pricing, packaging, free-tier limits, payment integration, or
   GTM. Those live in the internal roadmap and are built when the monetization trigger fires.

## Consequences

**Positive**
- No fork: cloud reuses the entire product; a feature shipped to OSS is a feature in cloud.
- Per-tenant isolation is already enforced and tested (org scoping is the multi-tenant invariant),
  so the shared-data-plane default is safe from day one — the resolver is the only new trust-
  bearing code.
- Noisy-neighbor and enterprise-isolation needs are handled by an existing mechanism (the
  graduation path), not a new one.
- The metering + admin + OAuth work already merged means Phase 1 is genuinely thin.

**Negative / cost**
- The resolver + tenant registry are new load-bearing surface (a routing bug is a cross-tenant
  data risk) — it needs the same rigor as the auth middleware, with tests that assert isolation.
- Shared data plane carries noisy-neighbor risk (one tenant's volume degrading another's queries)
  until that tenant graduates; needs per-tenant quota/limit enforcement (the metering hook).
- The control plane is real new surface (provisioning, lifecycle, secret management per tenant) to
  build and secure.
- Cloud operations not covered here — regions/residency, per-tenant backup/restore, a status page,
  SLA, on-call, support tooling — are substantial and gated to later phases.

## Alternatives considered

- **Per-tenant full stack (a container/deployment per tenant).** Strongest isolation, but heavy
  ops and cost for the small-tenant majority. Rejected as the default; retained as the
  *dedicated-data-plane* option for large/enterprise tenants (a lighter version — dedicated data
  plane, shared compute — captures most of the benefit).
- **Fork a cloud codebase.** Rejected outright — divergence is exactly what the `TelemetryStore`,
  queue, and deployment-profile seams were built to avoid.
- **A third-party multi-tenant/billing platform for the whole offering.** Doesn't fit — the
  isolation and data-plane routing are memoturn-specific; only the *payment* piece (a later phase)
  is a candidate for a third party (e.g. Stripe).

## Build phases & triggers

- **Phase 0 — substrate (DONE).** Org multi-tenancy + RBAC, Postgres tier (ADR-0002), usage
  metering, MCP OAuth, admin plugin, cost controls. Cloud-ready primitives, all shipped as OSS.
- **Phase 1 — control plane MVP.** *Trigger: a decision to run a hosted beta.* Tenant registry +
  connection-routing resolver + provisioning (signup → org/project/keys) on the shared data plane.
  The queue port (ADR-0003 Phase 1) lands here if cloud runs on the edge profile. **No billing.**
- **Phase 2 — metered limits + billing.** *Trigger: beta demand / a first would-be paying tenant.*
  The per-org usage rollup, a limits-enforcement hook at ingest, and the payment integration —
  pricing/packaging/free-tier per the internal roadmap. This is where monetization infra is built,
  not before.
- **Phase 3 — dedicated data planes.** *Trigger: a tenant outgrows the shared plane, or an
  enterprise isolation requirement.* Per-tenant telemetry stores via ADR-0004 graduation; regions
  / data residency.
- **Phase 4 — compliance-as-paid.** *Trigger: an enterprise compliance deal.* The `/ee` license
  gate + SCIM / extended audit export / residency (the roadmap's paid line).

Until Phase 1's trigger fires, this ADR only records the architecture — it makes cloud *ready to
build* without building (or committing to) any of it. The substrate stays 100% OSS; nothing here
gates existing self-host behavior.
