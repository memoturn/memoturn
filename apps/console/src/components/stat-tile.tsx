import type * as React from "react";

import { Card, CardContent } from "@/components/ui/card";

/** Compact metric tile used in detail-page summary strips. */
export function StatTile({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <Card size="sm" className="gap-1">
      <CardContent>
        <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</div>
        <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
      </CardContent>
    </Card>
  );
}
