import type * as React from "react";

/**
 * memoturn brand mark — concentric teal rings (mirrors public/favicon.svg).
 * Sized via className (e.g. `size-6`); the gradient is self-contained so it
 * reads on both light and dark backgrounds.
 */
export function Logo({ className, ...props }: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 128 128"
      role="img"
      aria-label="memoturn"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      {...props}
    >
      <title>memoturn</title>
      <defs>
        <linearGradient id="memoturn-logo" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#4fb8b2" />
          <stop offset="100%" stopColor="#328f97" />
        </linearGradient>
      </defs>
      <g fill="url(#memoturn-logo)">
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
