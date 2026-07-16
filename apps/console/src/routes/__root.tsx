import {
  Button,
  Separator,
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "@memoturn/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createRootRoute, Link, Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import {
  Activity,
  Building2,
  Check,
  ChevronsUpDown,
  ClipboardCheck,
  Database,
  FlaskConical,
  Gauge,
  HeartPulse,
  History,
  LayoutDashboard,
  LogOut,
  MessagesSquare,
  Plus,
  ScatterChart,
  ScrollText,
  Search,
  Settings as SettingsIcon,
  ShieldCheck,
  Terminal,
  Users,
} from "lucide-react";
import { useEffect } from "react";
import { CommandPalette } from "../components/CommandPalette";
import { KeyboardHelp } from "../components/keyboard-help";
import { Logo } from "../components/logo";
import { ModeToggle } from "../components/mode-toggle";
import { TimeRangeSelect } from "../components/TimeRangeSelect";
import { Avatar, AvatarFallback } from "../components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { api, getActiveProject, setActiveProject } from "../lib/api";
import { signOut, useSession } from "../lib/auth";
import { cn } from "../lib/utils";

export const Route = createRootRoute({ component: RootComponent });

type NavItem = { to: string; label: string; icon: typeof Activity };

// Primary navigation — mirrors the product's mental model (observe → author → evaluate)
// rather than a flat bar. Each group renders as a labeled SidebarGroup.
const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
  {
    label: "Observability",
    items: [
      { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
      { to: "/traces", label: "Traces", icon: Activity },
      { to: "/sessions", label: "Sessions", icon: MessagesSquare },
      { to: "/users", label: "Users", icon: Users },
    ],
  },
  {
    label: "Prompts",
    items: [
      { to: "/prompts", label: "Prompts", icon: ScrollText },
      { to: "/playground", label: "Playground", icon: Terminal },
    ],
  },
  {
    label: "Evaluation",
    items: [
      { to: "/evaluators", label: "Evaluators", icon: Gauge },
      { to: "/datasets", label: "Datasets", icon: Database },
      { to: "/experiments", label: "Experiments", icon: FlaskConical },
      { to: "/embeddings", label: "Embeddings", icon: ScatterChart },
      { to: "/review", label: "Review", icon: ClipboardCheck },
    ],
  },
];

// Secondary navigation — pinned to the bottom (sidebar-08 NavSecondary pattern):
// operate/admin surfaces that shouldn't compete with the primary workflow groups.
const NAV_SECONDARY: NavItem[] = [
  { to: "/ops", label: "Ingest health", icon: HeartPulse },
  { to: "/audit", label: "Audit", icon: History },
  { to: "/organizations", label: "Organizations", icon: Building2 },
  { to: "/settings", label: "Settings", icon: SettingsIcon },
];

function isActivePath(pathname: string, to: string): boolean {
  if (to === "/dashboard") return pathname === "/" || pathname === "/dashboard" || pathname.startsWith("/dashboard/");
  return pathname === to || pathname.startsWith(`${to}/`);
}

const initials = (name: string) =>
  name
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, 2)
    .toUpperCase() || "··";

