import { type ReactNode, useEffect, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";

/** The shortcuts wired up across the console (kept in sync with the actual handlers). */
const SHORTCUTS: { keys: string[]; label: string }[] = [
  { keys: ["⌘", "K"], label: "Open command palette / search" },
  { keys: ["?"], label: "Show this shortcuts help" },
  { keys: ["J"], label: "Next trace (in the preview drawer)" },
  { keys: ["K"], label: "Previous trace (in the preview drawer)" },
  { keys: ["Enter"], label: "Open the focused row · expand a span" },
  { keys: ["Esc"], label: "Close the dialog / drawer" },
  { keys: ["⌘", "Enter"], label: "Run (playground) · submit a comment" },
];

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex min-w-5 items-center justify-center rounded border bg-muted px-1.5 py-0.5 font-mono text-[0.6875rem]">
      {children}
    </kbd>
  );
}

/**
 * Global "?" opens a shortcuts cheat-sheet. Mounted once at the app root; the key handler
 * ignores modifier combos and text inputs so it never hijacks typing.
 */
export function KeyboardHelp() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      if (e.key === "?") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Press ? anytime to toggle this list.</DialogDescription>
        </DialogHeader>
        <dl className="space-y-2.5">
          {SHORTCUTS.map((s) => (
            <div key={s.label} className="flex items-center justify-between gap-4">
              <dt className="text-sm text-muted-foreground">{s.label}</dt>
              <dd className="flex shrink-0 items-center gap-1">
                {s.keys.map((k) => (
                  <Kbd key={k}>{k}</Kbd>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
