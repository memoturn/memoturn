---
name: Memoturn
description: Open-source LLM observability, evals, and prompt management
colors:
  lagoon: "#4fb8b2"
  lagoon-deep: "#328f97"
  palm: "#2f6a4a"
  ember: "#e89456"
  sea-ink: "#173a40"
  sea-ink-soft: "#416166"
  foam-light: "#f6fefb"
  foam: "#f3faf5"
  sand: "#e7f0e8"
  canvas: "#0d1417"
  panel: "#131b1e"
  foreground: "#f2f6f5"
  muted: "#a8b4b3"
  rule: "#f3faf524"
  border: "#f3faf51c"
  light-page: "#ffffff"
  light-foreground: "#252525"
  light-primary: "#2c7c83"
typography:
  display:
    fontFamily: "Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(44px, 6.5vw, 84px)"
    fontWeight: 700
    lineHeight: 1.04
    letterSpacing: "-0.03em"
    fontVariation: "'wdth' 110"
  headline:
    fontFamily: "Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(30px, 3.8vw, 46px)"
    fontWeight: 700
    lineHeight: 1.04
    letterSpacing: "-0.03em"
    fontVariation: "'wdth' 110"
  title:
    fontFamily: "Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "22px"
    fontWeight: 700
    lineHeight: 1.05
    letterSpacing: "-0.03em"
    fontVariation: "'wdth' 110"
  body-large:
    fontFamily: "Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: "normal"
  body:
    fontFamily: "Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: "normal"
  mono:
    fontFamily: "JetBrains Mono, ui-monospace, SF Mono, Menlo, Consolas, monospace"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1.55
    letterSpacing: "0.02em"
  meta:
    fontFamily: "JetBrains Mono, ui-monospace, SF Mono, Menlo, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0.04em"
rounded:
  default: "6px"
  frame: "8px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
  2xl: "48px"
  3xl: "64px"
  section-y: "96px"
  gutter: "24px"
  max-width: "1152px"
components:
  button-primary:
    backgroundColor: "{colors.foam}"
    textColor: "{colors.sea-ink}"
    rounded: "{rounded.default}"
    padding: "0 22px"
    height: "40px"
  button-primary-hover:
    backgroundColor: "#e4efe8"
    textColor: "{colors.sea-ink}"
  button-outline:
    backgroundColor: "transparent"
    textColor: "{colors.foreground}"
    rounded: "{rounded.default}"
    padding: "0 22px"
    height: "40px"
  button-outline-hover:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.foreground}"
  button-on-gradient-primary:
    backgroundColor: "{colors.foam-light}"
    textColor: "{colors.sea-ink}"
    rounded: "{rounded.default}"
    padding: "0 22px"
    height: "40px"
  button-on-gradient-secondary:
    backgroundColor: "#173a4073"
    textColor: "{colors.foam-light}"
    rounded: "{rounded.default}"
    padding: "0 22px"
    height: "40px"
  quiet-link:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    padding: "0 4px"
    height: "40px"
  tag:
    backgroundColor: "#4fb8b21a"
    textColor: "{colors.lagoon}"
    rounded: "4px"
    padding: "3px 8px"
  card:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.foreground}"
    rounded: "0px"
    padding: "0 0 32px"
  frame-shot:
    backgroundColor: "{colors.panel}"
    rounded: "{rounded.frame}"
---

# Design System: Memoturn

## 1. Overview

**Creative North Star: "The Dark Instrument Panel"**

Memoturn's console has always been a dark instrument panel — telemetry on a near-black ground, teal as data. The public surfaces now match the product instead of inverting it: a sea-ink-tinted near-black canvas (never pure `#000`), hairline-ledger structure, oversized tight-set Archivo headlines in two tones, one surgical lagoon accent, real console captures framed with a faint lagoon glow, and a single loud atoll-gradient moment at the end of every page. The product IS the imagery; the canvas IS the brand. Marketing is dark-only; docs default dark with a light reading mode.

