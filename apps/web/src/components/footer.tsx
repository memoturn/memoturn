import { BrandMark } from "@memoturn/ui";
import { Link } from "@tanstack/react-router";

import { DOCS_PUBLIC_URL, GITHUB_URL } from "../lib/public-urls.ts";

const FOOTER_LINK_CLASS =
  "rounded-md px-2.5 py-1.5 text-[13px] font-medium text-muted-foreground no-underline transition-colors hover:bg-card hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background";

const FOOTER_LINKS = [
  { label: "Docs", href: DOCS_PUBLIC_URL },
  { label: "Getting started", href: `${DOCS_PUBLIC_URL}/getting-started/` },
  { label: "Use cases", href: `${DOCS_PUBLIC_URL}/use-cases/` },
  { label: "SDKs", href: `${DOCS_PUBLIC_URL}/sdk-typescript/` },
  { label: "Roadmap", href: `${DOCS_PUBLIC_URL}/roadmap/` },
  { label: "GitHub", href: GITHUB_URL },
];

export default function Footer() {
  const year = new Date().getFullYear();

  return (
    <footer className="border-t border-border bg-background pt-14 pb-10">
      <div className="page-wrap grid gap-6">
        <div className="flex flex-wrap items-center gap-3">
          <Link
            to="/"
            aria-label="Memoturn — home"
            className="inline-flex items-center gap-2 rounded-sm font-heading font-bold text-[17px] tracking-[-0.025em] text-foreground no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/35 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <BrandMark gradient className="size-6 shrink-0" />
            <span className="text-base uppercase tracking-[0.08em]">Memoturn</span>
          </Link>
          <span className="text-[13px] leading-relaxed text-muted-foreground">
            © {year} Memoturn. Open-source LLM observability, evals, and prompt management.
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-4 border-t border-border pt-[18px]">
          <span className="font-mono text-xs tracking-[0.04em] text-muted-foreground">Apache-2.0</span>
          <nav aria-label="Footer" className="ml-auto flex flex-wrap items-center gap-1">
            {FOOTER_LINKS.map((l) => (
              <a key={l.label} href={l.href} className={FOOTER_LINK_CLASS} target="_blank" rel="noreferrer">
                {l.label}
              </a>
            ))}
          </nav>
        </div>
      </div>
    </footer>
  );
}
