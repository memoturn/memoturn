// Consent banner for docs.memoturn.com (Consent Mode v2). Only referenced from the
// head when the site is built with PUBLIC_GA_MEASUREMENT_ID (astro.config.mjs) — the
// file ships in every build but stays unloaded otherwise. Shown to every visitor
// without a stored choice; the region-scoped consent DEFAULTS in the inline gtag
// bootstrap are what keep the EEA/UK/CH pre-choice state compliant. Styled with
// Starlight theme variables so it follows light/dark automatically.
(() => {
  const KEY = "mt-consent"; // keep in sync with apps/web/src/lib/analytics.ts
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === "granted" || stored === "denied") return;
  } catch (e) {
    return; // no storage → a choice couldn't persist; leave region defaults in charge
  }

  function choose(choice) {
    try {
      localStorage.setItem(KEY, choice);
    } catch (e) {
      /* private mode — the update below still applies to this page load */
    }
    if (typeof window.gtag === "function") {
      window.gtag("consent", "update", { analytics_storage: choice });
    }
    const el = document.getElementById("mt-consent-banner");
    if (el) el.remove();
  }

  function render() {
    const wrap = document.createElement("aside");
    wrap.id = "mt-consent-banner";
    wrap.setAttribute("aria-label", "Cookie consent");
    wrap.style.cssText =
      "position:fixed;bottom:1rem;left:1rem;z-index:100;max-width:22rem;padding:1rem;" +
      "border:1px solid var(--sl-color-hairline, #444);border-radius:0.5rem;" +
      "background:var(--sl-color-bg-nav, var(--sl-color-bg, #17181c));color:var(--sl-color-gray-2, #ccc);" +
      "font-size:0.8125rem;line-height:1.5;box-shadow:0 4px 24px rgba(0,0,0,.25)";

    const text = document.createElement("p");
    text.style.cssText = "margin:0 0 .75rem";
    text.appendChild(
      document.createTextNode(
        "We use Google Analytics to understand which pages matter and where visitors come from. No ads, no selling. ",
      ),
    );
    const link = document.createElement("a");
    link.href = "https://memoturn.com/privacy";
    link.textContent = "Privacy";
    link.style.cssText = "color:var(--sl-color-text-accent, #4fb8b2)";
    text.appendChild(link);
    wrap.appendChild(text);

    const buttons = document.createElement("div");
    buttons.style.cssText = "display:flex;gap:.5rem";
    const mkButton = (label, choice, primary) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.style.cssText =
        "padding:.35rem .85rem;border-radius:.375rem;font-size:.8125rem;cursor:pointer;" +
        (primary
          ? "border:1px solid transparent;background:var(--sl-color-text-accent, #4fb8b2);color:var(--sl-color-black, #111)"
          : "border:1px solid var(--sl-color-hairline, #444);background:transparent;color:inherit");
      b.addEventListener("click", () => {
        choose(choice);
      });
      return b;
    };
    buttons.appendChild(mkButton("Accept", "granted", true));
    buttons.appendChild(mkButton("Decline", "denied", false));
    wrap.appendChild(buttons);

    document.body.appendChild(wrap);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", render);
  } else {
    render();
  }
})();
