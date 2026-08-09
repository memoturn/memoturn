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
import { useSession } from "../lib/auth";

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
      // Pre-provision: the server seeds the sandbox first and emails the sign-in link only
      // once it's READY, so the visitor doesn't wait on a "preparing" screen the whole time.
      const res = await api.startDemo(email.trim());
      if (res.capacity) {
        toast.error("The demo is at capacity right now — please try again in a little while.");
        return;
      }
      if (res.rateLimited) {
        toast.error("Too many requests from your network. Please wait a minute and try again.");
        return;
      }
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
          <CardTitle>Try Memoturn</CardTitle>
          <CardDescription>
            Enter your email and we'll spin up a private sandbox pre-loaded with realistic traces, dashboards, prompts,
            and evals — no install, no credit card. It's read-only, and it expires on its own.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {sent ? (
            <div className="space-y-2 text-sm">
              <p className="font-medium">We're preparing your sandbox</p>
              <p className="text-muted-foreground">
                Your sign-in link will arrive at <span className="font-medium text-foreground">{email}</span> in a
                minute or two, once your sandbox is loaded with realistic traces, dashboards, prompts, and evals. Open
                it on this device to jump straight in.
              </p>
              <p className="text-muted-foreground">
                Nothing after a few minutes? Check your spam folder — it's the most common reason the link doesn't turn
                up.
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
