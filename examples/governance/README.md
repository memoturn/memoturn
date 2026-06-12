# governance

The compliance story (ADR-0010) end to end: set a namespace policy (audit on,
erasure grace window, TTL caps), watch the **tighten-only** rule reject a
loosening profile override with 409, ingest a sensitive fact, then **erase**
it — gone from recall immediately via a secure-delete hard forget, with a
coupon promising a bounded-time object-storage history rewrite proven by a
signed Ed25519 receipt. Finally, export the namespace **audit stream**: every
step is recorded as metadata only, never memory content.

```bash
cargo run -p memoturnd                     # terminal 1 (or any node)
python3 examples/governance/demo.py        # terminal 2
```

The demo narrates and asserts each step (exit 1 on failure) — `make demos`
runs it as part of the examples e2e suite. Notes:

- The erasure grace window has an enforced 60s minimum, and the history
  rewrite runs on the node's ~10-minute maintenance tick — on a fresh node the
  coupon is asserted as `pending`; against a long-lived node you'll see it
  reach `completed` with the receipt.
- Auth-off dev nodes produce explicitly **unsigned** receipts (`alg: "none"`).
  With `MEMOTURN_AUTH=on` the receipt is Ed25519-signed; verifying it offline
  requires the operator-held cluster public key (not yet exposed via any
  endpoint or CLI).
- With auth on, export `MEMOTURN_PLATFORM_KEY` for the policy/audit calls.

Needs `httpx` (`pip install -r examples/requirements.txt`).
