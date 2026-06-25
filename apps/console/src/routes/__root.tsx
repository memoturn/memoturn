import { Link, Outlet, createRootRoute, useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { signOut, useSession } from "../lib/auth";

export const Route = createRootRoute({ component: RootComponent });

function RootComponent() {
  const { data: session, isPending } = useSession();
  const location = useLocation();
  const navigate = useNavigate();
  const onLogin = location.pathname === "/login";

  // Gate the app: send unauthenticated users to /login (except the login page itself).
  useEffect(() => {
    if (!isPending && !session && !onLogin) navigate({ to: "/login" });
    if (!isPending && session && onLogin) navigate({ to: "/dashboard" });
  }, [isPending, session, onLogin, navigate]);

  if (onLogin) return <Outlet />;
  if (isPending) return <div className="container empty">Loading…</div>;
  if (!session) return <div className="container empty">Redirecting to sign in…</div>;

  return (
    <>
      <header className="topbar">
        <Link to="/" className="brand">
          memoturn
        </Link>
        <nav>
          <Link to="/dashboard">Dashboard</Link>
          <Link to="/traces">Traces</Link>
          <Link to="/prompts">Prompts</Link>
          <Link to="/datasets">Datasets</Link>
        </nav>
        <div className="spacer" />
        <span className="user">{session.user.email}</span>
        <button
          className="link-btn"
          onClick={async () => {
            await signOut();
            navigate({ to: "/login" });
          }}
        >
          Sign out
        </button>
      </header>
      <main className="container">
        <Outlet />
      </main>
    </>
  );
}
