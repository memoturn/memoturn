import { createFileRoute } from "@tanstack/react-router";
import { TraceDetailBody } from "../../components/trace-detail";

export const Route = createFileRoute("/traces/$id")({
  // `observation` deep-links a span (the span explorer links here); it only seeds the initial
  // selection, after which the waterfall owns it.
  validateSearch: (s: Record<string, unknown>): { observation?: string } => ({
    observation: typeof s.observation === "string" && s.observation ? s.observation : undefined,
  }),
  component: TraceDetailPage,
});

function TraceDetailPage() {
  const { id } = Route.useParams();
  const { observation } = Route.useSearch();
  return <TraceDetailBody traceId={id} initialObservationId={observation} />;
}
