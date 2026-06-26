# Releasing

memoturn ships three distributables on a version tag: the **JS SDK** (`@memoturn/sdk` → npm),
the **Python SDK** (`memoturn` → PyPI), and **container images** (api / worker / console → GHCR).
All three are built and published by [`.github/workflows/release.yml`](../.github/workflows/release.yml),
triggered by pushing a `v*` tag (or run manually via *workflow_dispatch*).

## One-time setup

Add these repository secrets (Settings → Secrets and variables → Actions):

| Secret | Used by | How to get it |
| --- | --- | --- |
| `NPM_TOKEN` | npm publish | npm → Access Tokens → **Automation** token for the `@memoturn` scope |
| `PYPI_TOKEN` | PyPI publish | PyPI → Account → API tokens (scope it to the `memoturn` project) |

`GITHUB_TOKEN` is provided automatically and is what pushes images to GHCR (the `images` job
requests `packages: write`). The npm job requests `id-token: write` so npm **provenance** is
attached to the published package.

## Cut a release

1. Bump the version in all three manifests so they stay in lockstep:
   - `sdks/js/package.json` → `version`
   - `sdks/python/pyproject.toml` → `[project].version`
   - (optional) root `package.json` → `version`
2. Commit, then tag and push:
   ```bash
   git tag v0.2.0
   git push origin v0.2.0
   ```
3. The workflow runs three independent jobs:
   - **npm** — `bun install` → `bun --filter @memoturn/sdk build` → flatten `publishConfig`
     into the manifest (points `main`/`types`/`exports` at `dist/`) → `npm publish --provenance`.
   - **pypi** — `uv build` (wheel + sdist) → `uv publish`.
   - **images** — matrix over `api` / `worker` / `console`: build each
     `docker/<svc>.Dockerfile` and push to `ghcr.io/memoturn/<svc>` tagged
     `{version}`, `{major}.{minor}`, and `latest`.

## How the SDK entrypoints work

For local development every workspace package resolves through its TypeScript source
(`main`/`types` → `./src/index.ts`) — no build step. For the **published** npm package those
fields must point at compiled JS. The dist mapping lives in `publishConfig` in
`sdks/js/package.json`; the release workflow flattens it into the top-level manifest right
before `npm publish`, so the tarball ships `dist/*.js` + `.d.ts` while local dev stays
build-free. The Python SDK is stdlib-only, so `uv build` packages the source directly.

## Verifying a release locally

```bash
# JS: inspect the exact tarball npm would publish
cd sdks/js && bun run build && npm pack --dry-run

# Python: build the wheel + sdist
cd sdks/python && uv build && ls dist
```
