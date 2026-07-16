import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../lib/api";
import { KindBadge } from "./kind-badge";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "./ui/dialog";

/** A "Log" button that opens a webhook's recent delivery history (lazy-loaded on open). */
export function WebhookLogButton({ webhookId, url }: { webhookId: string; url: string }) {
  const [open, setOpen] = useState(false);
  const { data: deliveries, isPending } = useQuery({
    queryKey: ["webhook-deliveries", webhookId],
    queryFn: () => api.listWebhookDeliveries(webhookId, 50),
    enabled: open,
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          Log
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Delivery log</DialogTitle>
          <DialogDescription className="break-all">{url}</DialogDescription>
        </DialogHeader>
        <div className="max-h-96 overflow-y-auto">
          {isPending ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
          ) : deliveries && deliveries.length > 0 ? (
            <table className="w-full text-sm">
              <thead className="border-b text-left text-muted-foreground">
                <tr>
                  <th className="px-2 py-1.5 font-medium">When</th>
                  <th className="px-2 py-1.5 font-medium">Result</th>
                  <th className="px-2 py-1.5 font-medium">Attempts</th>
                  <th className="px-2 py-1.5 font-medium">Duration</th>
                </tr>
              </thead>
              <tbody>
                {deliveries.map((d) => (
                  <tr key={d.id} className="border-b last:border-0 align-top">
                    <td className="px-2 py-1.5 whitespace-nowrap text-muted-foreground">
                      {new Date(d.createdAt).toLocaleString()}
                    </td>
                    <td className="px-2 py-1.5">
                      <KindBadge tone={d.ok ? "green" : "red"}>
                        {d.ok ? `OK ${d.status ?? ""}` : `fail ${d.status ?? "err"}`}
                      </KindBadge>
                      {!d.ok && d.error ? <div className="mt-0.5 text-xs text-muted-foreground">{d.error}</div> : null}
                    </td>
                    <td className="px-2 py-1.5">{d.attempts}</td>
                    <td className="px-2 py-1.5 text-muted-foreground">
                      {d.durationMs != null ? `${d.durationMs} ms` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="py-6 text-center text-sm text-muted-foreground">No deliveries yet.</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
