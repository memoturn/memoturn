# Security Policy

## Supported versions

memoturn is pre-1.0 and under active development. Security fixes land on `main` and ship in
the next release. Please run a recent version before reporting.

## Reporting a vulnerability

**Do not open a public issue for security problems.**

Report privately via GitHub's [private vulnerability reporting](https://github.com/memoturn/memoturn/security/advisories/new)
(the repository's **Security → Report a vulnerability** tab). If that is unavailable, contact a
maintainer directly through GitHub.

Please include:

- A description of the issue and its impact.
- Steps to reproduce (a proof of concept if possible).
- Affected component(s) — API, worker, console, an SDK, or the deployment artifacts.
- Any suggested remediation.

## What to expect

- **Acknowledgement** within 3 business days.
- An initial assessment and severity triage shortly after.
- Coordinated disclosure: we will agree on a timeline before any public detail is shared, and
  credit you in the advisory unless you prefer to remain anonymous.

## Scope

In scope: the memoturn API, worker, console, SDKs (`@memoturn/sdk`, `memoturn`), and the
self-host artifacts (Docker images, Helm chart). Out of scope: vulnerabilities in third-party
dependencies (report those upstream; we will bump affected versions), and issues that require a
pre-existing compromise of the host or datastore credentials.
