/**
 * GA4 + Consent Mode v2 constants and helpers for the marketing site. The tag itself
 * (loader + inline bootstrap with the consent defaults) is injected from
 * src/routes/__root.tsx head(); this module holds what the consent banner and the
 * privacy page need at runtime.
 */

export const GA_ID = /^G-[A-Z0-9]+$/.test(import.meta.env.VITE_GA_MEASUREMENT_ID ?? "")
  ? (import.meta.env.VITE_GA_MEASUREMENT_ID as string)
  : undefined;

// Regions where analytics_storage defaults to denied until the visitor accepts
// (Consent Mode v2): EU + EEA (IS/LI/NO) + UK + CH. Keep in sync with
// apps/docs/astro.config.mjs and apps/console/src/lib/analytics.ts.
export const CONSENT_REGIONS = [
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "HU",
  "IE",
  "IT",
  "LV",
  "LT",
  "LU",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SK",
  "SI",
  "ES",
  "SE",
  "IS",
  "LI",
  "NO",
  "GB",
  "CH",
];

// localStorage key holding the visitor's explicit banner choice. Shared verbatim with
// the docs site (apps/docs/public/consent-banner.js) — but NOT cross-domain: each site
// stores its own copy, so a choice made on memoturn.com doesn't silence the docs banner.
export const CONSENT_STORAGE_KEY = "mt-consent";

export type ConsentChoice = "granted" | "denied";

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
  }
}

export function getStoredConsent(): ConsentChoice | null {
  try {
    const value = localStorage.getItem(CONSENT_STORAGE_KEY);
    return value === "granted" || value === "denied" ? value : null;
  } catch {
    return null;
  }
}

/** Persist the banner choice and apply it to the live tag. */
export function setConsent(choice: ConsentChoice): void {
  try {
    localStorage.setItem(CONSENT_STORAGE_KEY, choice);
  } catch {
    // Private mode etc. — the consent update below still applies for this page load.
  }
  window.gtag?.("consent", "update", { analytics_storage: choice });
}

/** Forget the stored choice so the banner shows again (used by the privacy page). */
export function resetConsent(): void {
  try {
    localStorage.removeItem(CONSENT_STORAGE_KEY);
  } catch {
    // ignore
  }
}
