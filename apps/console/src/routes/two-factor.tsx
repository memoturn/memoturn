import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { Logo } from "../components/logo";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { authClient } from "../lib/auth";

type TwoFactorSearch = { redirect?: string };

export const Route = createFileRoute("/two-factor")({
  // The user has passed the first factor; Better Auth holds a partial session until this
  // challenge is met. redirect carries the original post-auth destination.
  validateSearch: (s: Record<string, unknown>): TwoFactorSearch => ({
    redirect: typeof s.redirect === "string" ? s.redirect : undefined,
  }),
  component: TwoFactorPage,
});

function TwoFactorPage() {
  const navigate = useNavigate();
  const { redirect } = Route.useSearch();
  const dest = redirect?.startsWith("/") ? redirect : "/dashboard";
  const [code, setCode] = useState("");
  const [backup, setBackup] = useState(false);
  const [busy, setBusy] = useState(false);

  async function verify() {
    setBusy(true);
    const res = backup
      ? await authClient.twoFactor.verifyBackupCode({ code })
      : await authClient.twoFactor.verifyTotp({ code });
    setBusy(false);
    if (res.error) {
      toast.error(res.error.message ?? "Invalid code");
      return;
    }
    navigate({ to: dest });
  }

  return (
    <div className="flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <Logo className="size-9" />
          <CardTitle>Two-factor authentication</CardTitle>
          <CardDescription>
            {backup ? "Enter one of your saved backup codes." : "Enter the 6-digit code from your authenticator app."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="tf-challenge">{backup ? "Backup code" : "Authentication code"}</Label>
            <Input
              id="tf-challenge"
              inputMode={backup ? "text" : "numeric"}
              autoComplete="one-time-code"
              placeholder={backup ? "xxxxxxxx" : "123456"}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") verify();
              }}
            />
          </div>
          <Button className="w-full" disabled={busy || !code} onClick={verify}>
            {busy ? "Verifying…" : "Verify"}
          </Button>
          <button
            type="button"
            className="w-full text-xs text-muted-foreground hover:text-foreground"
            onClick={() => {
              setBackup((b) => !b);
              setCode("");
            }}
          >
            {backup ? "Use your authenticator app instead" : "Use a backup code instead"}
          </button>
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
