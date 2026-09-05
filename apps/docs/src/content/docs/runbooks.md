---
title: Runbooks
description: Operator procedures for restore, replay, DLQ, Doris FE, disk, key rotation, erasure, drain, certs, and session-revocation lag.
---

Operator procedures for the situations that matter at 3 a.m. Each one names the symptom, the
commands, and how to verify the outcome. All commands assume the single-VM compose stack
(`infra/docker-compose.prod.yml`) unless noted; Helm equivalents are `kubectl exec` into the
api/worker pods with the same scripts (they ship in the api image).

## Restore from backup

**When:** a datastore volume is lost or corrupt, a bad migration, an operator mistake.

1. Pick the backup: `ls -lt backups/` — the timestamp is shared by `pg-<ts>.dump`,
   `redis-<ts>.rdb`, and `blob-<ts>/`.
2. `bash scripts/restore.sh <ts>` — stops api + worker, restores Postgres (`pg_restore --clean`),
   Redis (RDB), and the blob bucket, starts the worker, replays every raw batch from blob
   through the ingest queue (this rebuilds Doris / the Postgres tier), then starts the api.
   Add `--no-replay` to skip the rebuild if only Postgres needed restoring.
3. Verify: the console loads and shows recent traces; `bun run dlq` is empty (a non-empty DLQ
   lists batches that failed to re-apply — fix the cause, then `bun run dlq --replay`); the
   worker's `/metrics` shows `ingest` queue `waiting` draining to 0.

**Drill it** on a staging copy before you need it, and note the wall-clock time: that is your
RTO. RPO is the backup interval.

## Rebuild or backfill the telemetry store from blob

**When:** Doris lost a BE (replication 1), an engine move (`telemetry:migrate`) needs a
re-materialization, or a project must be loaded into a fresh store.

- Whole instance: `bun run replay -- --all` (optionally `--from YYYY-MM-DD`).
- One project: `bun run replay -- --project <id> --from … --to …`; `--dry-run` sizes it.
- Replays are idempotent (last-writer-wins by `event_ts`) and skip usage metering + online
  evaluators. Watch the ingest queue drain and the DLQ.

## Ingest is failing / DLQ is growing

**Symptom:** `ingest job failed` / `DLQ depth above threshold` in the worker log; the console's
Ingest health page shows a rising DLQ depth; `/v1/ingest/health` `dlqDepth` climbing.

1. `bun run dlq` — the most recent failures show the error string. Common causes: the
   telemetry store is down or out of memory (`MEM_ALLOC_FAILED` on Doris → raise
   `DORIS_BE_MEM_LIMIT`), a schema migration didn't run (`bun run db:telemetry`), blob store
   unreachable.
2. Fix the cause, then `bun run dlq --replay` (or the console button). A replay is serialized
   by a lock — a 409 means one is already running.
3. Batches whose blob object is missing or malformed dead-letter on the first attempt with an
   `unrecoverable:` error — those cannot be replayed; the client must re-send.

## Doris FE won't start / no master elected

**Symptom:** `doris-fe` restarts, api/worker `waiting for doris`, FE log mentions BDBJE or
`no master`.

The single-FE stack keeps its election metadata on the static-IP `doris` network so a
container restart keeps the same address (see the compose comments). If the FE still won't
elect: `docker compose stop doris-fe doris-be && docker compose up -d doris-fe`, wait for
`curl -sf http://<fe>:8030/api/bootstrap`, then start the BE. If FE metadata is gone
(`dorisfemeta` volume lost), recreate the schema (`bun run db:telemetry`) and rebuild from
blob (above) — Doris data is never the only copy.

## Disk is full

1. Find the consumer: `docker system df`, `du -sh /var/lib/docker/volumes/*`.
2. Container logs are rotated by the compose stack (`LOG_MAX_SIZE`/`LOG_MAX_FILES`); if a
   volume is the problem, apply/lower retention (`POST /v1/retention` or
   `TELEMETRY_MAX_RETENTION_DAYS`) and run `POST /v1/retention/apply`, then compact Doris
   (`ALTER TABLE … COMPACT` is automatic; give it time) or `VACUUM` the Postgres tier.
3. Blob growth: retention sweeps `events/`, `payloads/`, `media/` per project; nothing else
   deletes them.

## Rotate `ENCRYPTION_KEY`

Secrets at rest (provider keys, automation secrets, analytics-sink keys, webhook signing
secrets) are encrypted under a key ring; rotation never loses anything:

1. `ENCRYPTION_KEYS="<new>,<old>"` on api + worker (first = active), restart. Existing
   ciphertexts still open with `<old>`; anything written from now on uses `<new>`.
2. `bun run rotate-secrets` (add `--dry-run` first) — rewrites every stored secret under
   `<new>`; rows it cannot open with any key in the ring are listed and left alone (the owner
   must re-enter those).
3. `ENCRYPTION_KEYS="<new>"` (or `ENCRYPTION_KEY=<new>`), restart, destroy `<old>`.

Pre-v2 ciphertexts (SHA-256-derived) are also rewritten by step 2.

## Right to erasure

- One trace: `DELETE /v1/traces/{id}` (write role).
- Everything one end user of your application generated: `DELETE /v1/users/{userId}/data`
  (admin role). Both remove telemetry rows in every table, the Postgres state mirror, and the
  offloaded payload objects. The raw event batches are multi-trace and are governed by
  retention: set a retention window on the project so the batches age out, and know that a
  blob replay before they do would re-materialize the trace.

## Drain a worker for maintenance

`docker compose stop worker` sends SIGTERM; the worker finishes in-flight jobs for up to
`WORKER_SHUTDOWN_TIMEOUT_MS` (compose `stop_grace_period` 600 s) before exiting. Ingest keeps
being accepted by the api (207) and buffers in Redis + blob. On Kubernetes the same happens on
a rolling update (`terminationGracePeriodSeconds`).

## Certificate renewal failed (Caddy)

Caddy renews Let's Encrypt certs automatically. If `https://DOMAIN` serves an expired cert:
`docker compose logs caddy | grep -i acme` — the usual cause is port 80 closed or DNS moved.
Fix, then `docker compose restart caddy`. Caddy caches an ACME failure against a stale IP —
restart it after any DNS change.

## Session revocation lag

Sessions are cookie-cached for up to 5 minutes (`AUTH_COOKIE_CACHE_MAX_AGE`). Banning a user
or revoking sessions takes effect on their next uncached request — within 5 minutes. Role
changes are not delayed. For an immediate cut-off, rotate `BETTER_AUTH_SECRET` (signs every
session out) or set `AUTH_COOKIE_CACHE_DISABLED=1`.
