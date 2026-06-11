---
title: Namespaces & profiles
description: The namespace > profile > memory hierarchy, structural isolation, auto-creation, and profile lifecycle.
---

Memoturn organizes memory in a two-level hierarchy:

```
namespace                an application, environment, or tenant
  └── profile            one memory store: a user, a team, an org, an agent persona
        └── memory       a typed record (fact / event / instruction / task)
```

Every agent acting for the same user reads and writes the same profile. "Memory shared across all
of a user's agents" is not a synchronization feature — it is the absence of one: the agents are
clients of one store.

## Profile = one database

A profile is one Memoturn database, named `{namespace}--{profile}` by convention (profile `alice`
in namespace `acme` is the database `acme--alice`).

Isolation is therefore **structural**, not policy-based. Recall on `acme--alice` can never surface
`acme--bob`'s memories, because they are different database files with different manifests and
writer leases. There is no data-plane operation that touches two profiles; tokens widen
authorization only. See [Architecture](/architecture/) for the substrate and [Security](/security/)
for the token model.

Because a profile is a database, everything a database can do applies to a profile verbatim:
checkpoint before a risky run, rewind, or fork a burner branch — see [Branching](/branching/).

## Choosing profile boundaries

| Profile per | Use |
| --- | --- |
| User | the common case: every agent serving this user shares one memory |
| Team / org | shared knowledge across a group's agents |
| Agent persona | a long-lived agent identity with its own accumulated memory |

The namespace groups profiles by application, environment, or tenant — `acme`, `acme-staging`,
and `acme-prod` are separate namespaces with separate profiles. A namespace-scoped token covers
every profile under it (the orchestrator posture); a per-database token covers exactly one
profile (the agent posture).

## Auto-creation

Profiles are created implicitly on first ingest:

```bash
curl -X POST http://localhost:8080/v1/memory/acme/alice/memories \
  -H 'content-type: application/json' \
  -d '{"memories": [{"type": "fact", "topic_key": "user.diet",
       "summary": "vegetarian since 2024", "content": {"diet": "vegetarian"}}]}'
```

If `acme--alice` does not exist, this request creates it. Provisioning is a metadata write — a
catalog row and an empty branch manifest, no file I/O — measured at **17 µs p50** on the
prototype. The database file materializes lazily on first write.

Reads never create. Recall against a profile that does not exist returns an empty result:

```json
{ "memories": [], "txid": 0 }
```

## Listing profiles

```bash
curl http://localhost:8080/v1/memory/acme
```

Lists the profiles in namespace `acme`. Requires a namespace-scoped token when auth is enabled.

## Lifecycle and cost

Profiles move through temperature tiers automatically:

- **Active** profiles are open libSQL handles (hot) or files on local NVMe (warm).
- **Idle** profiles hibernate to object storage (cold) — zero node cost; an idle profile costs
  object-storage cents.
- A cold profile wakes on the next request: restore from object storage, open, serve. Measured
  **0.7 ms p50** on the prototype, plus object-store round-trip in production.

This is what makes profile-per-user viable at fleet scale: millions of profiles where most are
asleep at any moment, none of them holding node resources.

## Sessions

Sessions are optional groupings *inside* a profile — different profiles may reuse session IDs.
Task memories attach to sessions and expire with them; sessions also index the raw transcript
layer. See [Sessions](/sessions/).

## Related

- [Typed memories](/memories/) — the record schema, supersession, ingest
- [Hybrid recall](/recall/) — querying a profile
- [Branching](/branching/) — checkpoint, rewind, and burner-branch a profile
- [API reference](/api-rest/) — the full route list
