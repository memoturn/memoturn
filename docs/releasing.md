# Releasing

memoturn ships three distributables on a version tag: the **JS SDK** (`@memoturn/sdk` → npm),
the **Python SDK** (`memoturn` → PyPI), and **container images** (api / worker / console → GHCR).
All three are built and published by [`.github/workflows/release.yml`](../.github/workflows/release.yml),
triggered by pushing a `v*` tag (or run manually via *workflow_dispatch*).

## One-time setup

**npm** — add one repository secret (Settings → Secrets and variables → Actions):

| Secret | Used by | How to get it |
| --- | --- | --- |
| `NPM_TOKEN` | npm publish | npm → Access Tokens → **Granular** token, read+write, scoped to `@memoturn` |

**PyPI** — uses **Trusted Publishing** (OIDC), so there is *no* secret to manage. Register a
pending publisher once at PyPI → your account → **Publishing → Add a pending publisher**:

- PyPI Project Name: `memoturn` · Owner: `memoturn` · Repository: `memoturn`
- Workflow name: `release.yml` · Environment: *(blank)*

**GHCR** — `GITHUB_TOKEN` is provided automatically (the `images` job requests `packages: write`).

The `npm` and `pypi` jobs request `id-token: write` — for npm **provenance** and PyPI Trusted
Publishing respectively (both via GitHub's OIDC).

## Validate first (dry run)

Before tagging, run the workflow from the **Actions → Release → Run workflow** menu with
**Dry run** checked. It exercises the whole pipeline without publishing: `npm whoami` +
`npm publish --dry-run` (confirms the token + tarball), `uv build`, and all three images built
but **not** pushed. A green dry run means the real tag is safe.

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
   - **pypi** — `uv build` (wheel + sdist) → `uv publish --trusted-publishing always`.
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
