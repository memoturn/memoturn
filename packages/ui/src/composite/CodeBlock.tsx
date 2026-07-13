import { CheckIcon, CopyIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "../lib/utils";

type CodeBlockProps = {
  content: string;
  lang?: string;
  className?: string;
};

function CodeBlock({ content, lang, className }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore — user can still select-and-copy
    }
  };

  return (
    <div className={cn("relative overflow-hidden rounded-lg", className)}>
      <div aria-hidden="true" className="absolute inset-x-0 top-0 z-10 h-[3px] bg-[image:var(--gradient-lagoon)]" />
      <button
        type="button"
        onClick={onCopy}
        className="absolute right-3 top-3 z-20 inline-flex items-center gap-1 rounded-md border border-code-foreground/30 bg-code/70 px-2.5 py-1 text-xs font-semibold text-code-foreground backdrop-blur transition hover:bg-code"
        aria-label={copied ? "Copied" : "Copy to clipboard"}
      >
        {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
        {copied ? "Copied" : "Copy"}
      </button>
      <pre className="m-0 overflow-x-auto bg-code p-4 pr-20 font-mono text-xs leading-relaxed text-code-foreground">
        <code data-lang={lang}>{content}</code>
      </pre>
    </div>
  );
}

export { CodeBlock };
