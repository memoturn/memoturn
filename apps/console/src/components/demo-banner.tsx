import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

/**
 * A slim strip shown while browsing a public-demo sandbox (DEMO_MODE): reminds the visitor
 * it's a read-only demo and when it expires. Renders nothing on a normal install — the demo
 * status endpoint returns null unless the session owns a sandbox.
 */
export function DemoBanner() {
  const { data: demo } = useQuery({
    queryKey: ["demo-status"],
    queryFn: () => api.getDemoStatus(),
    staleTime: 5 * 60_000,
  });
  if (!demo) return null;

  const daysLeft = Math.max(0, Math.ceil((Date.parse(demo.expiresAt) - Date.now()) / 86_400_000));
  const expiry = daysLeft <= 0 ? "expires today" : `expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`;

  return (
    <div className="flex items-center justify-center gap-2 border-b bg-primary/10 px-4 py-1.5 text-center text-xs text-foreground">
      <span className="font-medium">Demo sandbox</span>
      <span className="text-muted-foreground">·</span>
      <span className="text-muted-foreground">read-only</span>
      <span className="text-muted-foreground">·</span>
      <span className="text-muted-foreground">{expiry}</span>
      <a
        href="https://docs.memoturn.com/getting-started/"
        target="_blank"
        rel="noopener"
        className="ml-1 font-medium underline underline-offset-2 hover:text-primary"
      >
        Self-host it →
      </a>
    </div>
  );
}
