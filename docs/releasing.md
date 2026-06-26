# Releasing

memoturn ships three distributables on a version tag: the **JS SDK** (`@memoturn/sdk` → npm),
the **Python SDK** (`memoturn` → PyPI), and **container images** (api / worker / console → GHCR).
All three are built and published by [`.github/workflows/release.yml`](../.github/workflows/release.yml),
triggered by pushing a `v*` tag (or run manually via *workflow_dispatch*).

## One-time setup

Both SDK registries use **Trusted Publishing** (OIDC) — **no secrets to manage**. Register
the trusted publisher once on each, pointing at this repo + `release.yml`:

- **npm** — npmjs.com → `@memoturn/sdk` → **Settings → Trusted Publisher** → GitHub Actions,
  owner `memoturn`, repo `memoturn`, workflow `release.yml`.
- **PyPI** — PyPI → your account → **Publishing → Add a pending publisher**: project `memoturn`,
  owner `memoturn`, repository `memoturn`, workflow `release.yml`, environment *(blank)*.
- **GHCR** — `GITHUB_TOKEN` is provided automatically (the `images` job requests `packages: write`).

The `npm` and `pypi` jobs request `id-token: write`; npm additionally attaches **provenance**.

> **First publish of a new package** is the exception: a trusted publisher can only be
> configured on a package/project that already exists (npm) — and an npm account/org that
> enforces 2FA-on-publish will reject any token from CI with `EOTP`. So bootstrap a brand-new
> npm package once from a maintainer's machine (`npm publish --access public --otp=<code>`),
> then add the trusted publisher; every release after that is tokenless via CI. PyPI supports
> pre-registering a pending publisher, so it needs no bootstrap.

## Validate first (dry run)

Before tagging, run the workflow from the **Actions → Release → Run workflow** menu with
**Dry run** checked. It exercises the pipeline without publishing: `npm publish --dry-run`,
`uv build`, and all three images built but **not** pushed. (Trusted Publishing itself can only
be exercised by a real publish, so a green dry run confirms the builds, not the OIDC handshake.)

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
