import { createFileRoute } from "@tanstack/react-router";
import { TraceDetailBody } from "../../components/trace-detail";

export const Route = createFileRoute("/traces/$id")({ component: TraceDetailPage });

function TraceDetailPage() {
  const { id } = Route.useParams();
  return <TraceDetailBody traceId={id} />;
}
