import { CheckIcon, CopyIcon } from "lucide-react";
import type { HTMLAttributes } from "react";
import { useEffect, useState } from "react";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

// Compact port of fold.run's ai-elements code block: shiki dual-theme highlighting with a
// copy button. Uses codeToHtml (not token rendering) — plenty for JSON tool payloads.

let highlighterPromise: Promise<typeof import("shiki")> | null = null;
const loadShiki = () => {
  highlighterPromise ??= import("shiki");
  return highlighterPromise;
};

export const CodeBlock = ({
  code,
  language = "json",
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { code: string; language?: string }) => {
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    loadShiki()
      .then((shiki) =>
        shiki.codeToHtml(code, {
          lang: language,
          themes: { dark: "github-dark", light: "github-light" },
          defaultColor: false,
        }),
      )
      .then((out) => {
        if (!cancelled) setHtml(out);
      })
      .catch(() => {
        if (!cancelled) setHtml(null);
      });
    return () => {
      cancelled = true;
    };
  }, [code, language]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable (non-secure context) — silently ignore.
    }
  };

  return (
    <div
      className={cn("group/code relative w-full overflow-hidden rounded-md border bg-background", className)}
      data-language={language}
      {...props}
    >
      <Button
        aria-label="Copy code"
        className="absolute top-1.5 right-1.5 z-10 opacity-0 transition-opacity group-hover/code:opacity-100"
        onClick={copy}
        size="icon-sm"
        type="button"
        variant="ghost"
      >
        {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
      </Button>
      {html ? (
        <div
          className="overflow-x-auto text-xs [&_pre]:m-0 [&_pre]:bg-transparent! [&_pre]:p-3"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki output is generated from our own code string
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className="m-0 overflow-x-auto p-3 font-mono text-xs">{code}</pre>
      )}
    </div>
  );
};
