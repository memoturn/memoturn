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
          <AuthPanel mode="signin" redirect={redirect} />
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
