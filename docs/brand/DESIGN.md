---
name: Memoturn
description: Open-source LLM observability, evals, and prompt management
colors:
  lagoon-deep: "#328f97"
  lagoon: "#4fb8b2"
  palm: "#2f6a4a"
  ember: "#e89456"
  sea-ink: "#173a40"
  sea-ink-soft: "#416166"
  foam-light: "#f6fefb"
  foam: "#f3faf5"
  sand: "#e7f0e8"
  page: "#ffffff"
  foreground: "#252525"
  muted: "#878787"
  border: "#ebebeb"
  rule: "#173a4029"
typography:
  display:
    fontFamily: "Inter Tight, Manrope, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(48px, 7vw, 88px)"
    fontWeight: 700
    lineHeight: 1.02
    letterSpacing: "-0.025em"
  headline:
    fontFamily: "Inter Tight, Manrope, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(32px, 4vw, 48px)"
    fontWeight: 700
    lineHeight: 1.05
    letterSpacing: "-0.025em"
  title:
    fontFamily: "Inter Tight, Manrope, ui-sans-serif, system-ui, sans-serif"
    fontSize: "22px"
    fontWeight: 700
    lineHeight: 1.05
    letterSpacing: "-0.02em"
  body-large:
    fontFamily: "Manrope, ui-sans-serif, system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "normal"
  body:
    fontFamily: "Manrope, ui-sans-serif, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: "normal"
  label:
    fontFamily: "JetBrains Mono, ui-monospace, SF Mono, Menlo, Consolas, monospace"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: 1.45
    letterSpacing: "0.08em"
  mono:
    fontFamily: "JetBrains Mono, ui-monospace, SF Mono, Menlo, Consolas, monospace"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1.55
    letterSpacing: "0.02em"
rounded:
  default: "6px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
  2xl: "48px"
  3xl: "64px"
  section-y: "96px"
  section-y-tight: "64px"
  gutter: "24px"
  max-width: "1152px"
components:
  button-primary:
    backgroundColor: "{colors.sea-ink}"
    textColor: "{colors.foam-light}"
    rounded: "{rounded.default}"
    padding: "0 22px"
    height: "40px"
  button-primary-hover:
    backgroundColor: "#0e2a2f"
    textColor: "{colors.foam-light}"
  button-ghost-on-dark:
    backgroundColor: "rgba(246,254,251,0.12)"
    textColor: "{colors.foam-light}"
    rounded: "{rounded.default}"
    padding: "0 22px"
    height: "40px"
  button-ghost-on-dark-hover:
    backgroundColor: "rgba(246,254,251,0.2)"
    textColor: "{colors.foam-light}"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    padding: "0 4px"
    height: "40px"
  button-quiet-hover:
    backgroundColor: "transparent"
    textColor: "{colors.foreground}"
  button-on-dark-primary:
    backgroundColor: "{colors.foam-light}"
    textColor: "{colors.sea-ink}"
    rounded: "{rounded.default}"
    padding: "0 22px"
    height: "40px"
  button-on-dark-primary-hover:
    backgroundColor: "#ffffff"
    textColor: "{colors.sea-ink}"
  pill:
    backgroundColor: "{colors.foam}"
    textColor: "{colors.lagoon-deep}"
    rounded: "999px"
    padding: "4px 12px"
  card:
    backgroundColor: "{colors.page}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.default}"
    padding: "32px 28px 36px"
  card-hover:
    backgroundColor: "{colors.foam}"
    textColor: "{colors.foreground}"
  tag:
    backgroundColor: "rgba(50,143,151,0.10)"
    textColor: "{colors.lagoon-deep}"
    rounded: "4px"
    padding: "3px 8px"
  input:
    backgroundColor: "{colors.page}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.default}"
    padding: "8px 12px"
    height: "40px"
---

# Design System: Memoturn

## 1. Overview

**Creative North Star: "The Live Substrate"**

Memoturn is a live telemetry substrate, and the visual system says so before any copy is read. The wedge is the live capture (every LLM call traced and scored the moment it lands); the design system is built to feel that way: tight headlines that read as terminal output, hairline rules that read as ledger structure, a slow tide rotation on the brand mark that registers more like a horizon shift than a UI animation. Restraint carries it. One radius, two type faces (plus mono for code), three button shapes, a single load-bearing gradient. The discipline is the brand.

