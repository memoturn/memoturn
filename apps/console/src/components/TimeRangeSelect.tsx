import { RANGES, setRangeDays, useRangeDays } from "../lib/timeRange";

/** Global time-window selector (topbar). Shared by dashboard, metrics, and traces. */
export function TimeRangeSelect() {
  const days = useRangeDays();
  return (
    <select value={days} onChange={(e) => setRangeDays(Number(e.target.value))} title="Time range">
      {RANGES.map((r) => (
        <option key={r.days} value={r.days}>
          {r.label}
        </option>
      ))}
    </select>
  );
}
