/**
 * The one place Memoturn emails are rendered.
 *
 * Every outbound email — auth links, mentions, alerts — goes through `brandedEmail` so they
 * look like one product rather than whatever each caller happened to string-concatenate.
 *
 * Design notes, from docs/brand/:
 *
 * - **Both themes are declared and styled.** Mail clients in dark mode will otherwise
 *   force-invert a light-only email, which flips the palette to colours nobody chose: a
 *   #2a7679 button with white text becomes pale mint with dark text. The `color-scheme` /
 *   `supported-color-schemes` metas tell Apple Mail and Outlook that this message handles dark
 *   itself, which suppresses that inversion; the `prefers-color-scheme` block then styles it.
 *   Both metas must live in a document <head> — declaring `color-scheme` inline on a <div> does
 *   nothing, which is exactly how the first version of this template got inverted in the wild.
 * - **Light is the base, in inline styles.** Some clients strip <style> entirely, so light must
 *   survive with no stylesheet at all. Dark rules ride in the <style> block and need
 *   `!important` to beat the inline attributes.
 * - **The accent flips with the surface.** On light it's the brand's light-mode primary
 *   `oklch(0.52 0.073 200)` = #2a7679 (5.30:1 on white) — BRAND.md forbids lagoon as text on
 *   light, where #4fb8b2 measures 2.38:1. On dark it *is* lagoon #4fb8b2 (7.91:1 on the brand
 *   near-black), which is the surface lagoon was designed for.
 * - **No external assets** — clients block remote images, so the wordmark is text, not a logo.
 * - Archivo is the brand face, but webfonts are unreliable in mail; the stack degrades to the
 *   recipient's system UI face.
 */

// Light surface (inline base).
const INK = "#0f1213"; // brand near-black
const MUTED = "#5b6668"; // 6.0:1 on white
const ACCENT = "#2a7679"; // light-mode primary — 5.30:1 on white
const RULE = "#e3e7e8";
const SURFACE = "#f7f9f9";

// Dark surface (media-query overrides). Contrast on #0f1213: text 15.9:1, muted 7.6:1,
// lagoon 7.9:1; button ink-on-lagoon 7.9:1.
const D_BG = "#0f1213";
const D_INK = "#e8edee";
const D_MUTED = "#9aa7a9";
const D_ACCENT = "#4fb8b2"; // lagoon — THE accent on dark
const D_RULE = "#2a3133";
const D_SURFACE = "#171b1c";

/**
 * Escape untrusted text for HTML. Mention emails embed a user-authored comment body, so this
 * is load-bearing, not decoration: without it a comment containing markup would be injected
 * into the message we send to someone else.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface BrandedEmail {
  /** Short headline shown above the body. */
  title: string;
  /** Lead paragraph. Plain text; escaped on the caller's behalf. */
  intro: string;
  /** Optional quoted block — e.g. the comment someone was mentioned in. */
  quote?: string;
  /** Optional call-to-action button. Both fields required together. */
  action?: { label: string; url: string };
  /** Small print under the rule (unsubscribe hints, "you can ignore this", etc.). */
  footer?: string;
}

/** Dark-mode overrides. Inline styles win on specificity, hence `!important` throughout. */
const DARK_STYLES = `
    @media (prefers-color-scheme: dark) {
      .em-body { background: ${D_BG} !important; }
      .em-wordmark, .em-title { color: ${D_INK} !important; }
      .em-text, .em-small { color: ${D_MUTED} !important; }
      .em-quote { background: ${D_SURFACE} !important; color: ${D_INK} !important; border-left-color: ${D_ACCENT} !important; }
      .em-btn { background: ${D_ACCENT} !important; color: ${D_BG} !important; }
      .em-link { color: ${D_ACCENT} !important; }
      .em-rule { border-top-color: ${D_RULE} !important; }
    }`;

/**
 * Render one email in both representations. Returns `text` and `html`; every mail client gets
 * something readable, and the text part is what lands in plain-text-only clients and in the
 * dev mailer's stderr log.
 */
export function brandedEmail(opts: BrandedEmail): { text: string; html: string } {
  const text = [
    opts.title,
    "",
    opts.intro,
    ...(opts.quote ? ["", opts.quote.replace(/^/gm, "> ")] : []),
    ...(opts.action ? ["", `${opts.action.label}: ${opts.action.url}`] : []),
    ...(opts.footer ? ["", opts.footer] : []),
  ].join("\n");

  const button = opts.action
    ? `<tr><td style="padding:24px 0 4px">
          <a class="em-btn" href="${escapeHtml(opts.action.url)}" style="display:inline-block;background:${ACCENT};color:#ffffff;text-decoration:none;padding:11px 20px;border-radius:8px;font-size:15px;font-weight:600">${escapeHtml(opts.action.label)}</a>
        </td></tr>
        <tr><td class="em-small" style="padding:12px 0 0;font-size:12px;line-height:1.5;color:${MUTED}">
          Or paste this into your browser:<br><a class="em-link" href="${escapeHtml(opts.action.url)}" style="color:${ACCENT};word-break:break-all">${escapeHtml(opts.action.url)}</a>
        </td></tr>`
    : "";

  const quote = opts.quote
    ? `<tr><td style="padding:16px 0 0">
          <div class="em-quote" style="border-left:3px solid ${ACCENT};background:${SURFACE};border-radius:0 6px 6px 0;padding:12px 14px;font-size:14px;line-height:1.6;color:${INK};white-space:pre-wrap">${escapeHtml(opts.quote)}</div>
        </td></tr>`
    : "";

  const footer = opts.footer
    ? `<tr><td style="padding:28px 0 0">
          <div class="em-rule em-small" style="border-top:1px solid ${RULE};padding-top:14px;font-size:12px;line-height:1.5;color:${MUTED}">${escapeHtml(opts.footer)}</div>
        </td></tr>`
    : "";

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(opts.title)}</title>
<style>
    :root { color-scheme: light dark; }
${DARK_STYLES}
</style>
</head>
<body class="em-body" style="margin:0;background:#ffffff;padding:32px 16px;font-family:Archivo,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:${INK}">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;margin:0 auto;width:100%">
    <tr><td class="em-wordmark" style="padding:0 0 20px;font-size:13px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${INK}">Memoturn</td></tr>
    <tr><td class="em-title" style="font-size:20px;font-weight:700;letter-spacing:-0.02em;line-height:1.25;color:${INK}">${escapeHtml(opts.title)}</td></tr>
    <tr><td class="em-text" style="padding:10px 0 0;font-size:15px;line-height:1.6;color:${MUTED}">${escapeHtml(opts.intro)}</td></tr>
    ${quote}
    ${button}
    ${footer}
  </table>
</body>
</html>`;

  return { text, html };
}