Memoturn deliberately rejects every standard AI-coding-tool aesthetic: no generic SaaS gradient-hero (Cursor, Vercel), no neon-purple-on-black (OpenAI, Replit), no monospace-brutalist (HN-aesthetic), no enterprise-AI navy-and-rounded (IBM watsonx, Azure-AI-Foundry), and no AI-agent orchestrator glow (mem0.ai-style: glassmorphic tiles on charcoal, pulsing cyan/teal accent borders, agent avatars with glow halos, "AI inbox" three-column layouts). The brand's job is to find a sixth lane. Anywhere a design move pulls toward one of those five families, redesign with different structure (not a tweak). Memoturn is the closest neighbor by category to the orchestrator-glow family, so the visual distance from it has to be the largest. The category-reflex check, run at both first and second order, must come back ambiguous.

**Key Characteristics:**
- One radius (6px). One heading face (Inter Tight 700). One body face (Manrope 400). One mono stack (JetBrains Mono).
- Four named button shapes, no fifth: filled sea-ink primary (light surfaces), on-dark primary (foam-light fill on atoll/lagoon gradients), ghost-on-dark, quiet-link.
- Lagoon → Atoll gradient is the only gradient; it is load-bearing on the brand mark and the closing band, never decorative.
- Hairline rules and tonal layering carry depth. Surface shadows are forbidden; one tiny button drop-shadow exists as a state cue, not as elevation.
- Latency is the demo. Live indicators (connection pulse, recent-turn ticker, tail of `record_turn` events) earn their place by *being* the proof; static product screenshots do not.

## 2. Colors: The Coastal Substrate

The palette runs cool with one warm counter-accent. Coastal vocabulary names the tokens (lagoon, atoll, palm, foam, sand) but never enters copy. The metaphor is felt, not stated. Every neutral runs cool toward the lagoon hue at low chroma; every accent earns its place by usage rule.

### Primary
- **Lagoon Deep** (`#328f97`): The brand color. Used as the focus ring (`--ring`), the chart-1 anchor, and the eyebrow ink across the marketing surface. The deeper of the two lagoon stops; pairs with foam-light as the only valid foreground on top of it.

### Secondary
- **Lagoon** (`#4fb8b2`): The lighter lagoon stop. Lives in the `gradient-lagoon` (135° linear, lagoon to lagoon-deep) which is the literal brand mark fill on light surfaces. Never used as a flat color; always inside the gradient or as a 1px accent on lagoon-tinted backgrounds.
- **Palm** (`#2f6a4a`): The deep green stop in `gradient-atoll` (135° linear, lagoon-deep to palm). Used only inside the atoll gradient; standalone palm fills are forbidden because they read as enterprise-green (anti-reference 4).

