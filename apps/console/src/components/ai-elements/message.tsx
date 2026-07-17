import { code } from "@streamdown/code";
import type { ComponentProps, HTMLAttributes } from "react";
import { memo } from "react";
import { Streamdown } from "streamdown";
import { cn } from "../../lib/utils";

// Ported from fold.run's ai-elements: message layout + Streamdown markdown rendering
// (code plugin only — telemetry answers don't need math/mermaid/CJK).

export const Message = ({
  className,
  from,
  ...props
}: HTMLAttributes<HTMLDivElement> & { from: "user" | "assistant" }) => (
  <div
    className={cn(
      "group flex w-full max-w-[95%] flex-col gap-2",
      from === "user" ? "is-user ml-auto items-end justify-end" : "is-assistant",
      className,
    )}
    {...props}
  />
);

export const MessageContent = ({ children, className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex min-w-0 max-w-full flex-col gap-2 overflow-hidden text-sm text-foreground",
      "group-[.is-user]:w-fit group-[.is-user]:rounded-2xl group-[.is-user]:rounded-br-sm group-[.is-user]:bg-primary group-[.is-user]:px-3.5 group-[.is-user]:py-2 group-[.is-user]:text-primary-foreground",
      className,
    )}
    {...props}
  >
    {children}
  </div>
);

const streamdownPlugins = { code };

export const MessageResponse = memo(
  ({ className, children, ...props }: ComponentProps<typeof Streamdown>) => (
    <Streamdown
      className={cn("size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0", className)}
      plugins={streamdownPlugins}
      {...props}
    >
      {children}
    </Streamdown>
  ),
  (prev, next) => prev.children === next.children,
);

MessageResponse.displayName = "MessageResponse";
