# Web analytics conventions

How we measure the public surfaces (memoturn.com, docs.memoturn.com, demo.memoturn.com)
and tag the links we control. Self-hosted Memoturn ships **zero** analytics — everything
here applies only to our hosted properties.

## The setup

One GA4 property, one web data stream (`memoturn.com` — subdomains share the
`.memoturn.com` cookie, so a marketing → docs → demo journey is one session). Plain
gtag.js everywhere, no Google Tag Manager: the demo console renders untrusted trace
content, and GTM's dynamically configurable tag injection has no place on that surface.

Where the id is wired (all env-gated; unset = no tag):

| Surface | Env var | Set in |
| --- | --- | --- |
| memoturn.com | `VITE_GA_MEASUREMENT_ID` | `GA_MEASUREMENT_ID` repo variable → `deploy-site.yml` |
| docs.memoturn.com | `PUBLIC_GA_MEASUREMENT_ID` | same repo variable, same workflow |
| demo.memoturn.com | `VITE_GA_MEASUREMENT_ID` | demo VM `.env` → compose build arg (baked at image build) |

## Consent (Consent Mode v2)

- Ad signals (`ad_storage`, `ad_user_data`, `ad_personalization`) are **always denied**.
  We run no ads; never change this without a privacy-policy update.
- `analytics_storage` defaults to **denied in the EEA, UK, and Switzerland** and granted
  elsewhere. The region list lives in three synced places:
  `apps/web/src/lib/analytics.ts`, `apps/docs/astro.config.mjs`,
  `apps/console/src/lib/analytics.ts`.
- memoturn.com and docs.memoturn.com show a consent banner (choice stored per-site in
  `localStorage["mt-consent"]`). The demo shows none — EEA/UK/CH demo visitors stay on
  cookieless pings permanently.
- The public privacy note is `https://memoturn.com/privacy`
  (`apps/web/src/routes/privacy.tsx`). Keep it truthful when any of the above changes.

## UTM conventions

Add UTM parameters only to links **we publish outside our own domains** — cross-links
between the three memoturn.com subdomains are one GA session already and must stay
UTM-free. Referrers cover organic traffic; UTMs are for placements where the referrer
is stripped or too coarse (READMEs, package registries, launch posts).

Format: `?utm_source=<where>&utm_medium=<what>` — lowercase, no campaign param except
for launches (`utm_campaign=<launch-slug>`).

| Placement | source | medium |
| --- | --- | --- |
| GitHub README(s) | `github` | `readme` |
| npm package page | `npm` | `listing` |
| PyPI package page | `pypi` | `listing` |
| Hacker News post | `hackernews` | `post` |
| Product Hunt | `producthunt` | `launch` |
| Blog/guest posts | `<site>` | `post` |
| Transactional email | — never; sign-in links must stay clean — | |

Currently applied: the root `README.md` (demo + site + docs links). SDK READMEs pick up
`utm_source=npm|pypi&utm_medium=listing` at their next routine release — don't cut a
release just for UTMs.
