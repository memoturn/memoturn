import type { Comment } from "@memoturn/contracts";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { AtSign } from "lucide-react";
import { EmptyState } from "../components/empty-state";
import { PageHeader } from "../components/page-header";
import { Card, CardContent } from "../components/ui/card";
import { Skeleton } from "../components/ui/skeleton";
import { api } from "../lib/api";

export const Route = createFileRoute("/mentions")({ component: MentionsPage });

/**
 * Where a commented-on object lives in the console, or null when it has no standalone page.
 *
 * Case-insensitive because `objectType` is free-form on the wire and the trace view posts it
 * uppercase ("TRACE"). Kept deliberately in step with `objectPath()` in
 * packages/server/src/notifications.ts — the mention email and this list must agree on where a
 * mention points, and observations have no page of their own (they render inside their trace).
 */
function objectLink(objectType: string, objectId: string): string | null {
  switch (objectType.toLowerCase()) {
    case "trace":
      return `/traces/${encodeURIComponent(objectId)}`;
    case "session":
      return `/sessions/${encodeURIComponent(objectId)}`;
    case "prompt":
      return `/prompts/${encodeURIComponent(objectId)}`;
    default:
      return null;
  }
}

function MentionRow({ mention }: { mention: Comment }) {
  const href = objectLink(mention.objectType, mention.objectId);
  const when = mention.createdAt.slice(0, 16).replace("T", " ");

  return (
    <Card>
      <CardContent className="space-y-2 py-4">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
          <span className="font-medium">{mention.author}</span>
          <span className="text-muted-foreground">mentioned you on a {mention.objectType.toLowerCase()}</span>
          <span className="ml-auto font-mono text-xs text-muted-foreground">{when}</span>
        </div>
        <p className="text-sm whitespace-pre-wrap text-muted-foreground">{mention.content}</p>
        {href ? (
          <Link to={href} className="inline-block text-sm font-medium text-primary hover:underline">
            Open {mention.objectType.toLowerCase()} →
          </Link>
        ) : (
          // No console route for this object type — show the id so it's still traceable by hand.
          <p className="font-mono text-xs text-muted-foreground">{mention.objectId}</p>
        )}
      </CardContent>
    </Card>
  );
}

function MentionsPage() {
  const { data: mentions, isPending } = useQuery({
    queryKey: ["my-mentions"],
    queryFn: () => api.listMyMentions(),
  });

  return (
    <div>
      <PageHeader
        title="Mentions"
        description="Comments in this project where a teammate @mentioned you, newest first."
        help="Mentions are project-scoped — switch projects to see mentions elsewhere. Email for new mentions is controlled in Settings → Notifications."
      />
      {isPending ? (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : !mentions?.length ? (
        <EmptyState
          icon={AtSign}
          title="No mentions yet"
          description="When a teammate @mentions you in a comment on a trace, session, or prompt, it shows up here."
        />
      ) : (
        <div className="space-y-3">
          {mentions.map((m) => (
            <MentionRow key={m.id} mention={m} />
          ))}
        </div>
      )}
    </div>
  );
}
