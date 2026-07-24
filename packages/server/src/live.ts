import { redisConnection } from "@memoturn/db/queue";

/**
 * Live tail — a read-side, best-effort real-time stream of traces as they're ingested. The
 * worker PUBLISHES a compact event per trace to a per-project Redis channel after the
 * telemetry insert; the API SUBSCRIBES (a dedicated pub/sub connection) and forwards events
 * to the console over SSE. This never touches the async-ingest write path: publishing is
 * best-effort and a failure is swallowed, so live tail can never affect ingestion.
 *
 * Deployment-profile note (edge lens): this is an OPTIONAL feature gated on Redis pub/sub.
 * On a profile without it, `subscribeLiveTraces` simply yields nothing (the SSE stream still
 * heartbeats) — the primary product is unaffected.
 */
const channel = (projectId: string) => `memoturn:live:${projectId}`;

/** Compact "a trace just landed" event — enough to render a live row, not the full payload. */
export interface LiveTraceEvent {
  id: string;
  name: string;
  timestamp: string;
  environment: string;
  sessionId: string;
}

/** Publish live events for a batch of traces. Best-effort — swallows every error. */
export async function publishLiveTraces(projectId: string, traces: LiveTraceEvent[]): Promise<void> {
  if (traces.length === 0) return;
  try {
    const conn = redisConnection();
    const ch = channel(projectId);
    await Promise.all(traces.map((t) => conn.publish(ch, JSON.stringify(t))));
  } catch {
    // best-effort: live tail is non-critical read-side signalling
  }
}

/**
 * Subscribe to a project's live trace events on a dedicated pub/sub connection. Returns an
 * async cleanup that unsubscribes and closes the connection — call it when the SSE client
 * disconnects. Malformed messages are dropped.
 */
export function subscribeLiveTraces(projectId: string, onEvent: (e: LiveTraceEvent) => void): () => Promise<void> {
  const sub = redisConnection().duplicate();
  const ch = channel(projectId);
  sub.subscribe(ch).catch(() => {});
  const handler = (messageChannel: string, message: string) => {
    if (messageChannel !== ch) return;
    try {
      onEvent(JSON.parse(message) as LiveTraceEvent);
    } catch {
      // drop malformed messages
    }
  };
  sub.on("message", handler);
  return async () => {
    sub.off("message", handler);
    try {
      await sub.unsubscribe(ch);
      await sub.quit();
    } catch {
      // connection may already be gone
    }
  };
}
