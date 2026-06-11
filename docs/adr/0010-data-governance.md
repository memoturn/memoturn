# ADR-0010: Per-namespace data-governance policies in object storage

**Status:** accepted · 2026-06

**Decision:** Enterprise data handling is governed by **one JSON policy document per namespace**,
stored in object storage at `v1/_policy/{ns}.json`, CAS-written (the manifest discipline from
ADR-0004) and read through a per-node cache (`MEMOTURN_POLICY_CACHE_SECS`, default 30 s). The
document holds the namespace policy plus **tighten-only per-profile overrides**; the effective
policy for a profile is the field-wise strictest of (node env ceiling, namespace, profile). A
policy can only *constrain* — never grant — so absent and unknown fields are safe to ignore, and
unknown fields round-trip through read-modify-write (`#[serde(flatten)]`), letting old and new
nodes share a document. v1 sections: `retention` (PITR window caps), `memory` (task-TTL cap,
event max age, superseded-history age/count caps), `erasure`, `audit`, `ai_egress`. Enforcement
(shipped): per-database PITR windows = `min(env, policy)` inside `enforce_retention`;
memory-age rules run in the writer-side maintenance sweep (bounded to 500 deletes/pass — these
deletes ship segments); task TTLs clamp at ingest (owner re-clamps forwarded writes);
`ai_egress.extract|ask = deny` → deterministic 403 before the provider is touched;
`ai_egress.embed = deny` degrades exactly like an unconfigured embedder (silent skip, keyword
recall intact), and `self_hosted_only` accepts only an embedder whose base URL is loopback /
RFC1918 / cluster-internal / `MEMOTURN_EMBED_SELF_HOSTED_HOSTS`-allowlisted (decided once at
startup — a syntactic check that trusts the operator's network config).

**Failure posture, split deliberately:** AI egress checks **fail closed** (no policy ever
loadable → 503; a compliance control must not fail open), while TTL clamps and retention
**fail open with loud logs** — governance is constraint tightening and must not join the write
path's failure domain. Policy `pitr_secs` must be ≥ 60: env `0` keeps its legacy meaning
"retention pass disabled" and must never enter a policy, or operators would disable retention
believing they tightened it.

**Rejected:** *Policy in the control plane (etcd / in-process)* — the in-process table forgets on
restart (the same reason deletion tombstones escaped to the registry, ADR-0009) and violates
"object storage is the source of truth / nodes disposable". *Registry + catalog backup* — node-
local; cross-node propagation would ride a debounced backup other nodes never re-read after boot.
*Rejecting over-cap task TTLs* — clamping keeps ingest idempotent and agents unmodified.
*A `__memoturn_audit` table for the audit trail (phase 2)* — audit would inherit PITR/branching:
a branch rewind could erase audit history; audit must sit outside the data plane it observes.

**Update (2026-06): audit logging shipped (phase 2).** Per-namespace append-only JSONL in object
storage (`v1/_audit/{ns}/{yyyy}/{mm}/{dd}/{flush_ts}-{node}-{seq}.jsonl` — immutable object per
flush, collision-free multi-node writers, **outside PITR/branching** so a rewind can never erase
the trail), non-blocking emit → background flusher (512 events / `MEMOTURN_AUDIT_FLUSH_MS`,
default 2 s; drop-and-count on backpressure, never blocking a write; graceful shutdown drains).
Events: memory mutations (edge-emitted with the client's identity; the owner of a forwarded
write sees the internal actor and stays silent — except `ai.embed`, which emits where bytes
leave), reads behind `audit.include_reads`, AI egress with provider/model/byte/duration metadata
(never payload content; **denials always recorded**), token minting, policy changes (gated on
the *new* policy, so enabling audit is the stream's first record), and db deletion. Actor
attribution = domain-separated SHA-256 hash prefix of the credential plus its claims — never the
token. Read via `GET /v1/namespaces/{ns}/audit` (platform key, or a **namespace admin token**
for its own stream) with cursor pagination over immutable objects; `memoturn audit export`
streams JSONL; `audit.retention_secs` is enforced by a day-granular maintenance sweep. MCP
gains `policy_get`/`policy_set`/`audit_query`; both SDKs gain policy get/set and an audit-event
iterator. Hash-chain tamper evidence stays reserved (`prev` field) — immutable objects + bucket
object-lock are the near-term posture.

**Deferred (tracked here):**
- **Verifiable erasure (phase 3, designed):** erasure coupons at
  `v1/_governance/erasures/{db}/{id}.json` (outside the db prefix and outside `__memoturn_*`
  tables so neither db deletion nor branch rewind loses the evidence): forget at txid `T` with
  `secure_delete` (zeroes freed pages), durable ship, then after `erasure.grace_secs` the
  maintenance loop forces a post-`T` snapshot, prunes manifest references below `T` (a chain
  *prefix* drop below a snapshot base — segment chains never splice), GC reclaims, a verifier
  proves absence by listing (object keys encode txids), and a signed Ed25519 receipt
  (domain-separated, same keypair as JWTs) lands in the coupon. Bounded completion =
  grace + tick + GC grace, not the 30-day snapshot tier. Honest blockers surface in the coupon:
  named checkpoints below `T` and pre-`T` forks (where the datum is live content, not history).
  `erasure.purge_on_forget` upgrades every plain forget into a coupon.
- **Crypto-shredding** rides the per-tenant KMS encryption phase (ADR-0008 deferral) as the
  erasure fast path. Cold-database memory-age sweeps wake on next hot; whole-profile TTL stays
  deferred (ADR-0009).
