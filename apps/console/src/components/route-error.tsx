import type { ErrorComponentProps } from "@tanstack/react-router";
import { Link } from "@tanstack/react-router";
import { Home, RefreshCw, RotateCcw, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Logo } from "./logo";
import { Button, buttonVariants } from "./ui/button";

/**
 * A dynamic-import failure almost always means a new build was deployed while the tab was
 * open (the old chunk hashes no longer resolve), OR a chunk was cached mid-deploy. The fix is
 * a reload onto the fresh index.html — so we surface that as the primary action, not a stack
 * trace the user can't act on.
 */
function isStaleChunkError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error ?? "");
  return /dynamically imported module|Loading chunk|Importing a module script failed|error loading dynamically imported module/i.test(
    msg,
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-svh place-items-center bg-background px-6 py-12 text-foreground">
      <div className="w-full max-w-lg text-center">{children}</div>
    </div>
  );
}

/** Router-level error boundary — replaces TanStack Router's bare default. */
export function RouteErrorComponent({ error, reset }: ErrorComponentProps) {
  const stale = isStaleChunkError(error);
  const message = error instanceof Error ? error.message : String(error ?? "Unknown error");
  const stack = error instanceof Error ? error.stack : undefined;

  return (
    <Shell>
      <div className="mx-auto mb-6 flex size-14 items-center justify-center rounded-2xl border border-border bg-card">
        {stale ? (
          <RefreshCw className="size-6 text-primary" aria-hidden />
        ) : (
          <TriangleAlert className="size-6 text-amber-500" aria-hidden />
        )}
      </div>

      <h1 className="text-xl font-semibold tracking-tight">
        {stale ? "A new version is available" : "Something went wrong"}
      </h1>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
        {stale
          ? "memoturn was updated while this page was open. Reload to pick up the latest version — your place is saved."
          : "An unexpected error interrupted this page. You can retry, reload, or head back to your dashboard."}
      </p>

      <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
        {stale ? (
          <Button onClick={() => window.location.reload()} className="gap-2">
            <RefreshCw className="size-4" /> Reload
          </Button>
        ) : (
          <>
            <Button onClick={() => reset()} className="gap-2">
              <RotateCcw className="size-4" /> Try again
            </Button>
            <Button variant="outline" onClick={() => window.location.reload()} className="gap-2">
              <RefreshCw className="size-4" /> Reload page
            </Button>
          </>
        )}
        <Link to="/dashboard" className={cn(buttonVariants({ variant: "ghost" }), "gap-2")}>
          <Home className="size-4" /> Dashboard
        </Link>
      </div>

      {!stale && (
        <details className="mt-8 text-left">
          <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
            Technical details
          </summary>
          <pre className="mt-2 max-h-64 overflow-auto rounded-lg border border-border bg-muted/40 p-3 text-left text-xs text-muted-foreground">
            {message}
            {stack ? `\n\n${stack}` : ""}
          </pre>
        </details>
      )}

      <div className="mt-10 flex items-center justify-center gap-2 text-xs text-muted-foreground">
        <Logo className="size-4" />
        <span>memoturn</span>
      </div>
    </Shell>
  );
}

/** Friendly 404 for unmatched routes — replaces the bare default. */
export function RouteNotFoundComponent() {
  return (
    <Shell>
      <div className="mx-auto mb-6 flex size-14 items-center justify-center rounded-2xl border border-border bg-card">
        <Logo className="size-7" />
      </div>
      <h1 className="text-xl font-semibold tracking-tight">Page not found</h1>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
        The page you're looking for doesn't exist or may have moved.
      </p>
      <div className="mt-6 flex items-center justify-center">
        <Link to="/dashboard" className={cn(buttonVariants(), "gap-2")}>
          <Home className="size-4" /> Back to dashboard
        </Link>
      </div>
    </Shell>
  );
}
