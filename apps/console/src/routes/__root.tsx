import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createRootRoute, Link, Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { CommandPalette } from "../components/CommandPalette";
import { TimeRangeSelect } from "../components/TimeRangeSelect";
import { api, getActiveProject, setActiveProject } from "../lib/api";
import { signOut, useSession } from "../lib/auth";

export const Route = createRootRoute({ component: RootComponent });

function ProjectSwitcher() {
  const qc = useQueryClient();
  const { data: projects } = useQuery({ queryKey: ["projects"], queryFn: () => api.listProjects() });
  const active = getActiveProject() || projects?.[0]?.id || "";
  if (!projects || projects.length === 0) return null;
  return (
    <select
      value={active}
      onChange={(e) => {
        setActiveProject(e.target.value);
        qc.invalidateQueries(); // refetch all data for the newly selected project
      }}
      title="Active project"
    >
      {projects.map((p) => (
        <option key={p.id} value={p.id}>
          {p.organization ? `${p.organization} / ` : ""}
          {p.name} ({p.role.toLowerCase()})
        </option>
      ))}
    </select>
  );
}

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
          <Link to="/sessions">Sessions</Link>
          <Link to="/prompts">Prompts</Link>
          <Link to="/datasets">Datasets</Link>
          <Link to="/playground">Playground</Link>
          <Link to="/evaluators">Evaluators</Link>
          <Link to="/review">Review</Link>
          <Link to="/audit">Audit</Link>
          <Link to="/organizations">Orgs</Link>
          <Link to="/settings">Settings</Link>
        </nav>
        <div className="spacer" />
        <button
          type="button"
          className="kbd"
          title="Command palette (⌘K)"
          onClick={() => window.dispatchEvent(new Event("memoturn:cmdk"))}
        >
          ⌘K
        </button>
        <TimeRangeSelect />
        <ProjectSwitcher />
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
      <CommandPalette />
    </>
  );
}
