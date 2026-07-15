import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { Logo } from "../components/logo";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../components/ui/card";
import { authClient, useSession } from "../lib/auth";

type InviteSearch = { id?: string };

export const Route = createFileRoute("/accept-invite")({
  validateSearch: (s: Record<string, unknown>): InviteSearch => ({
    id: typeof s.id === "string" ? s.id : undefined,
  }),
  component: AcceptInvitePage,
});

function AcceptInvitePage() {
  const navigate = useNavigate();
  const { id } = Route.useSearch();
  const { data: session, isPending } = useSession();
  const [submitting, setSubmitting] = useState(false);

  async function accept() {
    if (!id) return;
    setSubmitting(true);
    const res = await authClient.organization.acceptInvitation({ invitationId: id });
    setSubmitting(false);
    if (res.error) {
      toast.error(res.error.message ?? "Could not accept invitation");
      return;
    }
    toast.success("Invitation accepted — welcome!");
    navigate({ to: "/dashboard" });
  }

  return (
    <div className="flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <Logo className="size-9" />
          <CardTitle>Join your team on memoturn</CardTitle>
          <CardDescription>
            {!id ? "This invitation link is missing or malformed." : "You've been invited to a memoturn organization."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!id ? null : isPending ? (
            <p className="text-sm text-muted-foreground">Checking your session…</p>
          ) : session ? (
            <Button className="w-full" onClick={accept} disabled={submitting}>
              {submitting ? "Accepting…" : "Accept invitation"}
            </Button>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Sign in (or create an account with this invited email) to accept.
              </p>
              <Button asChild className="w-full">
                {/* Return here after auth so the user lands back on the accept step. */}
                <Link to="/login" search={{ redirect: `/accept-invite?id=${id}` }}>
                  Sign in to continue
                </Link>
              </Button>
            </div>
          )}
        </CardContent>
        <CardFooter>
          <Button asChild variant="ghost" className="w-full">
            <Link to="/login">Cancel</Link>
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
