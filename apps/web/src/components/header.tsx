import {
  BrandMark,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  ThemeToggle,
} from "@memoturn/ui";
import { Link } from "@tanstack/react-router";
import { MenuIcon } from "lucide-react";

import { DOCS_PUBLIC_URL, GITHUB_URL } from "../lib/public-urls.ts";

const NAV_LINK_CLASS =
  "inline-flex h-9 items-center rounded-md px-3 text-sm font-medium text-muted-foreground no-underline transition-colors hover:bg-foam hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background dark:hover:bg-card";

export default function Header() {
  return (
    <header className="sticky top-0 z-50 border-b border-border bg-background">
      <div className="page-wrap flex items-center gap-3.5 py-4">
        <Link
          to="/"
          aria-label="Memoturn — home"
          className="inline-flex items-center gap-2 rounded-sm font-heading font-bold text-[17px] tracking-[-0.025em] text-foreground no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/35 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <BrandMark gradient className="size-6 shrink-0" />
          <span>Memoturn</span>
        </Link>

        <nav aria-label="Primary" className="ml-3 hidden items-center gap-1 md:flex">
          <a href={DOCS_PUBLIC_URL} target="_blank" rel="noreferrer" className={NAV_LINK_CLASS}>
            Docs
          </a>
          <a href={GITHUB_URL} target="_blank" rel="noreferrer" className={NAV_LINK_CLASS}>
            GitHub
          </a>
        </nav>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Open primary navigation"
              className="ml-1 inline-flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foam hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 dark:hover:bg-card md:hidden"
            >
              <MenuIcon className="size-4" aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-48">
            <DropdownMenuItem asChild>
              <a href={DOCS_PUBLIC_URL} target="_blank" rel="noreferrer" className="no-underline">
                Docs
              </a>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="no-underline">
                GitHub
              </a>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="ml-auto flex items-center gap-1.5">
          <ThemeToggle />
          <Button asChild size="sm" className="h-9 px-4 text-sm font-medium">
            <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="no-underline">
              Get started
            </a>
          </Button>
        </div>
      </div>
    </header>
  );
}
