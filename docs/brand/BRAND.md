# Memoturn Brand

This document is the source of truth for how Memoturn looks and feels — the visual language behind the public sites (marketing + docs) and, over time, the console. The shared design system lives at [packages/ui](../../packages/ui), and tokens at [packages/ui/src/styles/tokens.css](../../packages/ui/src/styles/tokens.css).

If you're touching UI, this doc tells you what's deliberate vs incidental, what to keep vs what to push further, and how to extend the system without breaking it.

## Voice

Memoturn is an **open-source, self-hostable AI engineering platform — LLM observability, evals, and prompt management.** The voice is technical and direct — we explain what the product does in concrete terms ("self-hostable", "OpenTelemetry-native", "nothing leaves your network") and we name the primitives and backends it runs on ("traces", "evaluators", "the prompt registry", "ClickHouse, Postgres, Redis").

We are not whimsical, but we are not cold either. The "island" metaphor in the brand (lagoon, palm, sand, foam, atoll) is intentional — it gives a developer-infrastructure product a warmer, more human aesthetic than the usual blue-and-grey enterprise template. We lean into it without becoming silly.

**Do**

- Lead with what works ("See every LLM call, on infrastructure you own").
- Use plain English over jargon when possible — a kicker like "every call, traced" beats "comprehensive telemetry capture across the request lifecycle".
- Reference the primitives, protocols, and backends by name (trace, score, evaluator, prompt channel, OTel, MCP, ClickHouse).
- Keep marketing copy concise — one strong sentence beats a paragraph.

**Don't**

- Use emoji or whimsical metaphors in product UI ("🌊 Surfing the data!"). The metaphor is in the palette and motion, not the copy.
- Use generic AI-product phrases like "supercharge", "leverage", "unlock the power of".
- Hide what's actually happening — "Mapping batch into ClickHouse…" is better than "Working on your request…".

## Palette

The palette is a **lagoon trio + warm accent + neutral anchors.** Every color has a defined semantic role; we don't introduce one-off colors in components.

### Brand colors

| Token | Light | Dark | Use |
|---|---|---|---|
| `--lagoon` | `#4fb8b2` | `#60d7cf` | Active state, focus rings, links, primary accent. |
| `--lagoon-deep` | `#328f97` | `#8de5db` | Default button, CTA, focused border. The "default brand color." |
| `--palm` | `#2f6a4a` | `#6ec89a` | Secondary accent, success state, healthy/running status. |
| `--accent-warm` | `#e89456` | `#f5b169` | Warning surfaces, attention cues, the *only* warm color in the system. Use sparingly. |
| `--destructive` | `#c4543c` | `#e07a5f` | Errors. Coral-toned, not Material red — ties into the warm accent. |

### Neutrals

| Token | Light | Dark | Use |
|---|---|---|---|
| `--sea-ink` | `#173a40` | `#d7ece8` | Body text. |
| `--sea-ink-soft` | `#416166` | `#a4c5c0` | Secondary text, nav links, muted-foreground. |
| `--sand` | `#e7f0e8` | `#1a2e2a` | Soft accent background. |
| `--foam` | `#f3faf5` | `#0f1f1c` | Muted background, second-level surfaces. |
| `--bg-base` | `#e7f3ec` | `#0a1418` | Page background. |

### Surfaces

| Token | Use |
|---|---|
| `--surface` | `rgba(255,255,255,0.74)` — frosted glass, the default for most cards. |
| `--surface-strong` | `rgba(255,255,255,0.9)` — more opaque, for elevated content. |
| `--chip-bg` | `rgba(255,255,255,0.8)` — pill / button container background. |
| `--chip-line` | Border color paired with `--chip-bg`. |
| `--inset-glint` | `rgba(255,255,255,0.82)` — inner top highlight on raised surfaces. |
| `--code-surface` | Dark surface for code blocks (always dark, regardless of theme). |

### Gradients

Two formal gradients carry brand weight; everything else should compose from these.

| Token | Definition | Use |
|---|---|---|
| `--gradient-lagoon` | `linear-gradient(135deg, var(--lagoon), var(--lagoon-deep))` | Primary CTA backgrounds, button "soft" variant hover, BrandMark dot. |
| `--gradient-atoll` | `linear-gradient(135deg, var(--lagoon-deep), var(--palm))` | Hero backdrops, marketing surfaces, footer band. |

## Typography

| Family | Token | Use |
|---|---|---|
| **Fraunces** (display serif) | `--font-display`, `--font-serif` | All hero titles, card titles, section headings. The display voice. |
| **Manrope** (sans) | `--font-sans` | Body, UI, forms, tables. The default. |
| **JetBrains Mono** (mono) | `--font-mono` | Slugs, IDs, codes, search ranks, anywhere data needs to read as data. |

