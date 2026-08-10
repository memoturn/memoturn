/**
 * The one place Memoturn emails are rendered.
 *
 * Every outbound email — auth links, mentions, alerts — goes through `brandedEmail` so they
 * look like one product rather than whatever each caller happened to string-concatenate.
 *
 * Design notes, from docs/brand/:
 * - Emails render on a LIGHT surface. The marketing site is dark-first, but mail clients
 *   compose against their own background and forced-dark inversion mangles dark templates,
 *   so we commit to light and declare `color-scheme: light`.
 * - The accent is the brand's LIGHT-mode primary `oklch(0.52 0.073 200)` = #2a7679, not the
 *   dark-surface lagoon. BRAND.md is explicit that lagoon must never be text on a light
 *   surface: #4fb8b2 is 2.38:1 on white and #328f97 is 3.81:1 — both fail AA. #2a7679 is
 *   5.30:1, so links and button labels clear 4.5:1.
 * - Archivo is the brand face but web fonts are unreliable in mail; the stack degrades to the
 *   recipient's system UI face rather than shipping a webfont nobody will load.
 * - Inline styles only, and no external assets — mail clients strip <style> blocks and block
 *   remote images by default. The wordmark is text, not an image, so it always renders.
 */

/** Brand palette, resolved for a light email surface. */
const INK = "#0f1213"; // brand near-black, body text
const MUTED = "#5b6668"; // secondary text — 6.0:1 on white
const ACCENT = "#2a7679"; // light-mode primary — 5.30:1 on white
const RULE = "#e3e7e8";
const SURFACE = "#f7f9f9";

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
          <a href="${escapeHtml(opts.action.url)}" style="display:inline-block;background:${ACCENT};color:#ffffff;text-decoration:none;padding:11px 20px;border-radius:8px;font-size:15px;font-weight:600">${escapeHtml(opts.action.label)}</a>
        </td></tr>
        <tr><td style="padding:12px 0 0;font-size:12px;line-height:1.5;color:${MUTED}">
          Or paste this into your browser:<br><a href="${escapeHtml(opts.action.url)}" style="color:${ACCENT};word-break:break-all">${escapeHtml(opts.action.url)}</a>
        </td></tr>`
    : "";

  const quote = opts.quote
    ? `<tr><td style="padding:16px 0 0">
          <div style="border-left:3px solid ${ACCENT};background:${SURFACE};border-radius:0 6px 6px 0;padding:12px 14px;font-size:14px;line-height:1.6;color:${INK};white-space:pre-wrap">${escapeHtml(opts.quote)}</div>
        </td></tr>`
    : "";

  const footer = opts.footer
    ? `<tr><td style="padding:28px 0 0">
          <div style="border-top:1px solid ${RULE};padding-top:14px;font-size:12px;line-height:1.5;color:${MUTED}">${escapeHtml(opts.footer)}</div>
        </td></tr>`
    : "";

  const html = `<div style="color-scheme:light;background:#ffffff;padding:32px 16px;font-family:Archivo,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:${INK}">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;margin:0 auto;width:100%">
    <tr><td style="padding:0 0 20px;font-size:13px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${INK}">Memoturn</td></tr>
    <tr><td style="font-size:20px;font-weight:700;letter-spacing:-0.02em;line-height:1.25;color:${INK}">${escapeHtml(opts.title)}</td></tr>
    <tr><td style="padding:10px 0 0;font-size:15px;line-height:1.6;color:${MUTED}">${escapeHtml(opts.intro)}</td></tr>
    ${quote}
    ${button}
    ${footer}
  </table>
</div>`;

  return { text, html };
}
