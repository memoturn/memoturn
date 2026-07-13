import type * as React from "react";

import { cn } from "../lib/utils";
import { BrandMark } from "./BrandMark";

type EmptyStateVariant = "default" | "inline";

type EmptyStateProps = {
  kicker?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  /**
   * `default` (full chrome — bordered Card, BrandMark, lagoon halo, shadow)
   * is the right call for full-page first-run contexts (no projects, no
   * skills installed, no history). Inside an existing surface it's three
   * decorations the host doesn't need.
   *
   * `inline` strips the border, ground, BrandMark, halo, and shadow — keeps
   * just the kicker / title / description / action stack on a transparent
   * background, centered. Use whenever an empty state lives inside a Card,
   * dialog, or section that already provides containment.
   */
  variant?: EmptyStateVariant;
};

function EmptyState({ kicker, title, description, action, className, variant = "default" }: EmptyStateProps) {
  const isInline = variant === "inline";
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-3 text-center",
        isInline ? "py-8" : "rounded-lg border border-border/80 bg-card px-6 py-14 shadow-sm",
        className,
      )}
    >
      {isInline ? null : (
        <div className="relative">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 -z-10 scale-[2.2] rounded-full bg-[radial-gradient(circle,color-mix(in_oklab,var(--lagoon)_24%,transparent)_0%,transparent_70%)]"
          />
          <BrandMark className="size-12 text-primary opacity-60" />
        </div>
      )}
      {kicker ? <p className="kicker">{kicker}</p> : null}
      <h3 className={cn("display-title font-semibold text-foreground", isInline ? "text-base" : "text-lg")}>{title}</h3>
      {description ? (
        <p className="max-w-md text-pretty text-sm leading-relaxed text-muted-foreground">{description}</p>
      ) : null}
      {action ? <div className="pt-2">{action}</div> : null}
    </div>
  );
}

export { EmptyState };
