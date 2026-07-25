import { cn } from "@/lib/utils";

/** Full, locale-formatted absolute time — shown on hover for the exact value. */
function absolute(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Compact, scannable relative time ("just now", "3m ago", "2h ago", "5d ago"). */
function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const secs = Math.round((Date.now() - t) / 1000);
  if (secs < 0) return absolute(iso); // future timestamps: just show the absolute value
  if (secs < 45) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}

/**
 * Renders a timestamp as human-readable relative time (default) with the full absolute time
 * on hover — instead of a raw ISO string like `2026-07-25T03:04:19Z`. Pass `absolute` to show
 * the formatted absolute time inline instead of relative.
 */
export function Timestamp({
  value,
  className,
  absolute: showAbsolute = false,
}: {
  value: string | null | undefined;
  className?: string;
  absolute?: boolean;
}) {
  if (!value) return <span className="text-muted-foreground">—</span>;
  const full = absolute(value);
  return (
    <span className={cn("whitespace-nowrap tabular-nums", className)} title={full}>
      {showAbsolute ? full : relativeTime(value)}
    </span>
  );
}
