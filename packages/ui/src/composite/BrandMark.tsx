import type * as React from "react";
import { useId } from "react";

import { cn } from "../lib/utils";

type BrandMarkProps = {
  /**
   * Render the lagoon gradient (lagoon → lagoon-deep) inside the mark instead
   * of using `currentColor`. Use on light surfaces where the brand wants its
   * full identity. Default (currentColor) is used on tinted or dark surfaces
   * and recolored via the parent's `color` (e.g. `text-primary` for inked,
   * or `color: var(--foam-light)` on the atoll closing band).
   */
  gradient?: boolean;
} & React.SVGProps<SVGSVGElement>;

function BrandMark({ className, gradient = false, ...props }: BrandMarkProps) {
  const gradId = useId();

  if (gradient) {
    return (
      <svg viewBox="0 0 128 128" aria-hidden="true" className={cn("size-6", className)} {...props}>
        <title>Memoturn mark</title>
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#4fb8b2" />
            <stop offset="100%" stopColor="#328f97" />
          </linearGradient>
        </defs>
        <g fill={`url(#${gradId})`}>
          <path
            fillRule="evenodd"
            d="M 64 10 a 54 54 0 1 0 0 108 a 54 54 0 1 0 0 -108 M 64 24 a 40 40 0 1 1 0 80 a 40 40 0 1 1 0 -80"
          />
          <path
            fillRule="evenodd"
            d="M 64 34 a 30 30 0 1 0 0 60 a 30 30 0 1 0 0 -60 M 64 48 a 16 16 0 1 1 0 32 a 16 16 0 1 1 0 -32"
          />
          <circle cx="64" cy="64" r="8" />
        </g>
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 128 128" fill="currentColor" aria-hidden="true" className={cn("size-6", className)} {...props}>
      <title>Memoturn mark</title>
      <path
        fillRule="evenodd"
        d="M 64 10 a 54 54 0 1 0 0 108 a 54 54 0 1 0 0 -108 M 64 24 a 40 40 0 1 1 0 80 a 40 40 0 1 1 0 -80"
      />
      <path
        fillRule="evenodd"
        d="M 64 34 a 30 30 0 1 0 0 60 a 30 30 0 1 0 0 -60 M 64 48 a 16 16 0 1 1 0 32 a 16 16 0 1 1 0 -32"
      />
      <circle cx="64" cy="64" r="8" />
    </svg>
  );
}

export { BrandMark };
