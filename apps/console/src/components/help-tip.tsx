import { CircleHelp } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

/**
 * Small "?" affordance that reveals an explanatory tooltip on hover/focus — used next to labels,
 * metrics, and config options across the console to explain non-obvious concepts inline.
 * The app already mounts a TooltipProvider at the root, so this works anywhere.
 */
export function HelpTip({
  children,
  side = "top",
  className,
}: {
  children: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="Help"
          className={cn(
            "inline-flex shrink-0 items-center text-muted-foreground/60 transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-none",
            className,
          )}
        >
          <CircleHelp className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side={side} className="max-w-xs text-xs leading-relaxed font-normal normal-case">
        {children}
      </TooltipContent>
    </Tooltip>
  );
}
