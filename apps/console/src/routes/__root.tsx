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
  ClipboardCheck,
  Database,
  FlaskConical,
  Gauge,
  History,
  LayoutDashboard,
  LogOut,
  MessagesSquare,
  ScatterChart,
  ScrollText,
  Search,
  Settings as SettingsIcon,
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
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { api, getActiveProject, setActiveProject } from "../lib/api";
import { signOut, useSession } from "../lib/auth";

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
  { to: "/audit", label: "Audit", icon: History },
  { to: "/organizations", label: "Organizations", icon: Building2 },
  { to: "/settings", label: "Settings", icon: SettingsIcon },
];

function isActivePath(pathname: string, to: string): boolean {
  if (to === "/dashboard") return pathname === "/" || pathname === "/dashboard" || pathname.startsWith("/dashboard/");
  return pathname === to || pathname.startsWith(`${to}/`);
}

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
      <SelectTrigger size="sm" className="w-full" aria-label="Active project">
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

function AppSidebar({ email, initials }: { email: string; initials: string }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
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
