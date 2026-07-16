import type { LucideIcon } from "lucide-react";
import type * as React from "react";

import { HelpTip } from "./help-tip";

/**
 * Compact metric tile for list/detail summary strips: a bordered box with a muted label
 * (plus an optional help tooltip) and a large tabular value. Numeric values are
 * thousands-separated automatically; pass a preformatted string for anything else (e.g. cost).
 */
export function StatTile({
  label,
  value,
  help,
}: {
  label: string;
  value: React.ReactNode;
  help?: React.ReactNode;
  /** @deprecated No longer rendered — kept so existing `icon={…}` callers still type-check. */
  icon?: LucideIcon;
}) {
  const display = typeof value === "number" ? value.toLocaleString() : value;
  return (
    <div className="rounded-lg border p-4">
      <div className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        {label}
        {help ? <HelpTip>{help}</HelpTip> : null}
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{display}</div>
    </div>
  );
}
