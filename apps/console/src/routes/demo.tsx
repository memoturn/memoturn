import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Logo } from "../components/logo";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Skeleton } from "../components/ui/skeleton";
import { api } from "../lib/api";
import { authClient, useSession } from "../lib/auth";

export const Route = createFileRoute("/demo")({ component: DemoPage });

/**
 * Public-demo landing (DEMO_MODE). A visitor enters an email → magic link → sign-in, and
 * the server auto-provisions a read-only sandbox (org + project + seeded telemetry) in the
 * session hook. This page has two states: the email form (signed out) and a "preparing your
 * sandbox" screen that polls until the seed job reports READY, then lands on the dashboard.
 */
function DemoPage() {
  const { data: session, isPending } = useSession();
  if (isPending) return <Centered>Loading…</Centered>;
  return session ? <PreparingSandbox /> : <DemoSignIn />;
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-svh items-center justify-center p-4">{children}</div>;
}

function DemoSignIn() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setBusy(true);
    try {
      // callbackURL returns to /demo, where the preparing screen takes over.
      const res = await authClient.signIn.magicLink({ email: email.trim(), callbackURL: `${origin}/demo` });
      if (res.error) throw new Error(res.error.message || "Failed to send the link");
      setSent(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Centered>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <Logo className="size-9" />
          <CardTitle>Try memoturn</CardTitle>
          <CardDescription>
            Enter your email and we'll spin up a private sandbox pre-loaded with realistic traces, dashboards, prompts,
            and evals — no install, no credit card.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {sent ? (
            <div className="space-y-2 text-sm">
              <p className="font-medium">Check your inbox</p>
              <p className="text-muted-foreground">
                We sent a sign-in link to <span className="font-medium text-foreground">{email}</span>. Open it on this
                device to enter your sandbox.
              </p>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-3">
              <Input
                type="email"
                required
                autoFocus
                placeholder="you@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <Button type="submit" className="w-full" disabled={busy}>
                {busy ? "Sending…" : "Email me a sandbox link"}
              </Button>
            </form>
          )}
        </CardContent>
        <CardFooter className="text-center text-xs text-muted-foreground">
          Sandboxes are read-only and expire automatically. By continuing you agree to the demo being reset
          periodically.
        </CardFooter>
      </Card>
    </Centered>
  );
}

function PreparingSandbox() {
  const navigate = useNavigate();
  const { data: demo, isLoading } = useQuery({
    queryKey: ["demo-status"],
    queryFn: () => api.getDemoStatus(),
    // Poll while the seed job runs; stop once it settles (READY/FAILED) or there's no sandbox.
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s === "PENDING" || s === "SEEDING" ? 1500 : false;
    },
    refetchIntervalInBackground: true,
  });

  useEffect(() => {
    // No sandbox on this session (e.g. a returning user, or DEMO_MODE off) → just go to the app.
    if (!isLoading && (demo === null || demo?.status === "READY")) navigate({ to: "/dashboard" });
  }, [isLoading, demo, navigate]);

  return (
    <Centered>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <Logo className="size-9" />
          <CardTitle>{demo?.status === "FAILED" ? "Something went wrong" : "Preparing your sandbox"}</CardTitle>
          <CardDescription>
            {demo?.status === "FAILED"
              ? "We couldn't finish seeding your demo data. Please try again in a moment."
              : "Seeding realistic traces, dashboards, prompts, and evals — this takes a few seconds."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {demo?.status === "FAILED" ? (
            <Button className="w-full" onClick={() => window.location.reload()}>
              Retry
            </Button>
          ) : (
            <div className="space-y-3">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          )}
        </CardContent>
      </Card>
    </Centered>
  );
}
