import { Button } from "@memoturn/ui";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { type ConsentChoice, GA_ID, getStoredConsent, setConsent } from "../lib/analytics";

/**
 * Consent Mode v2 banner. Shown to every visitor without a stored choice (we don't
 * geo-detect client-side); the region-scoped consent DEFAULTS in __root.tsx are what
 * make the EEA/UK/CH pre-choice state compliant — analytics storage stays denied there
 * until Accept. Renders nothing when analytics isn't in the build.
 */
export default function ConsentBanner() {
  // Mount-gated so SSR HTML never includes the banner (localStorage is browser-only).
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (GA_ID && getStoredConsent() === null) setOpen(true);
  }, []);

  if (!open) return null;

  const choose = (choice: ConsentChoice) => {
    setConsent(choice);
    setOpen(false);
  };

  return (
    <aside
      aria-label="Cookie consent"
      className="fixed bottom-4 left-4 z-50 max-w-sm rounded-lg border border-border bg-card p-4 shadow-lg"
    >
      <p className="mb-3 text-[13px] leading-relaxed text-muted-foreground">
        We use Google Analytics to understand which pages matter and where visitors come from. No ads, no selling.{" "}
        <Link to="/privacy" className="text-foreground underline underline-offset-2 hover:no-underline">
          Privacy
        </Link>
      </p>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => choose("granted")}>
          Accept
        </Button>
        <Button size="sm" variant="outline" onClick={() => choose("denied")}>
          Decline
        </Button>
      </div>
    </aside>
  );
}
