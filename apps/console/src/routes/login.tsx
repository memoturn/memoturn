import { createFileRoute, Link } from "@tanstack/react-router";
import { AuthPanel } from "../components/auth-panel";
import { Logo } from "../components/logo";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../components/ui/card";

type LoginSearch = { redirect?: string };

export const Route = createFileRoute("/login")({
  // Honor a post-auth return path (e.g. the accept-invite flow bounces through here).
  validateSearch: (s: Record<string, unknown>): LoginSearch => ({
    redirect: typeof s.redirect === "string" ? s.redirect : undefined,
  }),
  component: LoginPage,
});

/**
 * When the OAuth 2.1 authorize flow (remote MCP) bounces an unauthenticated user here, the
 * URL carries the SIGNED authorization query (client_id, sig, …) instead of a `redirect`
 * param. Detect it and, after sign-in, resume the flow by sending the browser back to the
 * authorize endpoint with that query round-tripped verbatim — the signature covers it, so
 * it must not be re-serialized through router state.
 */
function oauthContinuation(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const q = new URLSearchParams(window.location.search);
  return q.has("client_id") && q.has("sig") ? `/api/auth/oauth2/authorize${window.location.search}` : undefined;
}

function LoginPage() {
  const { redirect } = Route.useSearch();
  return (
    <div className="flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <Logo className="size-9" />
          <CardTitle>Sign in to memoturn</CardTitle>
          <CardDescription>Welcome back — choose how you'd like to sign in.</CardDescription>
        </CardHeader>
        <CardContent>
          <AuthPanel mode="signin" redirect={oauthContinuation() ?? redirect} />
        </CardContent>
        <CardFooter className="flex-col items-stretch gap-2 text-center text-xs text-muted-foreground">
          <Link to="/forgot-password" className="hover:text-foreground">
            Forgot your password?
          </Link>
          <span>
            New to memoturn?{" "}
            <Link to="/signup" className="text-foreground hover:underline">
              Create an account
            </Link>
          </span>
        </CardFooter>
      </Card>
    </div>
  );
}
