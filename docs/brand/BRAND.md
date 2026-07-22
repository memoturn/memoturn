# Memoturn Brand

This document is the source of truth for how Memoturn looks and feels — the visual language behind the public sites (marketing + docs) and, over time, the console. The shared design system lives at [packages/ui](../../packages/ui), and tokens at [packages/ui/src/styles/tokens.css](../../packages/ui/src/styles/tokens.css). The machine-readable spec is [DESIGN.md](DESIGN.md) (+ [DESIGN.json](DESIGN.json)); where the two disagree, DESIGN.md wins on values, this file wins on intent.

If you're touching UI, this doc tells you what's deliberate vs incidental, what to keep vs what to push further, and how to extend the system without breaking it.

## The system in one sentence

Memoturn is a **dark instrument panel**: a sea-ink-tinted near-black canvas, hairline-ledger structure, one surgical lagoon accent, a single loud atoll-gradient moment per page, and the real console — captured, framed, and glowing faintly — as the imagery.

Dark is not a theme option on the marketing surface; it IS the brand. memoturn.ai ships dark-only. The docs default dark and keep a light reading mode. The console has carried this identity all along; the public sites now match the product instead of inverting it.

## Voice

Memoturn is an **open-source, self-hostable AI engineering platform — LLM observability, evals, and prompt management.** The voice is technical and direct — we explain what the product does in concrete terms ("self-hostable", "OpenTelemetry-native", "nothing leaves your network") and we name the primitives and backends it runs on ("traces", "evaluators", "the prompt registry", "Doris, Postgres, Redis").

We are not whimsical, but we are not cold either. The "island" metaphor survives in the token vocabulary (lagoon, palm, sand, foam, atoll, sea-ink) and in exactly two visible artifacts: the atoll-gradient closing band and the concentric-ring brand mark. The metaphor never enters copy.

**Audience:** individual developers running a single self-hosted box through enterprise platform teams running it at scale — self-hosting is the point, not a downmarket compromise. Compliance primitives (SSO, RBAC, audit logs, PII masking) ship in the Apache-2.0 core for everyone; the marketing surface says so out loud ("The enterprise tier is the free tier"). Don't write copy that implies they're an enterprise-only upsell.

**Do**

- Lead with what works ("See every LLM call. On infrastructure you own.").
- Show the product. Real console captures — dashboard, trace waterfall, prompt channels — are required imagery, not optional decoration. The audience decides whether to adopt by looking at the trace waterfall; never make them guess.
- Reference the primitives, protocols, and backends by name (trace, score, evaluator, prompt channel, OTel, MCP, Doris).
- Keep marketing copy concise — one strong sentence beats a paragraph.

**Don't**

- Use emoji or whimsical metaphors in product UI ("🌊 Surfing the data!"). The metaphor is in the palette and motion, not the copy.
- Use generic AI-product phrases like "supercharge", "leverage", "unlock the power of".
- Hide what's actually happening — "Mapping batch into Doris…" is better than "Working on your request…".

## Palette

Dark-first. The canvas is the brand; lagoon is reserved for action, focus, data, and glow. `:root` in tokens.css carries the dark theme; `[data-theme="light"]` is the docs-only reading mode.

### Canvas (dark, the default)

| Token | Value | Use |
|---|---|---|
| `--background` | `oklch(0.146 0.012 215)` | Page canvas — near-black tinted toward sea-ink's hue. Never pure `#000`. |
| `--card` | `oklch(0.175 0.013 215)` | Raised blocks, feature cells, alternating section bands (`bg-card/50`). |
| `--foreground` | `oklch(0.965 0.005 195)` | Body text — foam-tinted white. |
| `--muted-foreground` | `oklch(0.735 0.014 205)` | Secondary text, the soft half of two-tone headlines. ≥4.5:1 on the canvas. |
| `--border` / `--rule` | foam at 11% / 14% | Containment vs structure. Hairlines carry all depth. |

### Brand colors

| Token | Value | Use |
|---|---|---|
| `--lagoon` | `#4fb8b2` | THE accent on dark: links, focus rings, chart-1, tag chips, glow washes. Used surgically — never as a large fill. |
| `--lagoon-deep` | `#328f97` | The darker gradient stop; light-mode chart anchor. |
| `--palm` | `#2f6a4a` | The deep stop of `--gradient-atoll`. Only inside the gradient. |
| `--sea-ink` | `#173a40` | The hue-parent of the dark canvas; text-on-foam for on-gradient buttons. |
| `--foam` | `#f3faf5` | Primary CTA fill on the dark canvas (foam button, sea-ink text). |
| `--accent-warm` | `#e89456` | The only warm color; chart accent + occasional state cue, <5% of any composition. |

In light mode `--primary` steps darker than lagoon-deep — to `oklch(0.52 0.073 200)` — because it doubles as link/label text on white and must clear 4.5:1. Never put raw `#4fb8b2` text on a light surface.

### Gradients & glow

| Token | Definition | Use |
|---|---|---|
| `--gradient-lagoon` | `linear-gradient(135deg, lagoon, lagoon-deep)` | BrandMark fill. |
| `--gradient-atoll` | `linear-gradient(135deg, lagoon-deep, palm)` | The one loud brand moment: the closing band. Load-bearing, never decorative. |
| `--glow-lagoon` | radial lagoon wash from the top edge, ≤13% | The dimensional treatment for dark surfaces (`.frame-shot`, `.glow-panel`). Static, or a hover fade. **Never pulsing, never a colored border, never glassmorphic** — that's the orchestrator-glow family we define ourselves against. |

