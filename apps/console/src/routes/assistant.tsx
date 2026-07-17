import { createFileRoute } from "@tanstack/react-router";
import { AssistantChat, useAssistantChat } from "../components/assistant-chat";
import { PageHeader } from "../components/page-header";

export const Route = createFileRoute("/assistant")({ component: AssistantPage });

function AssistantPage() {
  const chat = useAssistantChat();
  return (
    <div className="flex h-[calc(100svh-6rem)] flex-col gap-4">
      <PageHeader
        title="Assistant"
        description="Ask about your project's telemetry — the assistant queries your traces, metrics, and scores (read-only) to answer."
        help="A copilot that runs an agentic loop over memoturn's own read-only tools (traces, metrics, scores, prompts, datasets), scoped to this project. It also sees your current console context: organization, project, page, and time range."
      />
      <AssistantChat chat={chat} />
    </div>
  );
}
