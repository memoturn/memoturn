import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Radio } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Timestamp } from "@/components/timestamp";
import { EmptyState } from "../components/empty-state";
import { PageHeader } from "../components/page-header";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { getActiveProject } from "../lib/api";

export const Route = createFileRoute("/live")({ component: LivePage });

interface LiveTrace {
  id: string;
  name: string;
  timestamp: string;
  environment: string;
  sessionId: string;
}

const MAX_ROWS = 100;

function LivePage() {
  const navigate = useNavigate();
  const [connected, setConnected] = useState(false);
  const [rows, setRows] = useState<LiveTrace[]>([]);
  const [count, setCount] = useState(0);
  // Keep the newest rows without re-subscribing on every event.
  const rowsRef = useRef<LiveTrace[]>([]);

  useEffect(() => {
    const project = getActiveProject();
    const base = (import.meta.env.VITE_API_BASE as string | undefined) ?? "/api";
    const url = `${base}/v1/live/traces${project ? `?project=${encodeURIComponent(project)}` : ""}`;
    const es = new EventSource(url, { withCredentials: true });

    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.addEventListener("trace", (ev) => {
      try {
        const t = JSON.parse((ev as MessageEvent).data) as LiveTrace;
        rowsRef.current = [t, ...rowsRef.current].slice(0, MAX_ROWS);
        setRows(rowsRef.current);
        setCount((c) => c + 1);
      } catch {
        // ignore malformed events
      }
    });

    return () => es.close();
  }, []);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Live"
        description="Traces stream in as they're ingested."
        help="A real-time tail of incoming traces for the active project (server-sent events). Newest first, capped at the last 100."
      />

      <div className="flex items-center gap-2 text-sm">
        <span
          className={`inline-block size-2 rounded-full ${connected ? "animate-pulse bg-emerald-500" : "bg-muted-foreground"}`}
        />
        <span className="text-muted-foreground">
          {connected ? "Live" : "Connecting…"} · {count} received
        </span>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={Radio}
          title="Waiting for traces"
          description="New traces for this project will appear here the moment they're ingested."
        />
      ) : (
        <div className="border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Trace Name</TableHead>
                <TableHead>Trace ID</TableHead>
                <TableHead>Session</TableHead>
                <TableHead>Environment</TableHead>
                <TableHead>Timestamp</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((t) => (
                <TableRow
                  key={`${t.id}-${t.timestamp}`}
                  className="cursor-pointer"
                  onClick={() => navigate({ to: "/traces/$id", params: { id: t.id } })}
                >
                  <TableCell>
                    <span className="font-medium text-primary">{t.name || "(unnamed trace)"}</span>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{t.id}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {t.sessionId ? (
                      <Link
                        to="/sessions/$id"
                        params={{ id: t.sessionId }}
                        className="hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {t.sessionId}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{t.environment}</TableCell>
                  <TableCell className="text-muted-foreground">
                    <Timestamp value={t.timestamp} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