Memoturn deliberately rejects every standard AI-coding-tool aesthetic: no generic SaaS gradient-hero (Cursor, Vercel), no neon-purple-on-black (OpenAI, Replit), no monospace-brutalist (HN-aesthetic), no enterprise-AI navy-and-rounded (IBM watsonx, Azure-AI-Foundry), and no AI-agent orchestrator glow (mem0.ai-style: glassmorphic tiles on charcoal, pulsing cyan/teal accent borders, agent avatars with glow halos, "AI inbox" three-column layouts). Going dark moved Memoturn CLOSER to the orchestrator-glow family's turf, so the separating discipline is now explicit and non-negotiable: flat hairline ledgers instead of glassmorphic tiles, a static top-edge glow wash instead of pulsing accent borders, real product captures instead of faux-3D abstractions, one accent color used surgically instead of a neon wash. If a Memoturn surface could be confused with that family at a glance, redesign with different structure.

**Key Characteristics:**
- One family: Archivo variable (weight + width axes) — the display voice is `font-stretch: 110%` + `-0.03em`, not a second typeface. JetBrains Mono for code, data, and meta.
- Two-tone headlines (bright key phrase + muted elaboration in one sentence) are the section-header system. Uppercase tracked eyebrows are retired as section grammar.
- The canvas (`#0d1417`-class sea-ink near-black) carries the brand; lagoon `#4fb8b2` is reserved for links, focus, data, chips, and glow.
- Real console captures (from `bun run screenshots`, dark theme, @2x) are required imagery: dashboard in the hero, matching surface per feature card.
- Hairline rules and tonal layering carry depth; the only radial treatment is `--glow-lagoon`, a static ≤13% wash from a surface's top edge.
- Lagoon → Atoll gradient remains the only gradient; load-bearing on the brand mark and the closing band, never decorative.

## 2. Colors: The Dark Lagoon

The canvas runs dark and cool, tinted toward sea-ink's hue (oklch hue ≈ 215) at low chroma. Coastal vocabulary names the tokens but never enters copy. Light mode exists only as the docs reading mode.

### Primary
- **Lagoon** (`#4fb8b2`): THE accent on the dark canvas — links, focus ring (`--ring`), chart-1, tag chips, the glow wash. Used surgically; never as a large fill, never as a section ground. On light surfaces it fails contrast as text (2.4:1 on white): light mode substitutes **Light Primary** (`#2c7c83`-class, `oklch(0.52 0.073 200)`).

### Secondary
- **Lagoon Deep** (`#328f97`): The darker gradient stop; light-mode chart anchor. Pairs with foam-light as the only valid foreground on top of it.
- **Palm** (`#2f6a4a`): The deep green stop in `gradient-atoll`. Only inside the gradient; standalone palm fills are forbidden (reads enterprise-green).

### Tertiary
- **Ember** (`#e89456`): The warm counter-accent. Chart-4, occasional state cues. The Ember Cap Rule: less than 5% of any composition; never a CTA fill or ground.

### Neutral
- **Canvas** (`#0d1417`, `oklch(0.146 0.012 215)`): The page ground. Sea-ink-hued near-black — never pure `#000`, never a neutral gray.
- **Panel** (`#131b1e`, `oklch(0.175 0.013 215)`): Raised blocks: feature cells, framed captures, alternating section bands at 50% mix.
- **Foreground** (`#f2f6f5`, `oklch(0.965 0.005 195)`): Body text — foam-tinted white, full ink.
- **Muted** (`#a8b4b3`, `oklch(0.735 0.014 205)`): The soft half of two-tone headlines, secondary body copy, meta rows. Clears 4.5:1 on canvas; still forbidden for long body copy where foreground belongs.
- **Rule** (foam at 14% alpha): Hairline structure inside ledgers, grids, dashed tag rows. **Border** (foam at 11%) is containment. Rule = structure inside; border = containment around.
- **Sea Ink / Foam / Foam Light / Sand** (`#173a40` / `#f3faf5` / `#f6fefb` / `#e7f0e8`): Sea-ink is the text on foam-filled buttons; foam is the primary CTA fill on the canvas; foam-light is the on-gradient foreground; sand survives as a light-mode tint.

