# 08 — Data Governance

Enterprise data-handling controls ([ADR-0010](../adr/0010-data-governance.md)): per-namespace
policies for retention, memory aging, task TTLs, AI egress, and (phased) audit logging and
verifiable erasure. Everything here *tightens* what the node would otherwise allow — node env
vars stay the outer ceilings, a namespace constrains its tenants, a profile may constrain itself
further, and nothing in a policy can grant.

## Policy hierarchy

```
node env ceiling             MEMOTURN_PITR_RETENTION_SECS, … (deployment config)
  └── namespace policy       PUT /v1/namespaces/{ns}/policy          (platform key)
        └── profile override PUT /v1/memory/{ns}/{profile}/policy    (admin token, tighten-only)
```

- **Effective policy = field-wise strictest** of all three: `min` for durations/counts, OR for
  booleans, `allow < self_hosted_only < deny` for egress rules. Tighten-only is enforced twice:
  a loosening override is a 409 at PUT time naming each offending field, and evaluation
  recomputes strictest-wins regardless, so the invariant survives racing updates.
- The document lives in object storage (`v1/_policy/{ns}.json`), CAS-written, read through a
  per-node cache (`MEMOTURN_POLICY_CACHE_SECS`, default 30 s). A policy change converges on
  every node within the cache TTL with no restart; the node that served the PUT sees it
  immediately. Maintenance passes read fresh.
- A profile override may exist **before the profile's first ingest** — governance precedes data.
- `GET .../policy` (read scope) returns the override plus the *effective* policy with env
  ceilings folded in: the answer is what enforcement will actually do.

## Policy document

```json
{
  "policy": {
    "retention": { "pitr_secs": 3600, "pitr_snapshot_secs": 604800 },
    "memory":    { "task_ttl_max_secs": 3600, "event_max_age_secs": 7776000,
                   "superseded_max_age_secs": 2592000, "superseded_max_count": 20 },
    "erasure":   { "purge_on_forget": false, "grace_secs": 86400 },
    "audit":     { "enabled": false, "include_reads": false, "retention_secs": null },
    "ai_egress": { "extract": "allow", "ask": "allow", "embed": "self_hosted_only" }
  },
  "profiles": { "alice": { "retention": { "pitr_secs": 600 } } }
}
```

| Field | Effect | Enforced |
| --- | --- | --- |
| `retention.pitr_secs` | caps the fine-grained PITR window for every branch of the profile | retention pass (~10 min tick): `min(env, policy)` into the standard manifest pruning ([02](02-branching.md)) |
| `retention.pitr_snapshot_secs` | caps the snapshot-grained tier | same pass |
| `memory.task_ttl_max_secs` | ceiling on task TTLs (explicit or defaulted) | clamped at ingest; the owner of a forwarded write re-clamps |
| `memory.event_max_age_secs` | events older than this are deleted | writer-side maintenance sweep (~30 s tick), ≤ 500 deletes/pass |
| `memory.superseded_max_age_secs` | superseded rows older than this are deleted | same sweep |
| `memory.superseded_max_count` | per `(type, topic_key)`, keep at most N superseded rows | same sweep |
| `erasure.*` | erasure coupon behavior | phase 3 (designed in ADR-0010) |
| `audit.*` | per-namespace audit stream | phase 2 (designed in ADR-0010) |
| `ai_egress.extract` / `ask` | `allow` \| `deny` — gate the explicit LLM endpoints | request time: deny → 403 naming the field, before recall runs or the provider is touched |
| `ai_egress.embed` | `allow` \| `self_hosted_only` \| `deny` — gate auto-embedding | at the embed call site (the owner node on forwarded writes): deny behaves exactly like an unconfigured embedder |

Validation: durations ≥ 60 s (env `0` keeps its "pass disabled" meaning and never enters a
policy), counts ≥ 1, `pitr_snapshot_secs ≥ pitr_secs`, `self_hosted_only` is embed-only,
`audit.retention_secs` is namespace-level only. Unknown fields are preserved on read-modify-write
so mixed-version fleets share documents safely.

## Enforcement flows

**Retention** — the existing retention pass, policy-aware:

