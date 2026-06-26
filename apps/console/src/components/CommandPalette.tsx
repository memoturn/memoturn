import { useNavigate } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { useEffect, useState } from "react";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

/**
 * Global command palette (⌘K / Ctrl+K). Filters navigation destinations and offers a
 * quick "open trace by id". Opens on the shortcut or a `memoturn:cmdk` window event
 * (dispatched by the topbar button). Built on shadcn's CommandDialog (cmdk).
 */
interface Nav {
  label: string;
  to: string;
}

const NAV: Nav[] = [
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
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
    if (open) setQ("");
  }, [open]);

  const trimmed = q.trim();

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Jump to… (type to filter, Enter to go)" value={q} onValueChange={setQ} />
      <CommandList>
        <CommandEmpty>No matches.</CommandEmpty>
        <CommandGroup heading="Navigate">
          {NAV.map((c) => (
            <CommandItem
              key={c.to}
              value={c.label}
              onSelect={() => {
                setOpen(false);
                navigate({ to: c.to as never });
              }}
            >
              {c.label}
            </CommandItem>
          ))}
        </CommandGroup>
        {trimmed ? (
          <CommandGroup heading="Trace">
            <CommandItem
              value={`open-trace-${trimmed}`}
              onSelect={() => {
                setOpen(false);
                navigate({ to: "/traces/$id", params: { id: trimmed } });
              }}
            >
              <ArrowRight />
              Open trace: {trimmed}
            </CommandItem>
          </CommandGroup>
        ) : null}
      </CommandList>
    </CommandDialog>
  );
}
