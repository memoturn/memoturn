# memoturn eval-gate action

Fail a CI job when a memoturn dataset run's evaluator scores regress past thresholds —
the release-blocking half of the eval loop.

Your pipeline runs a task over a dataset, records a **run** (linking items → traces) via
the SDK, and the evaluators attached to those traces produce scores. This action gates the
job on those scores.

## Usage

```yaml
- name: Eval gate
  uses: memoturn/memoturn/integrations/github-actions/eval-gate@main
  with:
    base-url: https://api.memoturn.example
    public-key: ${{ secrets.MEMOTURN_PUBLIC_KEY }}
    secret-key: ${{ secrets.MEMOTURN_SECRET_KEY }}
    dataset: qa-regression
    run: pr-${{ github.event.number }}
    thresholds: |
      {"faithfulness": {"min": 0.8}, "toxicity": {"max": 0.1}}
```

Gate on regression versus a baseline run instead of absolute bounds:

```yaml
    baseline-run: main
    thresholds: |
      {"faithfulness": {"maxRegression": 0.05}}
```

## Inputs

| Input | Required | Description |
| --- | --- | --- |
| `base-url` | no | API base URL (default `http://localhost:3001`). |
| `public-key` / `secret-key` | yes | API key pair — use repo secrets. |
| `dataset` | yes | Dataset name. |
| `run` | yes | Run name to gate. |
| `thresholds` | yes | JSON `{ scoreName: { min?, max?, maxRegression? } }`. |
| `baseline-run` | no | Baseline run for `maxRegression` bounds. |

## Outputs

- `passed` — `"true"` if the run met all thresholds. The step also exits non-zero on
  failure (failing the job) and writes a summary table to the job summary.

A gated score the run never produced counts as a failure (`missing_score`) — you can't
prove quality you didn't measure.
