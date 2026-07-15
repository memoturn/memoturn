import { createFileRoute, Link } from "@tanstack/react-router";
import { AuthPanel } from "../components/auth-panel";
import { Logo } from "../components/logo";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../components/ui/card";

type SignupSearch = { redirect?: string };

export const Route = createFileRoute("/signup")({
  validateSearch: (s: Record<string, unknown>): SignupSearch => ({
    redirect: typeof s.redirect === "string" ? s.redirect : undefined,
  }),
  component: SignupPage,
});

function SignupPage() {
  const { redirect } = Route.useSearch();
  return (
    <div className="flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <Logo className="size-9" />
          <CardTitle>Create your memoturn account</CardTitle>
          <CardDescription>Start capturing traces, evals, and metrics in minutes.</CardDescription>
        </CardHeader>
        <CardContent>
          <AuthPanel mode="signup" redirect={redirect} />
        </CardContent>
        <CardFooter className="justify-center text-center text-xs text-muted-foreground">
          <span>
            Already have an account?{" "}
            <Link to="/login" className="text-foreground hover:underline">
              Sign in
            </Link>
          </span>
        </CardFooter>
      </Card>
    </div>
  );
}
