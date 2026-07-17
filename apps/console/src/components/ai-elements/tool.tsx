import { CheckCircleIcon, ChevronDownIcon, WrenchIcon, XCircleIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import { CodeBlock } from "./code-block";

// Ported from fold.run's ai-elements tool card, simplified for memoturn's non-streaming
// assistant: a step is either completed or errored by the time it reaches the client.

export type ToolState = "output-available" | "output-error";

export const Tool = ({ className, ...props }: ComponentProps<typeof Collapsible>) => (
  <Collapsible className={cn("group not-prose w-full rounded-md border", className)} {...props} />
);

export const ToolHeader = ({
  className,
  title,
  state,
  ...props
}: ComponentProps<typeof CollapsibleTrigger> & { title: string; state: ToolState }) => (
  <CollapsibleTrigger className={cn("flex w-full items-center justify-between gap-4 px-3 py-2", className)} {...props}>
    <div className="flex min-w-0 items-center gap-2">
      <WrenchIcon className="size-4 shrink-0 text-muted-foreground" />
      <span className="truncate font-mono text-xs font-medium">{title}</span>
      <Badge className="gap-1.5 rounded-full text-[0.625rem]" variant="secondary">
        {state === "output-available" ? (
          <CheckCircleIcon className="size-3 text-green-600" />
        ) : (
          <XCircleIcon className="size-3 text-red-600" />
        )}
        {state === "output-available" ? "Completed" : "Error"}
      </Badge>
    </div>
    <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
  </CollapsibleTrigger>
);

export const ToolContent = ({ className, ...props }: ComponentProps<typeof CollapsibleContent>) => (
  <CollapsibleContent
    className={cn(
      "space-y-3 border-t p-3 outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:slide-in-from-top-2",
      className,
    )}
    {...props}
  />
);

export const ToolInput = ({ className, input, ...props }: ComponentProps<"div"> & { input: unknown }) => (
  <div className={cn("space-y-1.5 overflow-hidden", className)} {...props}>
    <h4 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Parameters</h4>
    <CodeBlock code={JSON.stringify(input, null, 2)} language="json" />
  </div>
);

export const ToolOutput = ({ className, output, ...props }: ComponentProps<"div"> & { output: unknown }) => {
  if (output === undefined || output === null) return null;
  return (
    <div className={cn("space-y-1.5", className)} {...props}>
      <h4 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Result</h4>
      <CodeBlock code={typeof output === "string" ? output : JSON.stringify(output, null, 2)} language="json" />
    </div>
  );
};
