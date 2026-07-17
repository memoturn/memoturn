import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Tinted "pill" badge for memoturn's semantic labels (observation kinds, roles, channels,
 * statuses). The vendored shadcn Badge in the "sera" style is intentionally text-only; this
 * component provides the colored-pill look the console relies on, using tones that read in
 * both light and dark mode.
 */
const kindBadgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center gap-1 border px-1.5 py-0.5 text-[0.6875rem] font-medium tracking-normal whitespace-nowrap normal-case",
  {
    variants: {
      tone: {
        neutral: "border-border bg-muted text-muted-foreground",
        blue: "border-blue-500/25 bg-blue-500/10 text-blue-600 dark:text-blue-400",
        green: "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
        amber: "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-400",
        red: "border-destructive/25 bg-destructive/10 text-destructive",
        violet: "border-violet-500/25 bg-violet-500/10 text-violet-600 dark:text-violet-400",
        cyan: "border-cyan-500/25 bg-cyan-500/10 text-cyan-700 dark:text-cyan-400",
        teal: "border-teal-500/25 bg-teal-500/10 text-teal-700 dark:text-teal-400",
        indigo: "border-indigo-500/25 bg-indigo-500/10 text-indigo-600 dark:text-indigo-400",
        rose: "border-rose-500/25 bg-rose-500/10 text-rose-600 dark:text-rose-400",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export type KindBadgeTone = NonNullable<VariantProps<typeof kindBadgeVariants>["tone"]>;

/** Maps common observation/trace kinds to a tone. Falls back to neutral. */
export function toneForKind(kind: string | undefined | null): KindBadgeTone {
  switch ((kind ?? "").toUpperCase()) {
    case "GENERATION":
      return "blue";
    case "SPAN":
      return "green";
    case "TOOL":
      return "amber";
    case "AGENT":
      return "violet";
    case "RETRIEVER":
      return "cyan";
    case "RERANKER":
      return "teal";
    case "EMBEDDING":
      return "indigo";
    case "GUARDRAIL":
      return "rose";
    case "CHAIN":
    case "EVENT":
      return "neutral";
    case "ERROR":
    case "FAILED":
      return "red";
    default:
      return "neutral";
  }
}

export function KindBadge({
  className,
  tone,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof kindBadgeVariants>) {
  return <span data-slot="kind-badge" className={cn(kindBadgeVariants({ tone }), className)} {...props} />;
}

export { kindBadgeVariants };
