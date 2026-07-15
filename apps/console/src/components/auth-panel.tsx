import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { api } from "../lib/api";
import { authClient } from "../lib/auth";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Separator } from "./ui/separator";

type Mode = "signin" | "signup";

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" role="img" aria-hidden="true">
      <title>Google</title>
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1Z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z"
      />
      <path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84Z" />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 7.3 9.14 5.38 12 5.38Z"
      />
    </svg>
  );
}

function GithubIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" role="img" aria-hidden="true" fill="currentColor">
      <title>GitHub</title>
      <path d="M12 1A11 11 0 0 0 8.52 22.44c.55.1.75-.24.75-.53v-1.86c-3.06.67-3.71-1.47-3.71-1.47-.5-1.28-1.22-1.62-1.22-1.62-1-.68.08-.67.08-.67 1.1.08 1.68 1.14 1.68 1.14.98 1.68 2.57 1.2 3.2.92.1-.71.38-1.2.7-1.47-2.44-.28-5-1.22-5-5.44 0-1.2.43-2.18 1.14-2.95-.11-.28-.5-1.4.11-2.92 0 0 .93-.3 3.05 1.13a10.6 10.6 0 0 1 5.56 0c2.12-1.43 3.05-1.13 3.05-1.13.61 1.52.22 2.64.11 2.92.71.77 1.14 1.75 1.14 2.95 0 4.23-2.57 5.15-5.02 5.43.39.34.74 1 .74 2.02v3c0 .29.2.64.75.53A11 11 0 0 0 12 1Z" />
    </svg>
  );
}

/**
 * Shared sign-in / sign-up surface. Leads with social + passwordless (magic link / email
 * code) and keeps email+password behind a toggle — the bootstrap fallback for self-host and
 * dev. Renders only the methods the server reports enabled at GET /auth-config, so it never
 * offers a dead button.
 */
