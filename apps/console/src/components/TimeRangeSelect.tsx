import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RANGES, setRangeDays, useRangeDays } from "../lib/timeRange";

/** Global time-window selector (topbar). Shared by dashboard, metrics, and traces. */
export function TimeRangeSelect() {
  const days = useRangeDays();
  return (
    <Select value={String(days)} onValueChange={(v) => setRangeDays(Number(v))}>
      <SelectTrigger size="sm" className="w-[88px]" aria-label="Time range">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {RANGES.map((r) => (
          <SelectItem key={r.days} value={String(r.days)}>
            {r.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
