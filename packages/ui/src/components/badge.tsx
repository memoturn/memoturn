import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type * as React from "react";

import { cn } from "../lib/utils";

const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a&]:hover:bg-primary/90",
        secondary: "bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/90",
        destructive:
          "bg-destructive text-white focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40 [a&]:hover:bg-destructive/90",
        outline: "border-border text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
        ghost: "[a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
        link: "text-primary underline-offset-4 [a&]:hover:underline",
        // Status-positive (used for terminal-good states like `ready`, `live`,
        // `synced`). Tinted ground + foreground token; reads as "completed",
        // distinct from `default`'s primary fill which signals "in progress".
        success: "bg-success text-success-foreground",
        // Search-leg color coding (used by /projects/:slug/search) — subtle bg tint,
        // strong color text, no visible border (transparent inherits from default).
        dense: "bg-primary/10 text-primary dark:bg-primary/15 dark:text-primary",
        lexical: "bg-secondary/10 text-secondary dark:bg-secondary/15 dark:text-secondary",
        hot: "bg-accent-warm/12 text-accent-warm dark:bg-accent-warm/18 dark:text-accent-warm",
        entity: "bg-palm/12 text-palm dark:bg-palm/18 dark:text-palm",
        graph: "bg-sea-ink-soft/15 text-sea-ink-soft dark:bg-sea-ink-soft/20 dark:text-sea-ink-soft",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Badge({
  className,
  variant = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span";

  return (
    <Comp data-slot="badge" data-variant={variant} className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
