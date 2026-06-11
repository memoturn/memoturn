#!/usr/bin/env python3
"""HTTP-level benchmark against a deployed Memoturn node/service.

Measures full request latency (network + auth + engine) — the numbers a
client actually experiences, unlike the in-process engine bench.

Usage:
  bench-http.py [base-url] [--platform-key K] [--n 200]
"""
import argparse
import json
import statistics
import time
import urllib.request


def req(method, url, body=None, token=None, raw=False):
    data = body if raw else (json.dumps(body).encode() if body is not None else None)
    r = urllib.request.Request(url, data=data, method=method)
    if not raw and body is not None:
        r.add_header("content-type", "application/json")
    if token:
        r.add_header("authorization", f"Bearer {token}")
    with urllib.request.urlopen(r) as resp:
        return resp.status, resp.read()


def timed(n, fn):
    samples = []
    for i in range(n):
        t0 = time.perf_counter()
        fn(i)
        samples.append((time.perf_counter() - t0) * 1000)
    samples.sort()
    return samples[len(samples) // 2], samples[int((len(samples) - 1) * 0.99)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("base", nargs="?", default="http://127.0.0.1:8080")
    ap.add_argument("--platform-key", default=None)
    ap.add_argument("--n", type=int, default=200)
    args = ap.parse_args()
    base, pk, n = args.base.rstrip("/"), args.platform_key, args.n
    run = str(int(time.time()))

    rows = []

    def row(name, target_ms, p50, p99):
        rows.append((name, target_ms, p50, p99))

    # Provision
    p50, p99 = timed(
        min(n, 100),
        lambda i: req("POST", f"{base}/v1/databases", {"name": f"bench-{run}-{i}"}, pk),
    )
    row("provision database", 100, p50, p99)

    db = f"bench-{run}-0"
    token = pk
    if pk:
        _, body = req(
            "POST", f"{base}/v1/databases/{db}/tokens", {"scope": "admin"}, pk
        )
        token = json.loads(body)["token"]

    # SQL write
    req("POST", f"{base}/v1/db/{db}/sql",
        {"stmts": [{"q": "CREATE TABLE t (n INTEGER)"}]}, token)
    p50, p99 = timed(n, lambda i: req(
        "POST", f"{base}/v1/db/{db}/sql",
        {"stmts": [{"q": "INSERT INTO t VALUES (?)", "params": [i]}]}, token))
    row("hot SQL write", 10, p50, p99)

    # KV put / get
    p50, p99 = timed(n, lambda i: req(
        "PUT", f"{base}/v1/db/{db}/kv/s/k{i % 50}", f"v{i}".encode(), token, raw=True))
    row("hot KV write", 10, p50, p99)
    p50, p99 = timed(n, lambda i: req(
        "GET", f"{base}/v1/db/{db}/kv/s/k{i % 50}", None, token))
    row("hot KV read", 5, p50, p99)

    # Docs
    p50, p99 = timed(n, lambda i: req(
        "POST", f"{base}/v1/db/{db}/docs/m/insert",
        {"docs": [{"kind": "fact", "n": i}]}, token))
    row("hot doc insert", 10, p50, p99)
    p50, p99 = timed(n, lambda i: req(
        "POST", f"{base}/v1/db/{db}/docs/m/find", {"filter": {"n": i % 100}}, token))
    row("doc find", 10, p50, p99)

    # Branch create (CoW; includes ship of dirty parent)
    p50, p99 = timed(min(n, 50), lambda i: req(
        "POST", f"{base}/v1/db/{db}/branches", {"name": f"b{run}-{i}"}, token))
    row("branch create (CoW)", 100, p50, p99)

    # Sync (segment ship to object storage)
    def sync_iter(i):
        req("POST", f"{base}/v1/db/{db}/sql",
            {"stmts": [{"q": "INSERT INTO t VALUES (?)", "params": [i]}]}, token)
        req("POST", f"{base}/v1/db/{db}/sync", {}, token)
    p50, p99 = timed(min(n, 50), sync_iter)
    row("write + segment ship", 50, p50, p99)

    # Agent memory (the headline): typed ingest + hybrid recall.
    ns, prof = f"bench{run}", "alice"
    mtoken = pk
    if pk:
        _, body = req("POST", f"{base}/v1/namespaces/{ns}/tokens",
                      {"scope": "admin"}, pk)
        mtoken = json.loads(body)["token"]
    words = ["refund", "seat", "deploy", "invoice", "theme",
             "flight", "ticket", "billing", "release", "policy"]

    def emb(seed, dim=64):
        x = seed * 2654435761 + 1
        out = []
        for _ in range(dim):
            x = (x * 6364136223846793005 + 1442695040888963407) % (1 << 64)
            out.append((x >> 33) / float(1 << 32) - 0.5)
        return out

    # Seed 1k memories so recall exercises real channels through the stack.
    for batch in range(10):
        req("POST", f"{base}/v1/memory/{ns}/{prof}/memories", {"memories": [
            {"type": "event",
             "summary": f"{words[i % 10]} update number {i}",
             "content": {"n": i},
             "keywords": f"{words[i % 10]} {words[(i // 10) % 10]}",
             "embedding": emb(i)}
            for i in range(batch * 100, batch * 100 + 100)]}, mtoken)

    p50, p99 = timed(n, lambda i: req(
        "POST", f"{base}/v1/memory/{ns}/{prof}/memories", {"memories": [
            {"type": "fact", "topic_key": f"user.topic-{i % 50}",
             "summary": f"{words[i % 10]} preference v{i}",
             "content": {"v": i}, "keywords": "preference",
             "embedding": emb(10_000 + i)}]}, mtoken))
    row("memory ingest (typed fact)", 25, p50, p99)

    p50, p99 = timed(n, lambda i: req(
        "POST", f"{base}/v1/memory/{ns}/{prof}/recall",
        {"query": f"{words[i % 10]} policy update", "embedding": emb(i * 7 + 3),
         "topic_key": f"user.topic-{i % 50}", "k": 8}, mtoken))
    row("hybrid recall @1k memories", 50, p50, p99)

    print(f"\nMemoturn HTTP benchmarks against {base}\n")
    print(f"| {'metric':<26} | {'target':>8} | {'p50':>9} | {'p99':>9} | {'':>4} |")
    print(f"|{'-'*28}|{'-'*10}|{'-'*11}|{'-'*11}|{'-'*6}|")
    for name, target, p50, p99 in rows:
        ok = "PASS" if p50 < target else "FAIL"
        print(f"| {name:<26} | {f'<{target}ms':>8} | {p50:8.2f}ms | {p99:8.2f}ms | {ok:>4} |")
    print()


if __name__ == "__main__":
    main()
