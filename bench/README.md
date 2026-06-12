# bench/

`make bench` (= `cargo run --release -p memoturn-bench`) reproduces the performance table in
the root README; `scripts/bench-http.py` measures the same operations over HTTP.

Conventions:

- Raw runs go to `bench/results/` (gitignored) — this directory tracks no data.
- The README numbers are only ever updated by re-running the harness and pasting its output —
  never hand-edited. Re-run on comparable hardware to the previous run, or refresh the whole
  table.
- No CI bench job on purpose: shared-runner numbers are noise. If regression tracking is ever
  wanted, it should be a `workflow_dispatch` job on fixed hardware.
