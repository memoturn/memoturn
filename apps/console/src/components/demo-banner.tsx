import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

/** Explains the refused actions on a public read-only deployment. Renders nothing on a normal install. */
export function DemoBanner() {
  const { data: cfg } = useQuery({ queryKey: ["auth-config"], queryFn: api.getAuthConfig, staleTime: 60_000 });
  if (!cfg?.lockdown) return null;

  return (
    <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 border-b bg-primary/10 px-4 py-1.5 text-center text-xs">
      <span className="font-medium">Live demo</span>
      <span className="text-muted-foreground">Sample data, read-only. Changes and model runs are turned off.</span>
      <a
        href="https://docs.memoturn.com/getting-started/"
        target="_blank"
        rel="noopener"
        className="font-medium underline underline-offset-2 hover:text-primary"
      >
        Self-host it →
      </a>
    </div>
  );
}
