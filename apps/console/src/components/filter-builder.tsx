import {
  FILTER_OPERATORS,
  type FilterColumnDef,
  type FilterValueType,
  type SingleFilter,
  TRACE_FILTER_COLUMNS,
} from "@memoturn/contracts";
import { Filter, Plus, X } from "lucide-react";
import { useState } from "react";
import { KindBadge } from "./kind-badge";
import { Button } from "./ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "./ui/command";
import { Input } from "./ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

/**
 * Power-path filter builder for the traces list. Renders the active structured filter set
 * (SingleFilter[] from @memoturn/contracts) as removable chips plus an "Add filter" popover
 * whose cells are driven entirely off the shared column registry + FILTER_OPERATORS map — so the
 * operator choices can never drift from what the Doris SQL builder supports. The faceted rail
 * stays the quick path; this is the arbitrary-column / operator / metadata-key path.
 */

const OP_LABEL: Record<string, string> = {
  eq: "=",
  neq: "≠",
  gt: ">",
  lt: "<",
  gte: "≥",
  lte: "≤",
  contains: "contains",
  not_contains: "not contains",
  starts_with: "starts with",
  ends_with: "ends with",
  any_of: "any of",
  none_of: "none of",
  all_of: "all of",
  is_null: "is null",
  is_not_null: "is not null",
};

/** Value types that take no value input. */
const NO_VALUE = (t: FilterValueType, op: string) => t === "null" || op === "is_null" || op === "is_not_null";
const IS_OBJECT = (t: FilterValueType) => t === "stringObject" || t === "numberObject";
const IS_OPTIONS = (t: FilterValueType) => t === "stringOptions" || t === "arrayOptions";

/** Human-readable chip label for an active filter. */
function chipLabel(f: SingleFilter, col?: FilterColumnDef): string {
  const name = col?.label ?? f.column;
  const key = "key" in f ? `.${f.key}` : "";
  const op = OP_LABEL[f.operator] ?? f.operator;
  if (f.type === "null") return `${name}${key} ${op}`;
  const val = Array.isArray((f as { value?: unknown }).value)
    ? (f as { value: string[] }).value.join(", ")
    : String((f as { value: unknown }).value);
  return `${name}${key} ${op} ${val}`;
}

/** Build a validated SingleFilter from the draft cells, or null when incomplete. */
function buildFilter(col: FilterColumnDef, key: string, operator: string, raw: string): SingleFilter | null {
  const base = { column: col.id };
  const t = col.type;
  if (NO_VALUE(t, operator)) {
    return { ...base, type: "null", operator: operator as "is_null" | "is_not_null" } as SingleFilter;
  }
  if (IS_OBJECT(t) && !key.trim()) return null;
  switch (t) {
    case "string":
      return { ...base, type: "string", operator, value: raw } as SingleFilter;
    case "number":
      return raw === "" ? null : ({ ...base, type: "number", operator, value: Number(raw) } as SingleFilter);
    case "datetime":
      return raw === "" ? null : ({ ...base, type: "datetime", operator, value: raw } as SingleFilter);
    case "boolean":
      return { ...base, type: "boolean", operator, value: raw === "true" } as SingleFilter;
    case "stringOptions":
    case "arrayOptions": {
      const value = raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      return value.length === 0 ? null : ({ ...base, type: t, operator, value } as SingleFilter);
    }
    case "stringObject":
      return { ...base, type: "stringObject", key, operator, value: raw } as SingleFilter;
    case "numberObject":
      return raw === "" ? null : ({ ...base, type: "numberObject", key, operator, value: Number(raw) } as SingleFilter);
    default:
      return null;
  }
}

export function FilterBuilder({
  value,
  onChange,
}: {
  value: SingleFilter[];
  onChange: (next: SingleFilter[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [col, setCol] = useState<FilterColumnDef | null>(null);
  const [key, setKey] = useState("");
  const [operator, setOperator] = useState("");
  const [raw, setRaw] = useState("");

  const reset = () => {
    setCol(null);
    setKey("");
    setOperator("");
    setRaw("");
  };
  const pickColumn = (c: FilterColumnDef) => {
    setCol(c);
    setOperator(FILTER_OPERATORS[c.type][0]);
    setKey("");
    setRaw("");
  };
  const add = () => {
    if (!col) return;
    const f = buildFilter(col, key, operator, raw);
    if (!f) return;
    onChange([...value, f]);
    reset();
    setOpen(false);
  };
  const remove = (i: number) => onChange(value.filter((_, idx) => idx !== i));

  const colFor = (id: string) => TRACE_FILTER_COLUMNS.find((c) => c.id === id);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {value.map((f, i) => (
        <span
          key={`${f.column}-${i}`}
          className="inline-flex items-center gap-1 rounded border bg-muted px-1.5 py-0.5 text-xs"
        >
          <span className="font-medium">{chipLabel(f, colFor(f.column))}</span>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => remove(i)}
            title="Remove filter"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}

      <Popover
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) reset();
        }}
      >
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="h-7 gap-1.5">
            <Filter className="size-3.5" />
            Add filter
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 space-y-3 p-3">
          {!col ? (
            <Command>
              <CommandInput placeholder="Filter on…" />
              <CommandList>
                <CommandEmpty>No column.</CommandEmpty>
                <CommandGroup>
                  {TRACE_FILTER_COLUMNS.map((c) => (
                    <CommandItem key={c.id} value={c.label} onSelect={() => pickColumn(c)}>
                      {c.label}
                      <span className="ml-auto text-[0.625rem] text-muted-foreground">{c.type}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <KindBadge tone="blue">{col.label}</KindBadge>
                <button type="button" className="text-xs text-muted-foreground hover:underline" onClick={reset}>
                  change
                </button>
              </div>

              {IS_OBJECT(col.type) && (
                <Input
                  placeholder="metadata key (e.g. user_intent)"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                />
              )}

              <Select value={operator} onValueChange={setOperator}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="operator" />
                </SelectTrigger>
                <SelectContent>
                  {FILTER_OPERATORS[col.type].map((op) => (
                    <SelectItem key={op} value={op}>
                      {OP_LABEL[op] ?? op}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {!NO_VALUE(col.type, operator) &&
                (col.type === "boolean" ? (
                  <Select value={raw} onValueChange={setRaw}>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="value" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="true">true</SelectItem>
                      <SelectItem value="false">false</SelectItem>
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    value={raw}
                    onChange={(e) => setRaw(e.target.value)}
                    type={col.type === "number" || col.type === "numberObject" ? "number" : "text"}
                    placeholder={
                      IS_OPTIONS(col.type)
                        ? "comma-separated values"
                        : col.type === "datetime"
                          ? "2026-07-01T00:00:00Z"
                          : "value"
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter") add();
                    }}
                  />
                ))}

              <Button size="sm" className="w-full gap-1.5" onClick={add}>
                <Plus className="size-3.5" />
                Add filter
              </Button>
            </div>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}