```
every ~10 min, any node (CAS-guarded, idempotent):
  policies = LIST v1/_policy/ + GETs            (fresh)
  for each database:
    fine = min(MEMOTURN_PITR_RETENTION_SECS, policy.pitr_secs?)
    snap = min(MEMOTURN_PITR_SNAPSHOT_RETENTION_SECS, policy.pitr_snapshot_secs?)
    prune branch manifests (unchanged mechanics: floor snapshot kept,
    named checkpoints pin, child forks carry their own refs)
  → dereferenced objects fall to the next refcount-GC pass
```

**Memory aging** — rides the writer-side expiry sweep: one atomic batch per database deletes
superseded rows past age/count caps and events past max age — FTS rows, vector rows, and base
rows together — bounded per pass (the deletes are writes and ship segments). Cold databases are
swept when they next become hot on their owner; their object-storage footprint is still bounded
by the retention pass above.

**AI egress** — three checkpoints:
- `POST .../extract` and `POST .../ask` check the policy first thing: these endpoints exist to
  call the model, so a denial is a deterministic **403** (`ai_egress.extract = deny for
  namespace 'acme'`), and recall cost is never paid for a denied ask.
- Auto-embedding (ingest items, recall/ask queries) checks at the embed call site — the owner
  node on a forwarded write, where the bytes would actually leave — and a denial **skips
  silently**, exactly like an unconfigured embedder: the write succeeds, keyword/topic recall
  still works, no vectors exist. `self_hosted_only` consults the embedder's startup-computed
  provenance (`MEMOTURN_EMBED_BASE_URL` host: loopback, RFC1918/link-local, `.svc.cluster.local`
  / `.internal`, dot-less service names, or the `MEMOTURN_EMBED_SELF_HOSTED_HOSTS` allowlist).
- Failure posture is split: egress checks **fail closed** (policy never loadable → 503), TTL
  clamps and retention **fail open, loudly** — governance must not join the write path's
  failure domain, but a compliance gate must not fail open.

## Guarantees and bounds (state these, don't pretend immediacy)

- Policy changes take effect on the serving node immediately, cluster-wide within the cache TTL
  (default ≤ 30 s).
- Retention and memory-age enforcement run on the maintenance cadence (≤ 30 s for sweeps,
  ≤ ~10 min for PITR pruning + GC).
- TTL clamping is exact at ingest; pre-existing rows are governed by the sweeps.

## Phased: audit logging and verifiable erasure

Both are fully designed in [ADR-0010](../adr/0010-data-governance.md); the policy document
already carries their sections so enabling them is additive.

**Audit (phase 2):** per-namespace append-only JSONL streams in object storage — outside
PITR/branching so a rewind can never erase the trail — with non-blocking emission off the hot
path, AI-egress metadata (provider, model, byte counts; never payload content), denials always
recorded, platform-key read API and CLI export, and reserved hash-chaining for tamper evidence.

**Verifiable erasure (phase 3):** erasure coupons that hard-forget at txid `T` (with
`secure_delete` page zeroing), then force a post-`T` snapshot, prune all history below `T`
(a prefix drop below a snapshot base — manifest chains never splice), let GC reclaim, verify
absence by listing txid-named objects, and finish with a signed Ed25519 erasure receipt. Bounded
completion: `grace + tick + GC grace`. Four honest caveats, surfaced rather than papered over:
named checkpoints below `T` block (delete the checkpoint to proceed), pre-`T` forks hold the
datum as *live content* and are reported in `blocked_by`, replica caches converge within the
stream/eviction window (the receipt's claim is scoped to object storage, the source of truth),
and local-disk scrubbing of evicted cache files is future work. Crypto-shredding arrives with
per-tenant encryption (ADR-0008's enterprise phase) as the fast path.

## Operator surface

```
MEMOTURN_POLICY_CACHE_SECS          policy read-cache TTL (default 30)
MEMOTURN_EMBED_SELF_HOSTED_HOSTS    comma-separated hosts to treat as self-hosted

memoturn policy get <ns> [--profile p]        # ns: platform key; profile: token
memoturn policy set <ns> [--profile p] [--file policy.json]   # JSON via --file or stdin
memoturn policy clear <ns> --profile p
```
