import { useEffect, useState } from "react";

/**
 * A shared time window applied across the dashboard, metrics, and traces. Stored in
 * localStorage and broadcast via a window event so every consumer re-renders when it
 * changes (no provider/prop-drilling).
 */
const KEY = "memoturn.range";
const EVENT = "memoturn:range";

export const RANGES = [
  { label: "24h", days: 1 },
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
];

export function getRangeDays(): number {
  const v = typeof localStorage !== "undefined" ? Number(localStorage.getItem(KEY)) : 0;
  return v > 0 ? v : 30;
}

export function setRangeDays(days: number): void {
  localStorage.setItem(KEY, String(days));
  window.dispatchEvent(new Event(EVENT));
}

/** Reactive hook: returns the active range in days, updating when it changes anywhere. */
export function useRangeDays(): number {
  const [days, setDays] = useState(getRangeDays());
  useEffect(() => {
    const on = () => setDays(getRangeDays());
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  return days;
}
