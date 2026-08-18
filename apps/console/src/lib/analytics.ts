/**
 * GA4 (gtag.js) for the PUBLIC DEMO deployment only. Gated on VITE_GA_MEASUREMENT_ID at
 * build time — regular self-host and dev builds never define it, so no analytics code
 * runs and no third-party request is ever made.
 *
 * Deliberately gtag.js and not Google Tag Manager: the console renders user/LLM-controlled
 * trace content behind a strict CSP (infra/Caddyfile), and GTM would let anyone with
 * container access inject arbitrary scripts into that surface. gtag needs only the two
 * Google origins already allowlisted there.
 *
 * Privacy: page_views are sent manually with the query string stripped, so magic-link
 * tokens (and any other query params) never reach GA. Auto page_view is disabled.
 */
// Kept as a bare truthiness gate (no runtime validation expression) so that when the
// env var is unset, Vite inlines `undefined` and minification dead-code-eliminates the
// whole init body — the Google URL string doesn't even appear in self-host bundles.
const MEASUREMENT_ID = import.meta.env.VITE_GA_MEASUREMENT_ID as string | undefined;

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

export const analyticsEnabled = Boolean(MEASUREMENT_ID);

export function initAnalytics(): void {
  if (!MEASUREMENT_ID) return;
  if (!/^G-[A-Z0-9]+$/.test(MEASUREMENT_ID)) return;
  window.dataLayer = window.dataLayer ?? [];
  window.gtag = function gtag() {
    // GA requires the arguments object itself on the dataLayer, not an array copy.
    // biome-ignore lint/complexity/noArguments: gtag's documented bootstrap shape
    window.dataLayer?.push(arguments);
  };
  window.gtag("js", new Date());
  window.gtag("config", MEASUREMENT_ID, { send_page_view: false });
  const script = document.createElement("script");
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(MEASUREMENT_ID)}`;
  document.head.appendChild(script);
}

/** Manual page_view with the query string stripped (see module docs). */
export function trackPageView(): void {
  window.gtag?.("event", "page_view", {
    page_location: `${window.location.origin}${window.location.pathname}`,
    page_title: document.title,
  });
}

export function trackEvent(name: string, params?: Record<string, unknown>): void {
  window.gtag?.("event", name, params ?? {});
}
