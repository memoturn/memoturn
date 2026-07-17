import { ArrowUpIcon, Loader2Icon } from "lucide-react";
import type { ComponentProps, FormEventHandler, KeyboardEventHandler } from "react";
import { useState } from "react";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

// Compact port of fold.run's ai-elements composer: bordered shell with an auto-growing
// textarea (Enter submits, Shift+Enter breaks) and a toolbar row for tools + submit.

export const PromptInput = ({
  className,
  onSubmit,
  ...props
}: ComponentProps<"form"> & { onSubmit: FormEventHandler<HTMLFormElement> }) => (
  <form
    className={cn(
      "flex w-full flex-col rounded-xl border bg-background shadow-xs transition-colors focus-within:border-ring/60",
      className,
    )}
    onSubmit={(e) => {
      e.preventDefault();
      onSubmit(e);
    }}
    {...props}
  />
);

export const PromptInputTextarea = ({
  className,
  onKeyDown,
  placeholder = "Ask about your telemetry…",
  ...props
}: ComponentProps<"textarea">) => {
  const [isComposing, setIsComposing] = useState(false);

  const handleKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = (e) => {
    onKeyDown?.(e);
    if (e.defaultPrevented) return;
    if (e.key === "Enter" && !e.shiftKey) {
      if (isComposing || e.nativeEvent.isComposing) return;
      e.preventDefault();
      const submit = e.currentTarget.form?.querySelector<HTMLButtonElement>('button[type="submit"]');
      if (!submit?.disabled) e.currentTarget.form?.requestSubmit();
    }
  };

  return (
    <textarea
      className={cn(
        "max-h-40 min-h-10 w-full resize-none bg-transparent px-3.5 pt-3 text-sm outline-none placeholder:text-muted-foreground field-sizing-content",
        className,
      )}
      onCompositionEnd={() => setIsComposing(false)}
      onCompositionStart={() => setIsComposing(true)}
      onKeyDown={handleKeyDown}
      placeholder={placeholder}
      rows={1}
      {...props}
    />
  );
};

export const PromptInputToolbar = ({ className, ...props }: ComponentProps<"div">) => (
  <div className={cn("flex items-center justify-between gap-2 p-2", className)} {...props} />
);

export const PromptInputTools = ({ className, ...props }: ComponentProps<"div">) => (
  <div className={cn("flex items-center gap-1.5", className)} {...props} />
);

export const PromptInputSubmit = ({
  className,
  pending = false,
  ...props
}: ComponentProps<typeof Button> & { pending?: boolean }) => (
  <Button aria-label="Send" className={cn("size-8 rounded-full", className)} size="icon" type="submit" {...props}>
    {pending ? <Loader2Icon className="size-4 animate-spin" /> : <ArrowUpIcon className="size-4" />}
  </Button>
);