export function AuthPanel({ mode, redirect }: { mode: Mode; redirect?: string }) {
  const navigate = useNavigate();
  const dest = redirect?.startsWith("/") ? redirect : "/dashboard";
  const { data: cfg } = useQuery({ queryKey: ["auth-config"], queryFn: api.getAuthConfig, staleTime: 60_000 });

  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [otpSent, setOtpSent] = useState(false);
  const [otp, setOtp] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");

  const go = () => navigate({ to: dest });
  const fail = (m?: string) => toast.error(m ?? "Something went wrong");
  // When the account has 2FA enabled, sign-in returns twoFactorRedirect instead of a session;
  // finish on the dedicated challenge page (which keeps the post-auth destination).
  const afterFirstFactor = (data: unknown) => {
    if (data && typeof data === "object" && "twoFactorRedirect" in data && data.twoFactorRedirect) {
      navigate({ to: "/two-factor", search: { redirect: dest } });
      return true;
    }
    return false;
  };

  async function social(provider: "google" | "github") {
    setBusy(provider);
    // Redirects the browser to the provider; on return Better Auth lands on callbackURL.
    await authClient.signIn.social({ provider, callbackURL: dest, errorCallbackURL: "/login" });
  }

  async function passkeySignIn() {
    setBusy("passkey");
    const res = await authClient.signIn.passkey();
    setBusy(null);
    if (res?.error) return fail(res.error.message ?? "Passkey sign-in failed");
    go();
  }

  async function sendMagicLink() {
    if (!email) return fail("Enter your email first");
    setBusy("magic");
    const res = await authClient.signIn.magicLink({ email, callbackURL: dest });
    setBusy(null);
    if (res.error) return fail(res.error.message ?? "Could not send link");
    toast.success("Check your email for a sign-in link");
  }

  async function sendOtp() {
    if (!email) return fail("Enter your email first");
    setBusy("otp");
    const res = await authClient.emailOtp.sendVerificationOtp({ email, type: "sign-in" });
    setBusy(null);
    if (res.error) return fail(res.error.message ?? "Could not send code");
    setOtpSent(true);
    toast.success("We emailed you a 6-digit code");
  }

  async function verifyOtp() {
    setBusy("otp-verify");
    const res = await authClient.signIn.emailOtp({ email, otp });
    setBusy(null);
    if (res.error) return fail(res.error.message ?? "Invalid or expired code");
    if (afterFirstFactor(res.data)) return;
    go();
  }

  async function passwordSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy("password");
    const res =
      mode === "signup"
        ? await authClient.signUp.email({ email, password, name: name || email })
        : await authClient.signIn.email({ email, password });
    setBusy(null);
    if (res.error) return fail(res.error.message ?? "Sign-in failed");
    if (afterFirstFactor(res.data)) return;
    go();
  }

  const anySocial = cfg?.social.google || cfg?.social.github;
  const showPasskey = cfg?.passkey && mode === "signin";
  const passwordless = cfg?.magicLink || cfg?.emailOtp;
  // Sign-up via password is hidden when the server disabled new password signups (cloud).
  const passwordAvailable = cfg?.password.enabled && !(mode === "signup" && cfg.password.signupDisabled);
  // Whether any non-password method is offered (drives the "or use a password" affordance).
  const hasOtherMethods = Boolean(anySocial || showPasskey || passwordless);

  return (
    <div className="space-y-4">
      {anySocial && (
        <div className="grid gap-2">
          {cfg?.social.google && (
            <Button variant="outline" className="w-full gap-2" disabled={!!busy} onClick={() => social("google")}>
              <GoogleIcon /> Continue with Google
            </Button>
          )}
          {cfg?.social.github && (
            <Button variant="outline" className="w-full gap-2" disabled={!!busy} onClick={() => social("github")}>
              <GithubIcon /> Continue with GitHub
            </Button>
          )}
        </div>
      )}

      {showPasskey && (
        <Button variant="outline" className="w-full gap-2" disabled={!!busy} onClick={passkeySignIn}>
          {busy === "passkey" ? "Waiting for passkey…" : "Sign in with a passkey"}
        </Button>
      )}

      {(anySocial || showPasskey) && passwordless && <OrDivider />}

      {passwordless && (
        <div className="space-y-2">
          <Label htmlFor="auth-email">Email</Label>
          <Input
            id="auth-email"
            type="email"
            autoComplete="email"
            placeholder="you@company.com"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setOtpSent(false);
            }}
          />
          {otpSent ? (
            <div className="space-y-2">
              <Label htmlFor="auth-otp">Enter the 6-digit code</Label>
              <Input
                id="auth-otp"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123456"
                value={otp}
                onChange={(e) => setOtp(e.target.value)}
              />
              <Button className="w-full" disabled={busy === "otp-verify" || otp.length < 6} onClick={verifyOtp}>
                {busy === "otp-verify" ? "Verifying…" : "Verify code"}
              </Button>
              <button
                type="button"
                className="w-full text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setOtpSent(false)}
              >
                Use a different method
              </button>
            </div>
          ) : (
            <div className="grid gap-2">
              {cfg?.magicLink && (
                <Button className="w-full" disabled={!!busy} onClick={sendMagicLink}>
                  {busy === "magic" ? "Sending…" : "Email me a sign-in link"}
                </Button>
              )}
              {cfg?.emailOtp && (
                <Button variant="outline" className="w-full" disabled={!!busy} onClick={sendOtp}>
                  {busy === "otp" ? "Sending…" : "Email me a code instead"}
                </Button>
              )}
            </div>
          )}
        </div>
      )}

      {passwordAvailable && hasOtherMethods && !showPassword && (
        <button
          type="button"
          className="w-full text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setShowPassword(true)}
        >
          {mode === "signup" ? "Sign up with a password instead" : "Sign in with a password instead"}
        </button>
      )}

      {passwordAvailable && (showPassword || !hasOtherMethods) && (
        <form onSubmit={passwordSubmit} className="space-y-3">
          {hasOtherMethods && <OrDivider />}
          {mode === "signup" && (
            <div className="space-y-1.5">
              <Label htmlFor="auth-name">Name</Label>
              <Input id="auth-name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
          )}
          {!passwordless && (
            <div className="space-y-1.5">
              <Label htmlFor="auth-email-pw">Email</Label>
              <Input
                id="auth-email-pw"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="auth-password">Password</Label>
            <Input
              id="auth-password"
              type="password"
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <Button type="submit" className="w-full" disabled={busy === "password"}>
            {busy === "password"
              ? mode === "signup"
                ? "Creating account…"
                : "Signing in…"
              : mode === "signup"
                ? "Create account"
                : "Sign in"}
          </Button>
        </form>
      )}
    </div>
  );
}

function OrDivider() {
  return (
    <div className="flex items-center gap-3">
      <Separator className="flex-1" />
      <span className="text-xs text-muted-foreground">or</span>
      <Separator className="flex-1" />
    </div>
  );
}