## Typography

One family plus mono. **Archivo** (variable: weight + width axes) carries everything; the display voice is the *width axis*, not a second typeface.

| Role | Spec | Use |
|---|---|---|
| Display (`.display-title`) | Archivo 700, `font-stretch: 110%`, tracking `-0.03em`, line-height 1.04 | Headlines. The expanded width is what separates display from body. |
| Body | Archivo 400, line-height 1.6 | All running copy. |
| Mono | JetBrains Mono 400/500 | Code, data, meta rows, tag chips — anywhere data reads as data. |

**The two-tone headline** is the section-header system: the bright key phrase in `--foreground`, the elaboration in `--muted-foreground`, one sentence, one heading element (`<span class="tone-soft">`). It replaced the uppercase tracked kicker as section grammar.

**Kickers are retired as scaffolding.** `.kicker` still exists for genuine labels (error-page status lines, docs hero "open source"), but an eyebrow above every section heading is forbidden — the two-tone headline carries section identity. One deliberate kicker moment per page, maximum.

## Imagery

Real console captures are the brand's imagery. Rules:

- Captures come from `bun run screenshots` (Playwright, dark theme, 1440 @2x, seeded demo data) — never hand-cropped browser chrome, never mocked data that the product can't produce.
- Framed with `.frame-shot`: 1px `--rule` border, `--radius-xl`, `--card` ground, `--glow-lagoon` wash. The hero capture dissolves into the canvas with a bottom mask — the console reads as part of the page, not a pasted rectangle.
- Every capture gets alt text written in voice ("An agent-loop trace: tool spans in green, the failing final-answer call accented in red"), plus explicit width/height to prevent layout shift.
- One decisive capture per slot. The hero gets the dashboard; each feature card gets its matching surface (waterfall / evaluators / prompt channels).

## Radius, rules, elevation

- Single radius base `--radius: 0.375rem` (~6px), scaled `sm…4xl`. Light rounding; no pills except badges.
- Hairline rules (`--rule`, foam 14% on dark) carry structure: ledger rows, feature-grid cells, dashed tag-row separators. `--border` is for containment only.
- Flat by default. No resting-surface shadows. Depth = hairlines + tonal steps (background → card) + the lagoon glow wash. Overlays (modal, popover, dropdown) keep functional shadows.

## Motion

Three tokens, all honoring `prefers-reduced-motion`:

- `--ease-tide` `cubic-bezier(0.16,1,0.3,1)` — entrances; the `rise-in` keyframe (the hero capture's single signature entrance).
- `--ease-swell` `cubic-bezier(0.4,0,0.2,1)` — hover/press, 180ms.
- `.glow-panel` hover — the lagoon wash fades in (opacity only, 260ms). Color motion, not transform.

One signature entrance per page (the hero capture). Scroll-fade-rise on every section is forbidden.

## Wordmark

In brand-mark/logo lockups (web header + footer, docs site title, console sidebar), the name is set in **all caps — MEMOTURN** — with positive letter-spacing (`0.08em`), heading font, bold. Implement it with `text-transform: uppercase` on text that reads "Memoturn", never by typing "MEMOTURN" literally (screen readers can spell out literal all-caps, and `aria-label`s / `<title>`s stay "Memoturn"). In running prose the name stays "Memoturn" ("memoturn" only in code/package identifiers).

## What we avoid

- The five anti-reference families (see DESIGN.md §6, unchanged): SaaS gradient-hero, neon-purple-on-black, brutalist-monospace, enterprise-navy, and above all **orchestrator glow** (glassmorphic tiles, pulsing teal borders, glow halos). Our dark canvas sits nearest that family, so the discipline that separates us is explicit: flat hairline ledgers, static glow washes, real product captures, one accent.
- Gradient text, glassmorphism, side-stripe borders, hero-metric stat blocks — all inherited bans.
- Uppercase tracked eyebrows repeated above sections (see Typography).
- Teal text below 4.5:1 — on white use the light-mode `--primary`, on gradient use `--on-gradient-fg` at ≥92% opacity or darken the fill behind it.
- Pure-black `#000` canvas and pure-white cards on dark. Every dark surface carries the sea-ink hue tint.

## Reference

- Tokens: [packages/ui/src/styles/tokens.css](../../packages/ui/src/styles/tokens.css)
- Utility classes + keyframes (`.display-title`, `.tone-soft`, `.frame-shot`, `.glow-panel`, `.lit-edge`/`.lit-edge--bottom`, `.rise-in`, `.atoll-band`): [packages/ui/src/styles/base.css](../../packages/ui/src/styles/base.css). Lit edges run at 35% on structural boundaries (sections, header, footer, ledger tops) and 55% on `.frame-shot`; they light an existing hairline, never replace one.
- BrandMark: [packages/ui/src/composite/BrandMark.tsx](../../packages/ui/src/composite/BrandMark.tsx)
- Screenshot pipeline: [scripts/screenshots.ts](../../scripts/screenshots.ts)
