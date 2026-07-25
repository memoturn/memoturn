import { cn } from "@/lib/utils";

/**
 * Render a value that may be JSON — an object/array, or a string that contains JSON — as
 * readable, pretty-printed monospace instead of a raw one-line `JSON.stringify` blob. Plain
 * (non-JSON) strings render as normal wrapped text. Use anywhere the UI would otherwise dump
 * stringified JSON onto the screen (dataset items, tool args, request/response bodies, …).
 */
export function JsonValue({
  value,
  className,
  maxHeight = "max-h-64",
}: {
  value: unknown;
  className?: string;
  /** Tailwind max-height utility for the scroll area (e.g. "max-h-40"). */
  maxHeight?: string;
}) {
  if (value == null || value === "") return <span className="text-muted-foreground">—</span>;

  let text: string;
  let isJson = false;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        text = JSON.stringify(JSON.parse(trimmed), null, 2);
        isJson = true;
      } catch {
        text = value; // looked like JSON but wasn't — show the raw string
      }
    } else {
      text = value;
    }
  } else {
    text = JSON.stringify(value, null, 2);
    isJson = true;
  }

  // Plain prose — keep it readable, no code styling.
  if (!isJson) {
    return <div className={cn("whitespace-pre-wrap break-words text-sm", className)}>{text}</div>;
  }

  return (
    <pre
      className={cn(
        "overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-2.5 font-mono text-xs leading-relaxed",
        maxHeight,
        className,
      )}
    >
      {text}
    </pre>
  );
}
