import { Button, Toaster } from "@memoturn/ui";
import { createRootRoute, HeadContent, Link, Scripts } from "@tanstack/react-router";

import Footer from "../components/footer";
import Header from "../components/header";

import appCss from "../styles.css?url";

const TITLE = "Memoturn — open-source LLM observability, evals & prompt management";
const DESCRIPTION =
  "Trace every LLM call, track cost, tokens, and latency, run offline, online, and human evals, and ship versioned prompts with deployment channels. Self-hostable, OpenTelemetry-native, Apache-2.0.";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      { name: "theme-color", content: "#0f1213" },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESCRIPTION },
      { property: "og:type", content: "website" },
      { property: "og:url", content: "https://memoturn.ai" },
      { property: "og:image", content: "https://memoturn.ai/og-image.png" },
      { property: "og:image:width", content: "1200" },
      { property: "og:image:height", content: "630" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:image", content: "https://memoturn.ai/og-image.png" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
      { rel: "icon", type: "image/x-icon", href: "/favicon.ico" },
    ],
  }),
  shellComponent: RootDocument,
  errorComponent: RootErrorBoundary,
  notFoundComponent: RootNotFound,
});

function RootErrorBoundary({ error }: { error: Error }) {
  if (typeof console !== "undefined") {
    console.error("[web] route error:", error);
  }
  const detail = error?.message?.trim();
  return (
    <div className="page-wrap py-24 sm:py-32">
      <div className="mx-auto max-w-xl text-center">
        <p className="mb-3 font-mono text-xs tracking-[0.04em] text-muted-foreground">500 · unexpected</p>
        <h1 className="display-title mb-4 text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
          Something went sideways.
        </h1>
        <p className="mb-2 text-pretty text-base leading-relaxed text-muted-foreground">
          The page threw an unhandled exception. Reloading often clears it; if it doesn't, the error below tells us what
          to look at.
        </p>
        {detail ? (
          <pre className="mx-auto mb-8 mt-6 max-w-prose overflow-x-auto rounded-md border border-border bg-card px-4 py-3 text-left font-mono text-xs leading-relaxed text-muted-foreground">
            {detail}
          </pre>
        ) : null}
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button onClick={() => window.location.reload()}>Reload</Button>
          <Button asChild variant="outline">
            <Link to="/">Home</Link>
          </Button>
          <Button asChild variant="ghost">
            <a href="https://github.com/memoturn/memoturn/issues" target="_blank" rel="noreferrer">
              Open an issue
            </a>
          </Button>
        </div>
      </div>
    </div>
  );
}

function RootNotFound() {
  return (
    <div className="page-wrap py-24 sm:py-32">
      <div className="mx-auto max-w-xl text-center">
        <p className="mb-3 font-mono text-xs tracking-[0.04em] text-muted-foreground">404 · not found</p>
        <h1 className="display-title mb-4 text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
          This page doesn't exist.
        </h1>
        <p className="mb-8 text-pretty text-base leading-relaxed text-muted-foreground">
          The link might be stale, or the route moved. Try one of these instead.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button asChild>
            <Link to="/">Home</Link>
          </Button>
          <Button asChild variant="outline">
            <a href="https://docs.memoturn.ai" target="_blank" rel="noreferrer">
              Docs
            </a>
          </Button>
          <Button asChild variant="ghost">
            <a href="https://github.com/memoturn/memoturn" target="_blank" rel="noreferrer">
              GitHub
            </a>
          </Button>
        </div>
      </div>
    </div>
  );
}

function RootDocument({ children }: { children: React.ReactNode }) {
  // The marketing surface is dark-only by design (DESIGN.md): the dark
  // instrument panel IS the brand, so there is no theme toggle here.
  return (
    <html lang="en" data-theme="dark" style={{ colorScheme: "dark" }} suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body className="font-sans antialiased [overflow-wrap:anywhere] selection:bg-selection">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-full focus:border focus:border-border focus:bg-card focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-foreground focus:outline-none focus:ring-2 focus:ring-ring/30"
        >
          Skip to content
        </a>
        <Header />
        <main id="main" tabIndex={-1} className="outline-none">
          {children}
        </main>
        <Footer />
        <Toaster />
        <Scripts />
      </body>
    </html>
  );
}
