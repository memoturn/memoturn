import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

/** Inline copy-to-clipboard button, used next to long ids. */
export function CopyButton({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      className="size-5 text-muted-foreground"
      aria-label={`Copy ${label ?? "value"}`}
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        toast.success("Copied");
        window.setTimeout(() => setCopied(false), 1200);
      }}
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
    </Button>
  );
}
