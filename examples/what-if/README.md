# what-if

Burner-branch speculation. A profile is one database, so `fork()` gives you a
copy-on-write branch of the agent's **entire mind** in O(1). The strategist
forks a `what-if` burner branch, supersedes its pricing belief there, lets
simulated consequences accumulate, compares the two timelines, and deletes the
branch — main never learns any of it.

```bash
cargo run -p memoturnd                   # terminal 1 (or any node)
python3 examples/what-if/demo.py         # terminal 2
```

The demo narrates and asserts each step (exit 1 on failure) — `make demos`
runs it as part of the examples e2e suite. With `ANTHROPIC_API_KEY` set,
Claude also writes the what-if memo comparing the timelines. Needs `httpx`
(`pip install -r examples/requirements.txt`).
