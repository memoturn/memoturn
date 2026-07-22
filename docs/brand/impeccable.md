---
authored_by: pointer
author_date: 2026-05-02
source: "stardust/impeccable contract bridge"
strength: pointer
canonical: BRAND.md, DESIGN.md, DESIGN.json
---

# Memoturn — Design Personality (pointer)

> **This file is a pointer.** The canonical design personality and visual system live in [BRAND.md](BRAND.md) and [DESIGN.md](DESIGN.md) (with the machine-readable extensions in [DESIGN.json](DESIGN.json)). Every `/impeccable` command reads those files. This pointer exists so legacy tooling that expects `.impeccable.md` (the stardust skill family, in particular) finds an artifact at the project root and does not silently re-synthesize a fresh weak personality.
>
> If you migrated from `.impeccable.md` to `PRODUCT.md` and a stardust skill auto-renamed it back, that's the loader behavior; the canonical content remains in `PRODUCT.md` regardless of which filename is on disk.

## Quick reference (canonical: see PRODUCT.md / DESIGN.md)

**Register:** `brand`. The marketing surface is the primary register; the console product surface is secondary, but voice rules extend into it (see BRAND.md "Voice").

**Three-word personality:** dark, precise, live.

**CTA hierarchy:** primary CTA is the getting-started guide (`docs.memoturn.ai/getting-started/`), secondary is GitHub (`github.com/memoturn/memoturn`).

**Anti-references (any of these = redesign with different structure):**
1. Generic SaaS gradient-hero (Cursor.com, Vercel-style).
2. AI-product neon-purple-on-black (OpenAI, Replit-style).
3. Developer-tool brutalist-monospace (HN-aesthetic).
4. Enterprise-AI navy-and-rounded (IBM watsonx, Azure-AI-Foundry-style).
5. AI-agent orchestrator glow (mem0.ai-style; the saturating family in the LLM-tooling / agent-platform space). Memoturn's nearest neighbor by category, so the largest visual distance.

**Six strategic principles:**
1. Lead with mechanism, not metaphor.
2. Conversion is the test.
3. Find the sixth lane.
4. Latency is the demo.
5. Restraint is the visual gesture.
6. The product surface is part of the brand.

**Visual essentials (canonical: DESIGN.md, dark-first as of 2026-07):**
- Dark instrument panel: sea-ink-tinted near-black canvas (`oklch(0.146 0.012 215)`), marketing dark-only, docs default dark + light reading mode.
- One family: Archivo variable (display = 700 @ `font-stretch: 110%`, `-0.03em`) + JetBrains Mono. One radius (6px).
- Two-tone headlines (bright phrase + muted elaboration) replace eyebrow kickers as section grammar.
- Real console captures (`bun run screenshots`, dark, @2x) are required imagery: hero dashboard + matching capture per feature card, hairline-framed with the static lagoon glow (`--glow-lagoon`; never pulsing, never glass).
- Four button shapes: foam-fill primary (dark canvas), outline, on-gradient primary/secondary (+ quiet-link).
- Lagoon → Atoll gradient is the only gradient. Load-bearing on the brand mark + closing band.
- Hairline rules + tonal layering carry depth. Resting-surface shadows are forbidden.
- Em-dashes spaced (` — `) survive in running copy only; headlines break with periods.
- Inline `<svg>` + `<use>` for the brand mark; never `<img src="logo.svg">` and never `mask-image: url(...)`.

**Accessibility floor:** WCAG 2.2 AA (incl. light-mode `--primary` darkened for 4.5:1 text) + `prefers-reduced-motion` honored on the tide rotation, rise-in, and glow fade.

## Why this file exists

The stardust pipeline was authored before `/impeccable` introduced the split between strategic and visual design docs. Stardust's brand skill checks for an `.impeccable.md` artifact to decide whether to synthesize a weak design-personality fallback. This pointer satisfies the existence check; downstream skills that read its content find the same rules echoed in the canonical BRAND.md / DESIGN.md, with this file naming the canonical sources in its frontmatter.

To update the design personality, edit `BRAND.md` (voice/strategic) or `DESIGN.md` (visual). Do not edit this pointer; re-running `/impeccable teach` or `/impeccable document` regenerates the canonical files but leaves this pointer untouched.