function ProjectSwitcher() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data: projects } = useQuery({ queryKey: ["projects"], queryFn: () => api.listProjects() });
  const activeId = getActiveProject() || projects?.[0]?.id || "";
  if (!projects || projects.length === 0) return null;
  const active = projects.find((p) => p.id === activeId) ?? projects[0];

  // Group projects under their organization so multi-org users can scan by tenant.
  const groups = new Map<string, typeof projects>();
  for (const p of projects) {
    const key = p.organization || "Projects";
    const list = groups.get(key) ?? [];
    list.push(p);
    groups.set(key, list);
  }

  const select = (id: string) => {
    if (id === activeId) return;
    setActiveProject(id);
    qc.invalidateQueries(); // refetch all data for the newly selected project
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Switch project"
          className="flex h-11 w-full items-center gap-2 rounded-md border bg-background px-2 text-left text-sm shadow-xs transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none data-[state=open]:bg-accent/50"
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-xs font-semibold text-primary-foreground">
            {initials(active?.name ?? "")}
          </span>
          <span className="grid min-w-0 flex-1 leading-tight">
            <span className="truncate font-medium">{active?.name}</span>
            {active?.organization && (
              <span className="truncate text-[0.6875rem] text-muted-foreground">{active.organization}</span>
            )}
          </span>
          <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-[--radix-dropdown-menu-trigger-width] min-w-60"
        // Anchor the menu to the trigger width but let it grow for long names.
      >
        {[...groups.entries()].map(([org, ps], i) => (
          <DropdownMenuGroup key={org}>
            {i > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel className="text-[0.625rem] uppercase tracking-wide text-muted-foreground">
              {org}
            </DropdownMenuLabel>
            {ps.map((p) => (
              <DropdownMenuItem key={p.id} onSelect={() => select(p.id)} className="gap-2">
                <span className="flex size-6 shrink-0 items-center justify-center rounded bg-muted text-[0.625rem] font-semibold">
                  {initials(p.name)}
                </span>
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
                <span className="text-[0.625rem] uppercase tracking-wide text-muted-foreground">
                  {p.role.toLowerCase()}
                </span>
                <Check className={cn("size-4 shrink-0", p.id === activeId ? "opacity-100" : "opacity-0")} />
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate({ to: "/organizations" })} className="gap-2 text-muted-foreground">
          <span className="flex size-6 shrink-0 items-center justify-center rounded border border-dashed">
            <Plus className="size-3.5" />
          </span>
          Add project
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AppSidebar({ email, initials }: { email: string; initials: string }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { data: session } = useSession();
  // Platform-admin nav is shown to users with the global admin role; superadmins designated
  // only by SUPERADMIN_USER_IDS can still reach /admin/users directly.
  const isAdmin = (session?.user as { role?: string } | undefined)?.role === "admin";
  return (
    <Sidebar collapsible="icon" variant="inset">
      <SidebarHeader className="gap-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link to="/" className="gap-2.5">
                <div className="flex aspect-square size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
                  <Logo mono className="size-4.5" />
                </div>
                <div className="grid flex-1 text-left leading-tight">
                  <span className="truncate text-sm font-semibold tracking-wide">memoturn</span>
                  <span className="truncate text-xs text-muted-foreground">AI engineering</span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <div className="group-data-[collapsible=icon]:hidden">
          <ProjectSwitcher />
        </div>
      </SidebarHeader>

      <SidebarContent>
        {NAV_GROUPS.map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => (
                  <SidebarMenuItem key={item.to}>
                    <SidebarMenuButton asChild isActive={isActivePath(pathname, item.to)} tooltip={item.label}>
                      <Link to={item.to}>
                        <item.icon />
                        <span>{item.label}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}

        <SidebarGroup className="mt-auto">
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV_SECONDARY.map((item) => (
                <SidebarMenuItem key={item.to}>
                  <SidebarMenuButton asChild size="sm" isActive={isActivePath(pathname, item.to)} tooltip={item.label}>
                    <Link to={item.to}>
                      <item.icon />
                      <span>{item.label}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
              {isAdmin && (
                <SidebarMenuItem>
                  <SidebarMenuButton
                    asChild
                    size="sm"
                    isActive={isActivePath(pathname, "/admin/users")}
                    tooltip="Platform users"
                  >
                    <Link to="/admin/users">
                      <ShieldCheck />
                      <span>Platform users</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton
                  size="lg"
                  className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
                >
                  <Avatar className="size-8 rounded-md">
                    <AvatarFallback className="rounded-md text-[0.625rem]">{initials}</AvatarFallback>
                  </Avatar>
                  <div className="grid flex-1 text-left leading-tight">
                    <span className="truncate text-sm font-medium">Account</span>
                    <span className="truncate text-xs text-muted-foreground">{email}</span>
                  </div>
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="right" align="end" className="w-56">
                <DropdownMenuLabel className="truncate font-normal">{email}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <a href="https://github.com/memoturn/memoturn" target="_blank" rel="noreferrer">
                    GitHub
                  </a>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <a href="https://github.com/memoturn/memoturn/tree/main/docs" target="_blank" rel="noreferrer">
                    Docs
                  </a>
                </DropdownMenuItem>
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
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

// Routes reachable without a session (sign-in, sign-up, and the email-link landing pages).
const PUBLIC_AUTH_ROUTES = [
  "/login",
  "/signup",
  "/forgot-password",
  "/reset-password",
  "/accept-invite",
  "/two-factor",
];
// Entry points a signed-in user should be bounced away from (they're already authenticated).
const AUTH_ENTRY_ROUTES = ["/login", "/signup"];

function RootComponent() {
  const { data: session, isPending } = useSession();
  const location = useLocation();
  const navigate = useNavigate();
  const path = location.pathname;
  const isPublicAuth = PUBLIC_AUTH_ROUTES.includes(path);
  const isAuthEntry = AUTH_ENTRY_ROUTES.includes(path);
  // A signed-in user with no active organization (e.g. a fresh social/password signup) needs
  // to create one before the project-scoped app is usable — onboard them on /organizations.
  const activeOrg = (session?.session as { activeOrganizationId?: string | null } | undefined)?.activeOrganizationId;
  const needsOrg = Boolean(session) && !activeOrg;

  // Gate the app: send unauthenticated users to /login (except the public auth pages), bounce
  // already-signed-in users off the login/signup entry points, and steer org-less accounts to
  // onboarding before anything project-scoped loads.
  useEffect(() => {
    if (isPending) return;
    if (!session && !isPublicAuth) navigate({ to: "/login" });
    else if (session && needsOrg && path !== "/organizations") navigate({ to: "/organizations" });
    else if (session && isAuthEntry && !needsOrg) navigate({ to: "/dashboard" });
  }, [isPending, session, isPublicAuth, isAuthEntry, needsOrg, path, navigate]);

  if (isPublicAuth) return <Outlet />;
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
    <SidebarProvider>
      <AppSidebar email={email} initials={initials} />
      <SidebarInset>
        <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/70">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-1 !h-5" />
          <Button
            variant="outline"
            size="sm"
            className="gap-2 text-muted-foreground"
            onClick={() => window.dispatchEvent(new Event("memoturn:cmdk"))}
          >
            <Search />
            <span className="hidden sm:inline">Search</span>
            <kbd className="hidden rounded border bg-muted px-1 font-mono text-[0.625rem] sm:inline">⌘K</kbd>
          </Button>
          <div className="ml-auto flex items-center gap-2">
            <TimeRangeSelect />
            <ModeToggle />
          </div>
        </header>
        <main className="flex flex-1 flex-col gap-4 p-4 md:p-6">
          <Outlet />
        </main>
      </SidebarInset>
      <CommandPalette />
      <KeyboardHelp />
    </SidebarProvider>
  );
}
