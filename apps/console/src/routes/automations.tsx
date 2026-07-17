import { createFileRoute } from "@tanstack/react-router";
import { AutomationsPanel } from "../components/automations-panel";
import { PageHeader } from "../components/page-header";

export const Route = createFileRoute("/automations")({ component: AutomationsPage });

function AutomationsPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Automations"
        description="React to events as they happen: run a webhook or Slack message when a score is recorded, a trace is created, or an evaluation completes. Unlike Monitors (which watch metrics over a window), automations fire on the ingest event stream."
        help="Event-driven actions — trigger a webhook or chat message the moment a score/trace/eval event fires, optionally gated by a score threshold or a name filter."
      />
      <AutomationsPanel />
    </div>
  );
}
