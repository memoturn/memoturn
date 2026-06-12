# support-agent

A customer support agent on Memoturn memory: **one namespace per company, one
profile per customer**. The agent knows the customer's plan and environment
before a ticket opens, tracks the ticket as a `task` plus a status `fact`, and
when the ticket resolves the new status **supersedes** the old one — recall
shows only the current truth while the full chain stays queryable. Ending the
ticket session expires its tasks, and each customer's profile is its own
database, so nothing leaks between customers.

```bash
cargo run -p memoturnd                       # terminal 1 (or any node)
python3 examples/support-agent/demo.py       # terminal 2
```

The demo narrates each step and asserts the outcomes (exit 1 on failure), so
it doubles as an e2e check — `make demos` runs it that way. With
`ANTHROPIC_API_KEY` set it also answers a customer question grounded in the
recalled memories. Needs `httpx` (`pip install -r examples/requirements.txt`).
