import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { authClient, useSession } from "../lib/auth";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

/** Minimal typed fetch to the Better Auth endpoints the passkey client doesn't wrap directly. */
async function authApi<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/auth${path}`, {
    credentials: "include",
    headers: { "content-type": "application/json" },
    ...init,
  });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as T;
}

type PasskeyRow = { id: string; name?: string | null; deviceType?: string; createdAt?: string };

/**
 * Per-user account security: two-factor (TOTP + backup codes) and passkeys (WebAuthn).
 * Rendered in the Settings → Security tab. All state is the signed-in user's own.
 */
export function AccountSecurity() {
  return (
    <div className="space-y-6">
      <TwoFactorCard />
      <PasskeysCard />
    </div>
  );
}

function TwoFactorCard() {
  const { data: session } = useSession();
  const enabled = Boolean((session?.user as { twoFactorEnabled?: boolean } | undefined)?.twoFactorEnabled);

  const [password, setPassword] = useState("");
  const [setup, setSetup] = useState<{ totpURI: string; backupCodes: string[] } | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  // The shared secret, extracted from the otpauth:// URI for manual authenticator entry.
  const secret = setup ? new URLSearchParams(setup.totpURI.split("?")[1] ?? "").get("secret") : null;

  async function begin() {
    setBusy(true);
    const res = await authClient.twoFactor.enable({ password });
    setBusy(false);
    if (res.error) return toast.error(res.error.message ?? "Could not start 2FA setup");
    setSetup({ totpURI: res.data.totpURI, backupCodes: res.data.backupCodes });
    setPassword("");
  }

  async function confirm() {
    setBusy(true);
    const res = await authClient.twoFactor.verifyTotp({ code });
    setBusy(false);
    if (res.error) return toast.error(res.error.message ?? "Invalid code");
    toast.success("Two-factor authentication enabled");
    setSetup(null);
    setCode("");
  }

  async function disable() {
    setBusy(true);
    const res = await authClient.twoFactor.disable({ password });
    setBusy(false);
    if (res.error) return toast.error(res.error.message ?? "Could not disable 2FA");
    toast.success("Two-factor authentication disabled");
    setPassword("");
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Two-factor authentication</CardTitle>
        <CardDescription>
          {enabled
            ? "2FA is on. You'll be asked for a code from your authenticator app at sign-in."
            : "Add a second factor with an authenticator app (TOTP) plus one-time backup codes."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {enabled ? (
          <div className="flex items-end gap-2">
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="tf-disable-pw">Confirm password to disable</Label>
              <Input
                id="tf-disable-pw"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <Button variant="destructive" disabled={busy || !password} onClick={disable}>
              Disable
            </Button>
          </div>
        ) : setup ? (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>1. Add this secret to your authenticator app</Label>
              <code className="block break-all rounded bg-muted px-2 py-1.5 font-mono text-sm">{secret}</code>
              <p className="text-xs text-muted-foreground">
                Or open the setup URI: <span className="break-all">{setup.totpURI}</span>
              </p>
            </div>
            <div className="space-y-1.5">
              <Label>2. Save these backup codes somewhere safe</Label>
              <div className="grid grid-cols-2 gap-1 rounded bg-muted p-2 font-mono text-xs">
                {setup.backupCodes.map((c) => (
                  <span key={c}>{c}</span>
                ))}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tf-code">3. Enter the current 6-digit code to confirm</Label>
              <div className="flex gap-2">
                <Input
                  id="tf-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="123456"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
                <Button disabled={busy || code.length < 6} onClick={confirm}>
                  Confirm
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex items-end gap-2">
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="tf-enable-pw">Confirm password to begin</Label>
              <Input
                id="tf-enable-pw"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <Button disabled={busy || !password} onClick={begin}>
              Set up 2FA
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PasskeysCard() {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const { data: passkeys } = useQuery({
    queryKey: ["passkeys"],
    queryFn: () => authApi<PasskeyRow[]>("/passkey/list-user-passkeys"),
  });

  const add = useMutation({
    mutationFn: async () => {
      const res = await authClient.passkey.addPasskey({ name: name || undefined });
      if (res?.error) throw new Error(res.error.message ?? "Registration failed");
    },
    onSuccess: () => {
      toast.success("Passkey added");
      setName("");
      qc.invalidateQueries({ queryKey: ["passkeys"] });
    },
    onError: (e) => toast.error(`Could not add passkey: ${String(e)}`),
  });

  const remove = useMutation({
    mutationFn: (id: string) => authApi("/passkey/delete-passkey", { method: "POST", body: JSON.stringify({ id }) }),
    onSuccess: () => {
      toast.success("Passkey removed");
      qc.invalidateQueries({ queryKey: ["passkeys"] });
    },
    onError: (e) => toast.error(`Could not remove passkey: ${String(e)}`),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Passkeys</CardTitle>
        <CardDescription>
          Sign in without a password using Face ID, Touch ID, Windows Hello, or a hardware key.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-end gap-2">
          <div className="flex-1 space-y-1.5">
            <Label htmlFor="pk-name">Name (optional)</Label>
            <Input
              id="pk-name"
              placeholder="e.g. MacBook Touch ID"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <Button disabled={add.isPending} onClick={() => add.mutate()}>
            {add.isPending ? "Waiting…" : "Add passkey"}
          </Button>
        </div>

        {passkeys && passkeys.length > 0 ? (
          <ul className="divide-y rounded border">
            {passkeys.map((pk) => (
              <li key={pk.id} className="flex items-center justify-between px-3 py-2 text-sm">
                <span>
                  {pk.name || "Passkey"}
                  {pk.deviceType ? <span className="ml-2 text-xs text-muted-foreground">{pk.deviceType}</span> : null}
                </span>
                <Button variant="ghost" size="sm" disabled={remove.isPending} onClick={() => remove.mutate(pk.id)}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No passkeys registered yet.</p>
        )}
      </CardContent>
    </Card>
  );
}
