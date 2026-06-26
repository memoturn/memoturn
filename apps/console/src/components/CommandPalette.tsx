import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

/**
 * Global command palette (⌘K / Ctrl+K). Filters navigation destinations and offers a
 * quick "open trace by id". Opens on the shortcut or a `memoturn:cmdk` window event
 * (dispatched by the topbar button).
 */
interface Cmd {
  label: string;
  to: string;
  hint?: string;
  traceId?: string;
}

const NAV: Cmd[] = [
  { label: "Dashboard", to: "/dashboard" },
  { label: "Traces", to: "/traces" },
  { label: "Sessions", to: "/sessions" },
  { label: "Prompts", to: "/prompts" },
  { label: "Datasets", to: "/datasets" },
  { label: "Playground", to: "/playground" },
  { label: "Evaluators", to: "/evaluators" },
  { label: "Review", to: "/review" },
  { label: "Audit", to: "/audit" },
  { label: "Organizations", to: "/organizations" },
  { label: "Settings", to: "/settings" },
];

export function CommandPalette() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("memoturn:cmdk", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("memoturn:cmdk", onOpen);
    };
  }, []);

  useEffect(() => {
    if (open) {
      setQ("");
      setActive(0);
    }
  }, [open]);

  const items = useMemo(() => {
    const f = q.trim().toLowerCase();
    const matched = NAV.filter((c) => !f || c.label.toLowerCase().includes(f));
    const extra: Cmd[] = q.trim()
      ? [{ label: `Open trace: ${q.trim()}`, to: "", traceId: q.trim(), hint: "trace" }]
      : [];
    return [...matched, ...extra];
  }, [q]);

  if (!open) return null;

  const go = (c: Cmd) => {
    setOpen(false);
    if (c.traceId) navigate({ to: "/traces/$id", params: { id: c.traceId } });
    else navigate({ to: c.to as never });
  };

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click-to-dismiss; Esc also closes
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop is a non-semantic overlay
    <div className="cmdk-overlay" onClick={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className="cmdk">
        <input
          className="cmdk-input"
          // biome-ignore lint/a11y/noAutofocus: palette should focus its input on open
          autoFocus
          placeholder="Jump to… (type to filter, Enter to go)"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((n) => Math.min(n + 1, items.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((n) => Math.max(n - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              const c = items[active];
              if (c) go(c);
            }
          }}
        />
        {items.length === 0 ? (
          <div className="cmdk-empty">No matches</div>
        ) : (
          <div className="cmdk-list">
            {items.map((c, idx) => (
              <button
                type="button"
                key={`${c.to}:${c.label}`}
                className={`cmdk-item${idx === active ? " active" : ""}`}
                onMouseEnter={() => setActive(idx)}
                onClick={() => go(c)}
              >
                <span>{c.label}</span>
                {c.hint && <span className="cmdk-hint">{c.hint}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
