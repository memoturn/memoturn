import type { LucideIcon } from "lucide-react";
import type * as React from "react";

import { Card, CardContent } from "@/components/ui/card";
import { HelpTip } from "./help-tip";

/** Compact metric tile used in detail-page and list-page summary strips. */
export function StatTile({
  label,
  value,
  icon: Icon,
  help,
}: {
  label: string;
  value: React.ReactNode;
  icon?: LucideIcon;
  help?: React.ReactNode;
}) {
  return (
    <Card size="sm" className="gap-1">
      <CardContent className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {label}
            {help ? <HelpTip>{help}</HelpTip> : null}
          </div>
          <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
        </div>
        {Icon && (
          <span className="flex size-7 shrink-0 items-center justify-center bg-muted text-muted-foreground">
            <Icon className="size-3.5" />
          </span>
        )}
      </CardContent>
    </Card>
  );
}
