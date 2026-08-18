import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ChevronDown, ChevronUp, Link2 } from "lucide-react";
import { useEffect } from "react";
import { toast } from "sonner";
import { TraceDetailBody } from "../../components/trace-detail";
import { Button } from "../../components/ui/button";
import { readTraceListContext } from "../../lib/trace-list-context";

export const Route = createFileRoute("/traces/$id")({
  // `observation` deep-links a span (the span explorer links here) and `view` the timeline/graph
  // mode; TraceDetailBody keeps both mirrored into the URL as the user navigates.
  validateSearch: (s: Record<string, unknown>): { observation?: string; view?: string } => ({
    observation: typeof s.observation === "string" && s.observation ? s.observation : undefined,
    view: s.view === "graph" || s.view === "log" ? s.view : undefined,
  }),
  component: TraceDetailPage,
});

function TraceDetailPage() {
  const { id } = Route.useParams();
  const { observation } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  // Prev/next stepping through the trace list the user came from (the list page records its
  // current page of ids). Absent or stale context (this id not in it) hides the controls.
  const listIds = readTraceListContext();
  const idx = listIds.indexOf(id);
  const prevId = idx > 0 ? listIds[idx - 1] : undefined;
  const nextId = idx >= 0 && idx < listIds.length - 1 ? listIds[idx + 1] : undefined;
  const goto = (traceId: string | undefined) => {
    if (traceId) navigate({ to: "/traces/$id", params: { id: traceId }, search: {} });
  };

  // J/K step traces like the peek drawer (skipped while typing in a field).
  useEffect(() => {
    if (idx < 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      if (e.key === "j") goto(nextId);
      else if (e.key === "k") goto(prevId);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-end gap-1">
        {idx >= 0 && (
          <>
            <span className="mr-1 text-xs tabular-nums text-muted-foreground">
              {idx + 1} / {listIds.length} in list
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              disabled={!prevId}
              onClick={() => goto(prevId)}
              aria-label="Previous trace (k)"
            >
              <ChevronUp />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              disabled={!nextId}
              onClick={() => goto(nextId)}
              aria-label="Next trace (j)"
            >
              <ChevronDown />
            </Button>
          </>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5"
          onClick={() => {
            navigator.clipboard
              .writeText(window.location.href)
              .then(() => toast.success("Link copied"))
              .catch(() => toast.error("Couldn’t copy the link"));
          }}
        >
          <Link2 />
          Copy link
        </Button>
      </div>
      <TraceDetailBody traceId={id} initialObservationId={observation} />
    </div>
  );
}
