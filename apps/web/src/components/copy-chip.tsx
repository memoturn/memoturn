import { CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/**
 * One-click copy for a shell command — the CLI-forward affordance next to a
 * CTA. Mono text + copy button in a single hairline chip; the label swaps to
 * a check for two seconds after copying.
 */
export default function CopyChip({ command, className = "" }: { command: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable (permissions/insecure context) — leave the text selectable */
    }
  };

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? "Copied" : `Copy command: ${command}`}
      className={`group inline-flex h-10 items-center gap-2.5 rounded-md border border-(--on-gradient-border) bg-(--on-gradient-button-bg) px-3.5 font-mono text-[13px] tracking-[0.01em] text-(--on-gradient-fg) transition-colors hover:border-(--on-gradient-fg) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--on-gradient-fg) focus-visible:ring-offset-2 focus-visible:ring-offset-transparent ${className}`}
    >
      <span aria-hidden className="select-all">
        {command}
      </span>
      {copied ? (
        <CheckIcon className="size-3.5 shrink-0" aria-hidden />
      ) : (
        <CopyIcon className="size-3.5 shrink-0 opacity-70 transition-opacity group-hover:opacity-100" aria-hidden />
      )}
      <span aria-live="polite" className="sr-only">
        {copied ? "Command copied to clipboard" : ""}
      </span>
    </button>
  );
}
