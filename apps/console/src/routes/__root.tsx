import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createRootRoute, Link, Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import { LogOut, Search } from "lucide-react";
import { useEffect } from "react";
import { CommandPalette } from "../components/CommandPalette";
import { Logo } from "../components/logo";
import { ModeToggle } from "../components/mode-toggle";
import { TimeRangeSelect } from "../components/TimeRangeSelect";
import { Avatar, AvatarFallback } from "../components/ui/avatar";
import { Button } from "../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { api, getActiveProject, setActiveProject } from "../lib/api";
import { signOut, useSession } from "../lib/auth";

export const Route = createRootRoute({ component: RootComponent });

const NAV = [
  { to: "/dashboard", label: "Dashboard" },
  { to: "/traces", label: "Traces" },
  { to: "/sessions", label: "Sessions" },
  { to: "/prompts", label: "Prompts" },
  { to: "/datasets", label: "Datasets" },
  { to: "/playground", label: "Playground" },
  { to: "/evaluators", label: "Evaluators" },
  { to: "/review", label: "Review" },
  { to: "/audit", label: "Audit" },
  { to: "/organizations", label: "Orgs" },
  { to: "/settings", label: "Settings" },
] as const;

function ProjectSwitcher() {
  const qc = useQueryClient();
  const { data: projects } = useQuery({ queryKey: ["projects"], queryFn: () => api.listProjects() });
  const active = getActiveProject() || projects?.[0]?.id || "";
  if (!projects || projects.length === 0) return null;
  return (
    <Select
      value={active}
      onValueChange={(value) => {
        setActiveProject(value);
        qc.invalidateQueries(); // refetch all data for the newly selected project
      }}
    >
      <SelectTrigger size="sm" className="max-w-[220px]" aria-label="Active project">
        <SelectValue placeholder="Project" />
      </SelectTrigger>
      <SelectContent>
        {projects.map((p) => (
          <SelectItem key={p.id} value={p.id}>
            {p.organization ? `${p.organization} / ` : ""}
            {p.name} ({p.role.toLowerCase()})
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
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
  if (isPending)
    return <div className="flex min-h-svh items-center justify-center text-sm text-muted-foreground">Loading…</div>;
  if (!session)
    return (
      <div className="flex min-h-svh items-center justify-center text-sm text-muted-foreground">
        Redirecting to sign in…
      </div>
    );

  const email = session.user.email;
  const initials = email.slice(0, 2).toUpperCase();

  return (
    <div className="flex min-h-svh flex-col bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/70">
        <div className="flex h-14 items-center gap-4 px-4">
          <Link to="/" className="flex items-center gap-2 text-sm font-semibold tracking-widest uppercase">
            <Logo className="size-5" />
            memoturn
          </Link>
          <nav className="flex items-center gap-1 overflow-x-auto">
            {NAV.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                className="px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground data-[status=active]:bg-muted data-[status=active]:text-foreground"
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="gap-2 text-muted-foreground"
              onClick={() => window.dispatchEvent(new Event("memoturn:cmdk"))}
            >
              <Search />
              <span className="hidden sm:inline">Search</span>
              <kbd className="hidden border bg-muted px-1 font-mono text-[0.625rem] sm:inline">⌘K</kbd>
            </Button>
            <TimeRangeSelect />
            <ProjectSwitcher />
            <ModeToggle />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Account">
                  <Avatar className="size-7">
                    <AvatarFallback className="text-[0.625rem]">{initials}</AvatarFallback>
                  </Avatar>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel className="truncate font-normal">{email}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={async () => {
                    await signOut();
                    navigate({ to: "/login" });
                  }}
                >
                  <LogOut />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-6">
        <Outlet />
      </main>
      <footer className="border-t">
        <div className="mx-auto flex max-w-[1400px] flex-col items-center justify-between gap-3 px-4 py-5 text-xs text-muted-foreground sm:flex-row">
          <div className="flex items-center gap-2">
            <Logo className="size-4" />
            <span>memoturn — open-source AI engineering platform</span>
          </div>
          <div className="flex items-center gap-4">
            <a
              href="https://github.com/memoturn/memoturn"
              target="_blank"
              rel="noreferrer"
              className="transition-colors hover:text-foreground"
            >
              GitHub
            </a>
            <a
              href="https://github.com/memoturn/memoturn/tree/main/docs"
              target="_blank"
              rel="noreferrer"
              className="transition-colors hover:text-foreground"
            >
              Docs
            </a>
            <span>© 2026 memoturn</span>
          </div>
        </div>
      </footer>
      <CommandPalette />
    </div>
  );
}
