# Examples

Runnable use-case demos that double as the e2e suite: `make demos` runs them all, spawning a
throwaway node if none answers at `MEMOTURN_URL`. Each runs without an LLM key; set
`ANTHROPIC_API_KEY` to exercise the LLM layers too. One-time setup: `make venv`.

| demo | what it shows | docs |
| --- | --- | --- |
| [`memory-agent/`](memory-agent/) | The product loop as an interactive chat agent — recall → answer → extract → checkpoint/rewind, with `/remember`, `/checkpoint`, `/rewind` commands. Scriptable for e2e (`agent.py ... < script.txt`). | [quickstart](https://docs.memoturn.ai/quickstart/), [recall](https://docs.memoturn.ai/recall/), [ask](https://docs.memoturn.ai/ask/) |
| [`support-agent/`](support-agent/) | Customer support over a shared profile: ticket status as supersession — the current truth wins, history stays inspectable. | [typed memories](https://docs.memoturn.ai/memories/) |
| [`multi-agent/`](multi-agent/) | Two agents, one profile: shared memory with per-agent `source` provenance and source-filtered recall. | [profiles](https://docs.memoturn.ai/profiles/) |
| [`what-if/`](what-if/) | Burner-branch speculation: fork the memory, run a risky timeline, compare against main, let the branch expire. | [branching](https://docs.memoturn.ai/branching/), [PITR](https://docs.memoturn.ai/pitr/) |
| [`governance/`](governance/) | Policies, the audit stream, and a verifiable-erasure coupon with its signed receipt. | [security](https://docs.memoturn.ai/security/) |

`run_e2e.py` is the runner: each demo is executed as a subprocess with assertions, against a
shared temp node (debug build, random port, `MEMOTURN_SINGLE_NODE=1`) or whatever node is
already up at `MEMOTURN_URL`.
