# multi-agent

Two agents, one mind. A researcher agent and a writer agent share a single
memory profile (`{ns}/apollo` — one database), each writing memories under its
own `source`. Both recall everything, can filter recall by who learned it,
and a supersession by one agent is the other's truth on the next read. The
raw transcript layer doubles as a shared session log.

```bash
cargo run -p memoturnd                      # terminal 1 (or any node)
python3 examples/multi-agent/demo.py        # terminal 2
```

The demo narrates and asserts each step (exit 1 on failure) — `make demos`
runs it as part of the examples e2e suite. With `ANTHROPIC_API_KEY` set, the
writer also drafts a sentence grounded in the shared memory. Needs `httpx`
(`pip install -r examples/requirements.txt`).
