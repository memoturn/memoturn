import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { Logo } from "../components/logo";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../components/ui/card";
import { authClient } from "../lib/auth";

/**
 * OAuth 2.1 consent page (remote MCP). The authorize endpoint bounces here with the SIGNED
 * authorization query (client_id, scope, sig, …) when the signed-in user hasn't granted the
 * requested scopes yet. Approve/deny posts the decision — with the query round-tripped
 * verbatim as `oauth_query`, since the signature covers it — and the server answers with the
 * redirect_uri (authorization code on approve, access_denied on deny) to send the browser to.
 */
export const Route = createFileRoute("/consent")({
  component: ConsentPage,
});

/** Human labels for the scopes the server supports (see oauthProvider() in @memoturn/server). */
const SCOPE_LABELS: Record<string, string> = {
  openid: "Confirm your identity",
  profile: "See your name and profile picture",
  email: "See your email address",
  offline_access: "Keep access when you're offline (refresh tokens)",
};

function ConsentPage() {
  const search = typeof window === "undefined" ? "" : window.location.search;
  const params = new URLSearchParams(search);
  const clientId = params.get("client_id") ?? "";
  const scopes = (params.get("scope") ?? "").split(" ").filter(Boolean);
  const [busy, setBusy] = useState<"accept" | "deny" | null>(null);

  // Public client metadata (name, homepage) for a recognizable prompt; the raw client_id is
  // the fallback — dynamically registered MCP clients don't always set a display name.
  const { data: client } = useQuery({
    queryKey: ["oauth-public-client", clientId],
    enabled: clientId.length > 0,
    queryFn: async () => {
      const res = await authClient.$fetch<Record<string, unknown>>("/oauth2/public-client", {
        query: { client_id: clientId },
      });
      return (res as { data?: Record<string, unknown> }).data ?? (res as Record<string, unknown>);
    },
  });
  const clientName =
    (typeof client?.client_name === "string" && client.client_name) ||
    (typeof client?.name === "string" && client.name) ||
    clientId ||
    "An application";
  const clientUri =
    (typeof client?.client_uri === "string" && client.client_uri) || (typeof client?.uri === "string" && client.uri);

  async function decide(accept: boolean) {
    setBusy(accept ? "accept" : "deny");
    const res = await authClient.$fetch<{ redirect_uri?: string; url?: string }>("/oauth2/consent", {
      method: "POST",
      body: { accept, oauth_query: search.replace(/^\?/, "") },
    });
    setBusy(null);
    if ("error" in res && res.error) {
      const err = res.error as { status?: number; message?: string };
      // No session (expired mid-flow): restart via the login page, which resumes the
      // authorize continuation from the same signed query.
      if (err.status === 401) {
        window.location.assign(`/login${search}`);
        return;
      }
      toast.error(err.message ?? "Could not record your decision — try connecting again from your client");
      return;
    }
    const raw = res as { data?: { redirect_uri?: string; url?: string } };
    const data = raw.data ?? (raw as { redirect_uri?: string; url?: string });
    const target = data.redirect_uri ?? data.url;
    if (target) window.location.assign(target);
    else toast.error("The authorization flow returned no redirect — try connecting again from your client");
  }

  const malformed = !clientId;
  return (
    <div className="flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <Logo className="size-9" />
          <CardTitle>Authorize {clientName}</CardTitle>
          <CardDescription>
            {malformed ? (
              "This authorization link is incomplete. Start the connection again from your client."
            ) : (
              <>
                {clientUri ? (
                  <a href={clientUri} target="_blank" rel="noreferrer" className="underline hover:text-foreground">
                    {clientUri}
                  </a>
                ) : null}
                {clientUri ? " " : ""}
                wants to access your memoturn account.
              </>
            )}
          </CardDescription>
        </CardHeader>
        {!malformed && (
          <CardContent>
            <ul className="space-y-2 text-sm">
              {(scopes.length > 0 ? scopes : ["openid"]).map((s) => (
                <li key={s} className="flex items-start gap-2">
                  <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary" />
                  <span>{SCOPE_LABELS[s] ?? s}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        )}
        <CardFooter className="flex-col items-stretch gap-2">
          {!malformed && (
            <>
              <Button disabled={busy !== null} onClick={() => decide(true)}>
                {busy === "accept" ? "Authorizing…" : "Authorize"}
              </Button>
              <Button variant="ghost" disabled={busy !== null} onClick={() => decide(false)}>
                {busy === "deny" ? "Denying…" : "Deny"}
              </Button>
            </>
          )}
          <p className="text-center text-xs text-muted-foreground">
            Only authorize clients you trust — they act on your projects with your permissions.
          </p>
        </CardFooter>
      </Card>
    </div>
  );
}