Two utility classes formalize the brand voice:

- `.island-kicker` — uppercase, `letter-spacing: 0.16em`, `font-weight: 700`, `font-size: 0.69rem`, palm-tinted color. The eyebrow above titles. **Always use this** for the small label above a heading.
- `.display-title` — Fraunces, kerning tuned for the brand. Apply to any heading where the visual weight matters.

**Rules**

- Headings on data-heavy pages can use `font-sans semibold` if Fraunces feels too editorial.
- Never mix Fraunces and Manrope on the same line. Pick one per heading.
- The `island-kicker` is paired with a heading. Don't use it standalone or as a button label.

## Radius

Memoturn uses a **paired radius scale**, not a single rounded-full reflex. Pills are reserved for badges and small chip toggles.

| Token | Value | Use |
|---|---|---|
| `--radius-button` | `0.625rem` (10px) | Buttons, tabs, dropdown items. Was previously `rounded-full`. |
| `--radius-input` | `0.5rem` (8px) | Inputs, textareas, selects. |
| `--radius-card` | `1rem` (16px) | Cards, modals, popovers. |
| `--radius-pill` | `9999px` | Badges, small toggle chips. |

The previous `--radius` (10px) is kept as a base alias.

## Shadows

Memoturn shadows are **green-tinted** in light mode — this is one of the most distinctive parts of the brand and is deliberately not standard shadcn.

| Token | Value (light) | Use |
|---|---|---|
| `--shadow-elevation-sm` | `0 8px 22px rgba(30,90,72,0.08)` | Resting cards, soft surfaces. |
| `--shadow-elevation-md` | `0 10px 28px rgba(30,90,72,0.18)` | Active cards, raised buttons. |
| `--shadow-elevation-lg` | `0 22px 44px rgba(30,90,72,0.18)` | Modals, popovers, hero CTAs. |
| `--shadow-inset-glint` | `inset 0 1px 0 var(--inset-glint)` | Inner highlight on raised surfaces. Pair with elevation. |

Dark mode flips to neutral black shadows (no green tint — too murky against the dark background).

## Motion

Three formal motion tokens. **All motion respects `prefers-reduced-motion`.**

| Token | Curve | Use |
|---|---|---|
| `--ease-tide` | `cubic-bezier(0.16, 1, 0.3, 1)` | Entrances. Bouncy + organic. Used by the `rise-in` keyframe. |
| `--ease-swell` | `cubic-bezier(0.4, 0, 0.2, 1)` | Hover and press states. |
| `--duration-rise` | `700ms` | Page-level entrance. |
| `--duration-swell` | `180ms` | Hover, focus, color transitions. |

Two named keyframes:

- `rise-in` — opacity 0→1, translateY 12px→0, `--ease-tide`. The standard entrance.
- `tide-drift` — subtle horizontal shift on hover (3-4px), `--ease-swell`. Use sparingly, on cards that benefit from feeling "unmoored".

## Surfaces

The `island-shell` utility class is the **default for branded containers** — cards, modals, popovers, dropdowns. It composes:

- `--surface` background with a dual-tone gradient overlay
- 1px `--chip-line` border
- triple-shadow layering (`elevation-md` + `inset-glint` + a faint inner gradient)
- `backdrop-filter: blur(4px)` for glass effect

Plain `bg-card` or `bg-popover` is **only** for surfaces inside an `island-shell` (e.g., a sub-card inside a modal).

## Decorative

- **Topographic pattern** (`--pattern-topo`) — thin lagoon-deep concentric arcs, opacity 0.08. Used as a low-contrast decoration on hero backdrops, footer bands, CTA surfaces. Apply via the `.atoll-band` utility class.
- **Body backdrop** — multi-layer radial gradients (lagoon + palm + sand) at low opacity create the "island atmosphere" on every page. Don't override per-page.
- **Brand dot** — the `--gradient-lagoon` gradient is used for the `Logo variant="chip"` brand dot and as a recurring small accent.

## What we avoid

- Gradient sweeps on body text or large copy blocks (kills legibility).
- Pure-white surfaces. If something looks like raw `#FFFFFF`, it's a bug.
- Material-ish elevation (drop shadows pointing down with no green tint).
- Motion that pops vertically more than 4px. Memoturn motion drifts; it doesn't bounce.
- Saturated reds, blues, or yellows outside the formal palette. The `--accent-warm` is the only warm color we use, and `--destructive` is its desaturated coral cousin.

## Reference

- Tokens: [packages/ui/src/styles/tokens.css](packages/ui/src/styles/tokens.css)
- Utility classes + keyframes: [packages/ui/src/styles/base.css](packages/ui/src/styles/base.css)
- BrandMark: [packages/ui/src/composite/BrandMark.tsx](packages/ui/src/composite/BrandMark.tsx)
