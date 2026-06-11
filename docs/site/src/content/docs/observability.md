---
title: Observability
description: SLO targets, what the Helm chart ships for metrics and dashboards, measured prototype numbers, and how to reproduce the benchmarks.
---

Memoturn's operability contract is a small set of latency SLOs plus one queue-depth signal
(segment-shipping backlog). This page lists the targets, what the deployment ships to watch them,
and the measured numbers behind them.

## SLO targets

The targets the architecture is designed and dashboarded against:

| SLO | Target |
| --- | --- |
| provision latency p50 | < 100 ms (target ~10 ms) |
| cold-wake p50 / p99 (≤16 MB) | < 200 ms / < 1 s |
| hot KV read p50 | < 1 ms |
| SQL / document write p50 | < 5 ms |
| branch create/rewind p50 | < 50 ms |
| replication lag p99 (in-region) | < 1 s |
| lease failover (kill → writes resume) | < 15 s |
| segment-shipping backlog | ~0 sustained |

Segment-shipping backlog is the one to alarm on: sustained backlog means object storage is not
keeping up, which widens the Standard-durability RPO window (see [Architecture](/architecture/)).
Durable-mode writes — `MEMOTURN_DURABILITY=durable`, or the per-request `Memoturn-Durability`
header — are immune to backlog by construction: they ack only after the ship completes.

## What the deployment ships

The Helm deployment design includes an optional observability subchart: kube-prometheus-stack, an
OpenTelemetry collector, and Grafana dashboards with the SLO panel above. The current prototype
chart ships the data plane and MinIO; the observability subchart lands with the full cell
(gateway, control API, etcd) — see [Deployment](/deployment/) and the [Roadmap](/roadmap/).

Available today on every node:

- **Structured logs** via `tracing`, filtered with `RUST_LOG` (default
  `memoturnd=info,memoturn_api=info,memoturn_replication=info`).
- **`/healthz`** — the readiness probe the chart wires up.
- **`txid` on every read response** — replication lag is directly observable from the client
  side by comparing writer and replica txids (see [Consistency](/consistency/)).
- **Request-surface guardrails** — body cap (`413`), request timeout, global concurrency cap,
  and a control-endpoint rate limit (`429`), all tunable per node — see
  [Configuration](/configuration/#request-limits--durability).

## Measured: prototype, single node

Measured, not promised — reference points from the working prototype (in-process object store,
so these are engine costs without network):

| Metric | Target | p50 |
| --- | --- | --- |
| memory ingest (typed fact, 256-dim embedding, supersession) | <10 ms | 3.9 ms |
| hybrid recall over 10k memories (FTS5 + topic + ANN, rank-fused) | <25 ms | 11.7 ms |
| provision database | <100 ms | 17 µs |
| hot KV read / SQL write / doc insert | <1 ms / <5 ms / <5 ms | 3 µs / 16 µs / 15 µs |
| segment ship (write + WAL capture + PUT) | <10 ms | 61 µs |
| branch create (copy-on-write) | <50 ms | 47 µs |
| cold wake (restore + open + query) | <200 ms | 0.7 ms (+object-store RTT in prod) |
| 10k databases provisioned | — | 93 ms (107k/s), hot pool flat |

## Measured: full stack on Kubernetes

The same operations through a real cell — kind, Helm chart, auth on, MinIO as the object store,
measured through `kubectl port-forward` (which sets a ~1.6 ms network floor):

| Metric | p50 | p99 |
| --- | --- | --- |
| memory ingest (typed fact, namespace token) | 2.81 ms | 7.53 ms |
| hybrid recall @1k memories | 4.08 ms | 5.97 ms |
| provision database | 1.61 ms | 3.43 ms |
| hot SQL write | 1.59 ms | 2.83 ms |
| hot KV write / read | 1.66 / 1.63 ms | 3.53 / 2.94 ms |
| branch create (copy-on-write) | 3.01 ms | 3.69 ms |
| write + segment ship (to MinIO) | 6.54 ms | 8.67 ms |

The segment-ship row reflects a real object-storage PUT round-trip. On cloud object storage,
expect cold wake and segment ship to gain same-region RTTs (~10–40 ms) — still inside targets.

## Reproducing the numbers

```bash
# the benchmark harness behind the prototype table
cargo run --release -p memoturn-bench

# the end-to-end agent-story walkthrough against a running node
scripts/demo.sh
```

For the Kubernetes numbers, deploy the chart per [Deployment](/deployment/) and run the HTTP
benchmark against the forwarded service:

```bash
python3 scripts/bench-http.py http://127.0.0.1:8080 --platform-key ... --n 200
```

Sources: the README and `docs/deployment-proof.md` in the
[repository](https://github.com/memoturn/memoturn).
