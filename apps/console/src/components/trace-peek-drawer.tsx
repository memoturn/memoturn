import { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle } from "@memoturn/ui";
import { Link } from "@tanstack/react-router";
import { ChevronDown, ChevronUp, Maximize2, X } from "lucide-react";
import { useEffect } from "react";
import { TraceDetailBody } from "./trace-detail";
import { Button } from "./ui/button";

/**
 * Deep-linkable trace preview drawer, shared by the traces list and the session detail.
 * `traces` is the current list (for J/K stepping); the parent owns the `peekId` (usually a URL
 * search param) and updates it via `onPeek` (id to open, `undefined` to close).
 */
export function TracePeekDrawer({
  traces,
  peekId,
  onPeek,
}: {
  traces: { id: string }[] | undefined;
  peekId: string | undefined;
  onPeek: (id: string | undefined) => void;
}) {
  const peekIndex = peekId && traces ? traces.findIndex((t) => t.id === peekId) : -1;
  const goto = (delta: number) => {
    if (!traces || peekIndex < 0) return;
    const next = traces[peekIndex + delta];
    if (next) onPeek(next.id);
  };

  // J/K (and ↑/↓) step through the list while the drawer is open.
  useEffect(() => {
    if (!peekId || !traces) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      const idx = traces.findIndex((t) => t.id === peekId);
      if (idx < 0) return;
      const target =
        e.key === "j" || e.key === "ArrowDown"
          ? traces[idx + 1]
          : e.key === "k" || e.key === "ArrowUp"
            ? traces[idx - 1]
            : undefined;
      if (target) {
        e.preventDefault();
        onPeek(target.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [peekId, traces, onPeek]);

  return (
    <Sheet
      open={!!peekId}
      onOpenChange={(o) => {
        if (!o) onPeek(undefined);
      }}
    >
      <SheetContent
        side="right"
        showCloseButton={false}
        className="flex w-full flex-col gap-0 p-0 sm:max-w-[46rem] lg:max-w-[60rem]"
      >
        <div className="sticky top-0 z-10 flex items-center gap-2 border-b bg-background/95 px-3 py-2 backdrop-blur">
          <SheetTitle className="px-1 text-sm font-medium">Trace</SheetTitle>
          <SheetDescription className="sr-only">Trace detail preview</SheetDescription>
          <span className="hidden text-xs text-muted-foreground md:inline">
            <kbd className="rounded border bg-muted px-1 font-mono text-[0.625rem]">J</kbd>/
            <kbd className="rounded border bg-muted px-1 font-mono text-[0.625rem]">K</kbd> to navigate
          </span>
          <div className="ml-auto flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={() => goto(-1)}
              disabled={peekIndex <= 0}
              aria-label="Previous trace (k)"
            >
              <ChevronUp />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={() => goto(1)}
              disabled={peekIndex < 0 || peekIndex >= (traces?.length ?? 0) - 1}
              aria-label="Next trace (j)"
            >
              <ChevronDown />
            </Button>
            {peekId && (
              <Button asChild variant="ghost" size="icon" className="size-7" aria-label="Open full page">
                <Link to="/traces/$id" params={{ id: peekId }}>
                  <Maximize2 />
                </Link>
              </Button>
            )}
            <SheetClose asChild>
              <Button variant="ghost" size="icon" className="size-7" aria-label="Close">
                <X />
              </Button>
            </SheetClose>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-4">
          {peekId && <TraceDetailBody traceId={peekId} showBreadcrumb={false} />}
        </div>
      </SheetContent>
    </Sheet>
  );
}
