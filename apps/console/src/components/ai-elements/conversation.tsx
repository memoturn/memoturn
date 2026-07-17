import { ArrowDownIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

// Ported from fold.run's ai-elements (stick-to-bottom conversation shell).

export const Conversation = ({ className, ...props }: ComponentProps<typeof StickToBottom>) => (
  <StickToBottom
    className={cn("relative flex-1 overflow-y-hidden", className)}
    initial="smooth"
    resize="smooth"
    role="log"
    {...props}
  />
);

export const ConversationContent = ({ className, ...props }: ComponentProps<typeof StickToBottom.Content>) => (
  <StickToBottom.Content className={cn("flex flex-col gap-6 p-4", className)} {...props} />
);

export const ConversationEmptyState = ({
  className,
  title,
  description,
  icon,
  children,
  ...props
}: ComponentProps<"div"> & { title?: string; description?: string; icon?: ReactNode }) => (
  <div
    className={cn("flex size-full flex-col items-center justify-center gap-3 p-8 text-center", className)}
    {...props}
  >
    {children ?? (
      <>
        {icon && <div className="text-muted-foreground">{icon}</div>}
        <div className="space-y-1">
          <h3 className="text-sm font-medium">{title}</h3>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
      </>
    )}
  </div>
);

export const ConversationScrollButton = ({ className, ...props }: ComponentProps<typeof Button>) => {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();
  return (
    !isAtBottom && (
      <Button
        className={cn("absolute bottom-4 left-[50%] translate-x-[-50%] rounded-full", className)}
        onClick={() => scrollToBottom()}
        size="icon"
        type="button"
        variant="outline"
        {...props}
      >
        <ArrowDownIcon className="size-4" />
      </Button>
    )
  );
};