### Tertiary
- **Ember** (`#e89456`): The warm counter-accent. Used sparingly to break the cool field: chart-4, occasional state cues, accent markers. Never in CTAs (the brand's primary CTAs are sea-ink, not ember). The Ember Cap Rule: ember occupies less than 5% of any composition.

### Neutral
- **Sea Ink** (`#173a40`): The deepest brand ink. Foreground on light surfaces when full ink is needed (rare; the default foreground is the cooler oklch-based `foreground`). Used as the primary button fill: sea-ink on foam-light, with the foam-light reading as the hot, precise output of a dark machine.
- **Sea Ink Soft** (`#416166`): Secondary text on light surfaces, muted labels on dark surfaces, the chart-5 anchor. Use where sea-ink would feel too aggressive but muted (cooler) feels too desaturated.
- **Foam Light** (`#f6fefb`): The text and surface foreground on every dark or gradient surface. Required on the atoll-gradient closing band (gradient-on-gradient is forbidden, so the mono mark with foam-light fill is the only valid choice there).
- **Foam** (`#f3faf5`): Pale-green-tinted near-white. Used as card hover surface, eyebrow background, pill ground. The cool-of-cool: a substrate that reads as 'almost white but tipped toward the lagoon hue'.
- **Sand** (`#e7f0e8`): Warm-gray-green. Alternate section ground (the feature grid sits on sand), divider tint, secondary card ground.
- **Page** (`#ffffff`): The page substrate. Pure white, deliberately untinted. The brand's neutrals carry the warmth; the page itself stays uncompromised so the lagoon gradient pops.
- **Foreground** (`#252525`, derived from `oklch(14.5% 0 0)`): Default body text on light surfaces. Cool, neutral, full-ink. Never softened to a muted variant for body copy.
- **Muted** (`#878787`, derived from `oklch(55.6% 0 0)`): Eyebrows, captions, micro-copy, secondary metadata. Forbidden for body text.
- **Border** (`#ebebeb`, derived from `oklch(92.2% 0 0)`): Card borders, input strokes, header separator. The visible boundary; not for hairline structure (use the rule color instead).
- **Rule** (`#173a4029`, sea-ink at 16% alpha): The hairline structural rule used in tables, ledger grids, and dashed dividers inside cards. Distinct from `border`: rule carries structure, border carries containment.

### Named Rules
**The Lagoon-Atoll Rule.** The two named gradients (`gradient-lagoon`: lagoon to lagoon-deep, and `gradient-atoll`: lagoon-deep to palm) are the only gradients permitted in the system. Any other gradient (radial blur, cyan-to-magenta, dark hero overlay) is forbidden. The lagoon gradient is the brand mark fill; the atoll gradient is the inverted band substrate. They are load-bearing, never decorative.

**The Ember Cap Rule.** Ember (`#e89456`) covers less than 5% of any composition. Use it for chart accents, accent markers, and occasional state cues. Forbidden as a CTA fill, as a body text color, or as a section ground.

**The Page-White Choice.** The page substrate is pure `#ffffff`, not a tinted near-white. This is deliberate: the cool neutrals (foam, sand, foam-light) carry the lagoon-tinted warmth; the page itself stays neutral so the lagoon gradient and the brand mark register at full saturation.

**The Foam-Light-On-Dark Rule.** On any surface darker than the lagoon stops (sea-ink, atoll gradient, lagoon gradient), the only valid foreground is foam-light (`#f6fefb`). Never use the gradient mark on these surfaces; switch to the mono variant with foam-light fill.

## 3. Typography: One Heading Face, One Body Face, One Mono

**Display Font:** Inter Tight (with Manrope, ui-sans-serif, system-ui, sans-serif as fallbacks)
**Body Font:** Manrope (with ui-sans-serif, system-ui, sans-serif as fallbacks)
**Label / Mono Font:** JetBrains Mono (with ui-monospace, SF Mono, Menlo, Consolas as fallbacks)

**Character:** Inter Tight is run tight (line-height 1.02 to 1.05, letter-spacing -0.025em) so headlines read as machine output, not editorial composition. Manrope at full ink carries body copy without softening; the muted variant is reserved for eyebrows and metadata. JetBrains Mono is the only mono surface and it appears anywhere precision matters (binding names, code, terminal output, mono eyebrows).

### Hierarchy
- **Display** (Inter Tight 700, `clamp(48px, 7vw, 88px)`, line-height 1.02, tracking -0.025em): Hero headlines on the marketing surface. One per page.
- **Headline** (Inter Tight 700, `clamp(32px, 4vw, 48px)`, line-height 1.05, tracking -0.025em): Section headlines. The "Three legs. One substrate." voice.
- **Title** (Inter Tight 700, 22px, line-height 1.05, tracking -0.02em): Card titles, smaller heading slots. Same face and weight as headline; difference is scale only.
- **Body Large** (Manrope 400, 18px, line-height 1.55): Hero subheads and lede copy. The bridge between display and body.
- **Body** (Manrope 400, 16px, line-height 1.6): All running copy. Capped at 65 to 75ch line length per the shared design law.
- **Label** (JetBrains Mono 500, 11px, line-height 1.45, tracking 0.08em, uppercase): Eyebrows on every section, table column headers, mono utility text. The brand's tracked-uppercase signature.
- **Mono** (JetBrains Mono 500, 13px, line-height 1.55, tracking 0.02em): Inline code, package names, file paths, license abbreviations. Lower-case where it matches the source (e.g. `apps/api`, `wrangler.toml`).

### Named Rules
**The Tight-Set Rule.** Headlines use line-height 1.02 to 1.05 and letter-spacing -0.025em (display) or -0.02em (title). Loosening these for "breathing room" is forbidden. The tight set is what makes Inter Tight read as a machine voice, not as a magazine.

**The Em-Dash Exception.** Memoturn copy uses spaced em-dashes (` — `) in headlines and CTAs as a brand rhythm: `Get started — free`, `Memoturn — real-time AI memory & context`. This is a documented exception to the shared design law; substitute hyphens or other punctuation in interface copy is forbidden. The em-dash carries the brand voice; removing it neutralizes the rhythm.

**The Two-Face Rule.** The system uses Inter Tight (heading) and Manrope (body) plus JetBrains Mono (code/labels). A third typeface is forbidden. Italics are not part of the system; any italic copy is a flag to revise.

**The Full-Ink Body Rule.** Body copy on light surfaces uses full foreground ink (`#252525`), not the muted variant. Muted is for eyebrows, captions, and metadata only. Softening body to muted is forbidden.

## 4. Elevation: Flat-By-Default, Hairlines For Structure

The system is flat at rest. Depth comes from hairline rules (1px lines at sea-ink 16% alpha) and tonal layering (`page` to `foam` to `sand` running cool, each step slightly more saturated). Resting surfaces (cards, sections, banners, callouts) have no shadow.

Two narrow exceptions:

1. **The button cue.** A 1px-tight shadow on the primary button: `0 1px 2px rgba(0, 0, 0, 0.06)`. This is not elevation. It is a state cue that signals "this is a clickable, raised affordance." The shadow is so tight that it reads as a hairline below the button, not a halo. Hover may darken to `0 2px 4px rgba(23, 58, 64, 0.12)` for a barely-perceptible lift.

2. **Overlays.** Components that float above the page (modal/dialog content, popover, sheet, tooltip, hover-card, dropdown content, command palette) get a functional shadow because that is how they read as on top of the page rather than embedded in it. The shadow's job is affordance, not decoration. Use the existing Tailwind shadow scale (`shadow-md` for popover/tooltip, `shadow-lg` for modal/dialog/sheet); do not introduce custom shadow values.

### Shadow Vocabulary
- **Button cue** (`box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06)`): Applied to `button-primary` only. Hover state may darken to `0 2px 4px rgba(23, 58, 64, 0.12)`.
- **Overlay shadows** (`shadow-md` / `shadow-lg`): Applied to floating components only. Forbidden on resting surfaces.

### Named Rules
**The Flat-By-Default Rule.** Resting surfaces (cards, sections, banners, callouts, panels) have no shadow. Depth is achieved via hairline rules, ground tones, and content rhythm. Adding a shadow to a resting surface is forbidden without explicit reason. Overlays (modal, dialog, popover, sheet, tooltip, hover-card, dropdown content) are exempt: they get a functional shadow because elevation IS their meaning.

**The Hairline Rule.** 1px hairlines at sea-ink 16% alpha (`#173a4029`, the `rule` token) carry structure inside cards (dashed bottom borders on tag rows), tables (top + bottom borders + dashed row separators), and the ledger grid. These are not the same as `border` (`#ebebeb`), which is for component containment. Rule = structure inside; border = containment around.

**The Tonal-Step Rule.** Backgrounds run page (`#ffffff`) to foam (`#f3faf5`) to sand (`#e7f0e8`). Each step adds slight cool warmth and subtracts a hair of luminance. Depth comes from the step itself; never add a shadow on top of the step to "reinforce" it.

## 5. Components

Every component announces what it is. Names ARE the spec: `button-primary`, `button-ghost-on-dark`, `button-quiet`, `feature-card`, `pill`, `tag`, `license-row`. The naming is mechanical and the variants are explicit. A fourth button shape, a second pill style, or a card variant outside the named set is forbidden without explicit reason. The character is mechanical and named.

### Buttons

Three shapes for light surfaces, plus one dedicated dark-surface primary. Total of four named variants, no fifth.

- **Shape:** 6px radius (`rounded.default`). Height 40px. Padding 0 22px. Inter face: Manrope 500 / 14px / line-height 1. Single-line; never wrap.
- **Primary (filled sea-ink):** Background `sea-ink` (`#173a40`), text `foam-light` (`#f6fefb`). One drop-shadow cue (`0 1px 2px rgba(0, 0, 0, 0.06)`). Hover darkens background to `#0e2a2f`. Used for the highest-priority CTA on light surfaces (`Get started — free`, `Create your project`).
- **Ghost-on-dark:** Background `rgba(246, 254, 251, 0.12)`, border 1px `rgba(246, 254, 251, 0.4)`, text `foam-light`. Hover: background to 0.2, border to 0.6. Used only on atoll-gradient or lagoon-gradient surfaces as the secondary CTA next to the on-dark primary. Forbidden on light surfaces.
- **On-dark primary (foam-light fill):** Background `foam-light` (`#f6fefb`), text `sea-ink` (`#173a40`). Hover lightens background to pure `#ffffff`. Used only on atoll-gradient surfaces (currently: every closing band). Necessary because filled sea-ink on the lagoon-deep midpoint of the atoll gradient fails AA contrast; the foam-light variant is the AA-safe inversion. Forbidden on light surfaces.
- **Quiet link:** Background transparent, text `muted` (`#878787`), padding 0 4px. Includes a `→` arrow that translates 3px right on hover. Hover: text to `foreground`, arrow stays. Used for the secondary CTA in the hero (`Read the docs`).

### Pills

Used sparingly. Status indicators above the hero headline (`Open source`).

- **Shape:** Fully rounded (`999px`). Padding `4px 12px`. Single line.
- **Style:** Background `foam` (`#f3faf5`), border 1px `rgba(50, 143, 151, 0.32)`, text `lagoon-deep`. Type: Manrope 500 / 11px / tracking 0.08em / uppercase.
- **State:** Static. Never animated, never hovered. The pill is a label, not a control.

### Feature Cards (Ledger Cards)

Three-card grids only. Same visual structure across cells (eyebrow, title, body, tag chips); different content carries the variation. The ledger arrangement (sand background under, hairline rule grid surrounding white cards) is the rare-but-earned exception to the shared identical-card-grid prohibition.

- **Corner Style:** 6px radius on the outer container; cells share hairline-rule borders, no internal radius.
- **Background:** Card cells are `page` white. Hover ground transitions to `foam`. The grid sits on `sand` with a topographic ring pattern at 6% opacity (the `pattern-topo` motif).
- **Border / Rule:** Hairline 1px rule (`#173a4029`) on the grid's top and left edges, plus on every cell's right and bottom edges. No box-shadow.
- **Internal Padding:** `32px 28px 36px`. Vertical asymmetry deliberate (more breathing room below the tag chips).
- **Content:** Mono eyebrow (Manrope 500 / 11px tracked uppercase, lagoon-deep) → title (Inter Tight 700 / 22px / -0.02em / sea-ink) → body (Manrope 400 / 14.5px / line-height 1.6 / sea-ink-soft) → tag row (mono chips on `rgba(50, 143, 151, 0.10)` ground, dashed top hairline above).

### Tags

Inline labels inside cards (binding names like `Workers`, `Vectorize`, `MCP`).

- **Shape:** 4px radius. Padding `3px 8px`.
- **Style:** Background `rgba(50, 143, 151, 0.10)`, text `lagoon-deep`. Type: JetBrains Mono 500 / 11px / tracking 0.02em.
- **State:** Static. Tags label, they don't act.

### Inputs

The dashboard uses inputs but the marketing surface mostly does not. Documented for the product register.

- **Shape:** 6px radius. Height 40px. Padding 8px 12px.
- **Style:** Background `page`, text `foreground`, border 1px `border` (`#ebebeb`). Focus: border to `lagoon-deep`, ring `lagoon-deep` at 30% alpha (`box-shadow: 0 0 0 2px ...`). The shared button shadow does NOT apply to inputs.
- **Error / Disabled:** Error border ember; text remains foreground (no color-only signaling). Disabled background `foam`, text muted at 60%.

### Navigation

Sticky header with three slots: brand-lockup, primary nav, utility cluster.

- **Style:** Background `rgba(255, 255, 255, 0.92)`, backdrop-filter `saturate(140%) blur(14px)`, border-bottom 1px `border`.
- **Brand-lockup:** Inline mark (24px, gradient variant on light, mono on dark) + wordmark (Inter Tight 700 / 17px / -0.025em / 8px gap). The wordmark is set in the heading face at full weight — the one place the brand name outweighs the headings around it.
- **Primary nav links:** Manrope 500 / 14px / muted. Hover: foam ground, foreground text. Active page (`aria-current="page"`): foam ground, foreground text (matches hover).
- **Utility:** Theme toggle (mono 13px, transparent ground), sign-in (Manrope 500 / 14px, 1px border, foam hover ground).
- **Mobile:** Same structure; padding compresses on viewport < 960px.

### Brand Mark

The signature component. Concentric / topo: outer ring (r 54 to 40), middle ring (r 34 to 20), center disc (r 8). Filled, two variants.

- **Gradient variant (`logo.svg`):** Lagoon gradient inline. Used on light surfaces (page, foam, sand).
- **Mono variant (`logo-mono.svg`):** `currentColor` fill. Used on dark or gradient surfaces (sea-ink, atoll, lagoon) with `color: var(--foam-light)`.
- **Behavior:** Slow rotation 360° over 8000ms on hover, eased with `cubic-bezier(0.16, 1, 0.3, 1)` (`ease-tide`). The motion is glacial, more horizon-shift than UI animation.
- **Implementation:** Inline SVG via `<symbol>` + `<use>` library at the top of every document body. CSS `mask-image` from a URL is forbidden because file:// rendering inconsistencies bite (Safari especially). Inline `<use>` is mandatory.
- **prefers-reduced-motion:** Tide rotation suppressed. The mark may still hover-respond via color or a 1.02 scale, but the 8s rotation is removed.

### Named Rules
**The Four-Shapes Rule.** Four button shapes total: filled sea-ink primary (light surfaces), ghost-on-dark (atoll/lagoon gradient secondary), on-dark primary (atoll/lagoon gradient primary, foam-light fill), quiet-link (any surface secondary). A fifth shape is a flag to revise; if a fifth seems necessary, the design wanted a different component.

**The Inline-Mark Rule.** The brand mark is rendered via inline `<svg>` and `<use href="#memoturn-mark-{gradient|mono}"/>`. CSS `mask-image: url(...)` and `<img src="logo.svg">` are both forbidden in production because they fail in different ways: mask-image fails silently on file:// and in restrictive sandboxes; `<img>` cannot inherit `currentColor`. The inline-symbol pattern is the only correct path.

**The Card-Grid-Three-Only Rule.** Identical card grids are forbidden by the shared design law. Memoturn permits a single exception: the three-leg feature grid (real-time / cross-tool / hybrid-search on landing). Three is the only valid count; four-up grids and six-up grids are forbidden.

## 6. Do's and Don'ts

The strategic line from PRODUCT.md carries through here verbatim. Every anti-reference in PRODUCT.md is repeated as a Don't. Every visual rule in this DESIGN.md is repeated as a Do. The voice is that of a design director: forceful, exact.

### Do:
- **Do** lead with mechanism. Name the store (ClickHouse, Postgres, Redis, blob), the transport (OTLP, MCP, webhooks), the package (`apps/api`, `apps/worker`, `packages/core`). Specificity is what the Multi-tool Builder trusts.
- **Do** hold the page substrate pure white (`#ffffff`). The neutrals (foam, sand) carry the warmth.
- **Do** use the lagoon (`gradient-lagoon`) and atoll (`gradient-atoll`) gradients only as the brand mark fill and the inverted band substrate. They are load-bearing, not decorative.
- **Do** keep headlines tight: line-height 1.02 to 1.05, letter-spacing -0.025em to -0.02em. The tight set is the brand voice.
- **Do** use spaced em-dashes (` — `) in headlines and CTAs (`Get started — free`). The em-dash is a documented brand exception to the shared no-em-dash law; it carries voice.
- **Do** render the brand mark inline via `<symbol>` + `<use>`. Never via CSS `mask-image: url(...)` and never via `<img src=...>`.
- **Do** use foam-light (`#f6fefb`) as the only foreground on sea-ink, atoll gradient, and lagoon gradient surfaces.
- **Do** signal real-time somewhere on every page. Present-tense mechanical verbs ("captured", "fanned", "matched") in copy; tiny live indicators (a connection pulse, a recent-turn ticker) in UI. Static product screenshots do not earn their place.
- **Do** use the four button shapes only: filled sea-ink primary (light surfaces), on-dark primary (foam-light fill on atoll/lagoon gradients), ghost-on-dark (atoll/lagoon gradient secondary), quiet-link (any surface secondary). A fifth shape is a flag to revise the design.
- **Do** honor `prefers-reduced-motion` on the 8s tide rotation. The mark may still color-shift on hover; the rotation is suppressed.
- **Do** test the category-reflex check at both altitudes. The first-order answer (domain → palette) must come back ambiguous. The second-order answer (domain + anti-references → aesthetic family) must also come back ambiguous.

### Don't:
- **Don't** look like generic SaaS gradient-hero (Cursor.com, Vercel-style). Big gradient hero, drop-shadowed product screenshot, identical 3-icon feature cards, "Trusted by" YC-logo strip. The dominant cliche of the category. Avoid it by name.
- **Don't** look like AI-product neon-purple-on-black (OpenAI, Replit-style). Cyberpunk dark mode, glowing edges, neural-net imagery, "the future of coding" positioning.
- **Don't** look like developer-tool brutalist-monospace (HN-aesthetic). All-monospace, terminal-green-on-black, ASCII art, "NO JS" banners.
- **Don't** look like enterprise-AI navy-and-rounded (IBM watsonx, Azure-AI-Foundry-style). Navy blue, oversized rounded corners, stock photo of a hand on a glass touchscreen.
- **Don't** look like AI-agent orchestrator glow ([mem0.ai](https://mem0.ai)-style; the saturating family in the agent-memory / agent-platform space). Glassmorphic tiles on a near-black or charcoal panel, pulsing animated accent borders in cyan / magenta / teal, agent avatars or cards with glow halos, faux-3D depth on every tile, "agent activity" feeds with status dots, three-column "AI inbox" layouts. Memoturn is mem0.ai's nearest neighbor by category, so the visual distance must be the largest of any anti-reference. If the two surfaces could be confused at a glance, redesign.
- **Don't** use `border-left` or `border-right` greater than 1px as a colored accent on cards, alerts, or callouts. Side-stripe borders are forbidden by the shared design law and the brand inherits that prohibition. Replace with full borders, background tints, leading numbers or icons, or nothing.
- **Don't** use gradient text (`background-clip: text` on a gradient background). Use a single solid color. Emphasis through weight or scale only.
- **Don't** apply box-shadows to resting surfaces (cards, sections, banners, callouts, panels). The system is flat by default. The 1px button-cue is the only shadow on a resting surface; overlays (modal, dialog, popover, sheet, tooltip, hover-card, dropdown content) are exempt because elevation IS their meaning.
- **Don't** add a fifth button shape. The four named shapes (filled sea-ink primary, on-dark primary, ghost-on-dark, quiet-link) are the spec. A fifth shape means the design wanted a different component.
- **Don't** soften body copy to muted (`#878787`). Body uses full ink (`foreground`). Muted is for eyebrows, captions, metadata.
- **Don't** introduce a third typeface. Inter Tight (heading) + Manrope (body) + JetBrains Mono (code/labels) is the system. Italics are not part of the system; treat italic copy as a flag to revise.
- **Don't** put coastal vocabulary (`tide`, `lagoon`, `atoll`, `swell`, `foam`, `sand`) in interface copy. The metaphor lives in token names; the prose stays in product language.
- **Don't** use hype words: `revolutionary`, `next-generation`, `cutting-edge`, `game-changing`, `unlock`, `empower`, `seamlessly`, `leverage`, `best-in-class`. None of these earn their place.
- **Don't** use exclamation marks in marketing copy. None.
- **Don't** use emojis in marketing surface copy. CLI / status output may use one of `▲ ⚓ ✓` if functional. Nothing else.
- **Don't** invent additional gradients. The lagoon and atoll gradients are the spec. A radial blur, a cyan-magenta wash, or a dark hero overlay is forbidden.
- **Don't** use ember (`#e89456`) as a CTA fill or section ground. Ember is capped at < 5% of any composition; it is for chart accents, accent markers, and occasional state cues.
- **Don't** rely on color alone for status. Every status (license type, error, success) carries a textual or shape redundancy.
- **Don't** ship a card grid with more than three cells. Memoturn's identical-card-grid exception is three only.

### Concrete anti-pattern tests
- If a card has a colored 3px border on its left edge, the layout is wrong. Remove the stripe; use a full hairline border or a tint instead.
- If two consecutive sections feel the same, increase `section-y` on one or change ground tone (page → foam → sand).
- If a hero shows a drop-shadowed product screenshot, redesign without the screenshot. The wedge ("see every LLM call, on infrastructure you own") carries the hero by typography alone.
- If a feature card grid has the same visual weight in every cell, the content is not earning the grid. Either tighten to two cells, or vary the content density per cell.
- If a button's shadow is wider than 4px or extends below 4px down, it is not a Memoturn button. The single permitted shadow is 0 1px 2px rgba(0, 0, 0, 0.06).
- If a heading is set above letter-spacing -0.015em, it is too loose. The brand voice requires the tight set.