### Named Rules
**The Canvas-Tint Rule.** Every dark surface carries the sea-ink hue (oklch hue ~215, chroma 0.012–0.014). Pure `#000` and neutral-gray darks are forbidden; the tint is what makes the dark canvas Memoturn's rather than generic dark mode.

**The Surgical-Lagoon Rule.** Lagoon appears as text/stroke/glow at small scale only — links, rings, chips, chart lines, the glow wash. A lagoon-filled button, panel, or band is forbidden; when the brand needs to be loud, the atoll gradient is the instrument.

**The Lagoon-Atoll Rule.** The two named gradients (`gradient-lagoon`, `gradient-atoll`) are the only gradients permitted. Any other gradient is forbidden — with one carve-out: `--glow-lagoon`, the static radial wash (≤13% lagoon from a surface's top edge), which is a lighting treatment, not a gradient surface.

**The Foam-Light-On-Dark Rule.** On the atoll gradient the only valid foreground is foam-light at ≥92% opacity; secondary on-gradient buttons darken their fill (sea-ink at ~45%) rather than fade their text.

## 3. Typography: One Variable Family, Stretched for Display

**Display + Body Font:** Archivo (variable; weight 400–800, width 100–125; fallbacks ui-sans-serif, system-ui)
**Label / Mono Font:** JetBrains Mono (fallbacks ui-monospace, SF Mono, Menlo, Consolas)

**Character:** Archivo at normal width carries body copy; pushed to `font-stretch: 110%` with `-0.03em` tracking and 700 weight it becomes the display voice — compact, geometric, machine-set. The width axis, not a typeface change, is what separates display from body. JetBrains Mono appears anywhere precision matters: code, meta rows, tag chips, data.

### Hierarchy
- **Display** (Archivo 700 @ 110% width, `clamp(44px, 6.5vw, 84px)`, line-height 1.04, tracking -0.03em): Hero headline. One per page. Set as a two-tone sentence.
- **Headline** (same voice, `clamp(30px, 3.8vw, 46px)`): Section headlines. Two-tone: bright key phrase + `tone-soft` elaboration.
- **Title** (same voice, 22px): Card titles.
- **Body** (Archivo 400, 16px, line-height 1.6): Running copy, capped at 65–75ch.
- **Mono / Meta** (JetBrains Mono, 13px / 12px): Code, license rows, tag chips, "works with" labels. 12px is the floor; 11px type is forbidden.

### Named Rules
**The Two-Tone Rule.** Section identity is carried by the two-tone headline — bright phrase in foreground, elaboration in muted, one heading element. Uppercase tracked eyebrows above section headings are retired; at most one deliberate kicker moment per page (e.g. the docs hero "open source" label).

**The Tight-Set Rule.** Display type uses line-height ≤1.05 and tracking -0.03em at 110% width. Loosening for "breathing room" is forbidden; -0.04em is the floor (letters must not touch).

**The Em-Dash Exception.** Spaced em-dashes (` — `) remain a documented voice exception in running copy. They are no longer used in headlines; headlines break with periods (two-tone sentences).

**The Single-Family Rule.** Archivo + JetBrains Mono is the system. A second sans, a serif, or italics are flags to revise.

## 4. Elevation: Flat Hairlines, Lit by Glow

The system is flat at rest. Depth comes from hairline rules (foam 14% on dark), tonal steps (canvas → panel), and one lighting treatment: `--glow-lagoon`, a static radial lagoon wash (≤13%, from the top edge) on framed captures and glow-panels. The glow may fade in on hover (opacity only, 260ms); it never pulses, never becomes a colored border, and never pairs with backdrop blur — those are the orchestrator-glow tells this system defines itself against.

### Shadow Vocabulary
- **None on resting surfaces.** Cards, sections, ledgers, framed captures: no box-shadow.
- **Overlay shadows** (`shadow-md` / `shadow-lg`): modal, dialog, popover, sheet, tooltip, dropdown — elevation IS their meaning.
- **The mark's drop-shadow** on the atoll band (`drop-shadow(0 6px 18px rgba(0,0,0,0.28))`) is the one decorative shadow, anchoring the BrandMark to the gradient.

### Named Rules
**The Flat-By-Default Rule.** Unchanged: resting surfaces have no shadow; overlays are exempt.

**The Static-Glow Rule.** `--glow-lagoon` is the only permitted radial treatment: top-edge origin, lagoon ≤13% (22% for the hero frame), static or hover-faded. Animated/pulsing glows, glowing borders, and glassmorphism are forbidden.

**The Tonal-Step Rule.** Dark grounds step canvas → panel (→ panel at 50% mix for section bands). Depth comes from the step; never add a shadow to reinforce it.

## 5. Components

Names ARE the spec: `button-primary`, `button-outline`, `button-on-gradient-primary`, `button-on-gradient-secondary`, `quiet-link`, `frame-shot`, `glow-panel`, `tag`, ledger rows. A shape outside the named set is a flag to revise.

### Buttons

Four named shapes, no fifth.

- **Shape:** 6px radius, height 40px, padding 0 22px, Archivo 500/14px, single-line.
- **Primary (foam fill):** Background `foam`, text `sea-ink`. The highest-priority CTA on the dark canvas ("Get started"). The light fill on a dark page is the Neon-school move: the accent stays scarce, the button still shouts.
- **Outline:** Transparent ground, 1px `--border`, foreground text; hover raises to panel. Secondary CTA ("Star on GitHub").
- **On-gradient primary / secondary:** Foam-light fill + sea-ink text; secondary is foam-light text over a sea-ink 45% tint (darkened fill, never faded text). Atoll band only.
- **Quiet link:** Transparent, muted text with a `→` that translates 3px on hover; resolves to foreground. ("See all use cases in the docs.")

### Frame Shot (the capture frame)

The signature component of the rebrand: a real console capture in a hairline frame.

- **Structure:** 1px `--rule` border, 8px radius, `panel` ground, `--glow-lagoon` wash overlay, `object-fit: cover; object-position: top`.
- **Hero variant:** full content width, bottom 22% dissolved with a mask into the canvas; `rise-in` entrance (the page's single signature entrance); `fetchpriority="high"` + explicit dimensions.
- **Card variant:** 16/10 aspect crop at a feature card's top, hairline-separated from the copy below.
- **Source of truth:** `bun run screenshots` (Playwright, dark theme, seeded demo data, 1440 @2x). Hand-mocked UI is forbidden.

### Feature Cards (Ledger Cards)

Three-card grids only (the identical-card-grid exception, spent here). Cells share hairline-rule borders on a `canvas` ground; each cell: capture (frame region) → title (Archivo display 22px) → body (muted 14.5px) → dashed-rule tag row. Cells are `glow-panel`s: the lagoon wash fades in on hover.

### Ledgers

Everything that is not the three-card grid is a hairline ledger: label column (Archivo 600, foreground) + body column (muted). No chips in ledgers, no numbered indices unless the sequence is real.

### Tags

Inline mono chips inside the three feature cards only: `rgba(79,184,178,0.10)` ground, lagoon text, JetBrains Mono 12px. Static.

### Navigation

Sticky header on `background/90` with `backdrop-blur-sm`, hairline bottom border. Brand lockup (mark + MEMOTURN wordmark, 0.08em tracking) + Docs/GitHub + foam-filled "Get started" (→ docs getting-started; the GitHub action is never labeled "Get started"). No theme toggle on marketing.

### Brand Mark

Unchanged: concentric rings, gradient variant on any surface where the gradient reads, `currentColor` mono variant on gradient surfaces; inline `<svg>` + `<use>` only; slow tide rotation on hover, suppressed under reduced motion.

### Named Rules
**The Four-Shapes Rule.** Unchanged in spirit; the four shapes are now foam-primary, outline, on-gradient primary, on-gradient secondary (+ quiet-link as the non-button).

**The Real-Capture Rule.** Product imagery is real console output captured by the screenshot pipeline. Mocked UI, hand-drawn "product" abstractions, and stock imagery are forbidden.

**The Card-Grid-Three-Only Rule.** Unchanged: three is the only valid identical-card count.

## 6. Do's and Don'ts

### Do:
- **Do** lead with mechanism. Name the store (Doris, Postgres, Redis, blob), the transport (OTLP, MCP, webhooks), the surface (traces, evaluators, prompt channels).
- **Do** ship the dark canvas tinted toward sea-ink (`oklch(0.146 0.012 215)`); marketing is dark-only, docs default dark with a light reading mode.
- **Do** show the real console: dashboard in the hero (bottom-masked into the canvas), matching capture per feature card, all from `bun run screenshots`.
- **Do** use lagoon surgically — links, focus, chips, charts, glow — and let the foam-filled button be the loud element.
- **Do** set section headers as two-tone sentences; keep display type at 110% width, -0.03em, line-height ≤1.05.
- **Do** break out the wedge: SSO / RBAC / audit / PII masking / retention / rate limits as its own section ("The enterprise tier is the free tier"), never buried in a ledger row.
- **Do** keep the atoll-gradient band as the single loud brand moment, at page end, with the topo pattern screened at ≤16%.
- **Do** honor `prefers-reduced-motion` everywhere: the tide rotation, the rise-in entrance, and the glow-panel fade all suppress.
- **Do** run the category-reflex check at both altitudes; nearest-neighbor distance to the orchestrator-glow family must stay the largest.

### Don't:
- **Don't** look like generic SaaS gradient-hero (Cursor.com, Vercel-style): gradient hero, drop-shadowed screenshot floating in space, identical 3-icon cards, YC-logo strip. Memoturn's captures are hairline-framed and dissolved into the canvas, never drop-shadowed set pieces.
- **Don't** look like AI-product neon-purple-on-black (OpenAI, Replit-style): cyberpunk glow edges, neural imagery, "future of coding" positioning.
- **Don't** look like developer-tool brutalist-monospace (HN-aesthetic): all-mono, terminal-green-on-black, ASCII art.
- **Don't** look like enterprise-AI navy-and-rounded (IBM watsonx, Azure-style): navy, oversized radii, stock photography.
- **Don't** look like AI-agent orchestrator glow (mem0.ai-style) — now the nearest neighbor by both category AND theme, so the rules are hard: no glassmorphic tiles, no pulsing or animated accent borders, no glow halos on avatars/cards, no faux-3D tile depth, no three-column "AI inbox" layouts. Glow in Memoturn is one static top-edge wash; if it moves on its own or traces an edge, it's wrong.
- **Don't** use `border-left`/`border-right` >1px as a colored accent (side stripes) — anywhere, including docs asides.
- **Don't** use gradient text, hero-metric stat blocks, or identical card grids beyond the single three-up.
- **Don't** put uppercase tracked eyebrows above section headings; the two-tone headline is the system. One deliberate kicker moment per page, maximum.
- **Don't** set lagoon `#4fb8b2` as text on light surfaces (2.4:1); light mode uses the darker `light-primary`. On-gradient soft text stays ≥92% opacity.
- **Don't** use type below 12px; meta rows are 12px mono, not 11px.
- **Don't** ship a marketing surface without product imagery. Typography-only pages are the pre-rebrand failure mode, not restraint.
- **Don't** invent gradients beyond lagoon/atoll (+ the static glow wash), add resting-surface shadows, or introduce a third typeface.
- **Don't** put coastal vocabulary in interface copy; no hype words (`revolutionary`, `unlock`, `empower`, `seamlessly`, `leverage`); no exclamation marks; no emoji in marketing copy.
- **Don't** rely on color alone for status; every status carries textual or shape redundancy.

### Concrete anti-pattern tests
- If a capture floats on the page with a drop shadow, it's a set piece, not an instrument: frame it with a hairline and dissolve or seat it instead.
- If any border glows, pulses, or animates its color, it's orchestrator-glow: delete the effect.
- If a section header has a small uppercase label above it, the two-tone headline isn't doing its job: fold the label's meaning into the muted half of the sentence.
- If teal text sits on white, check it: below 4.5:1 means it should have been `light-primary`.
- If the dark ground reads neutral-gray or pure black in a screenshot, the sea-ink tint got lost: re-check the oklch hue/chroma.
- If two consecutive sections feel the same, alternate the ground (canvas ↔ panel-mix band) or change the structure (grid ↔ ledger), not the decoration.
