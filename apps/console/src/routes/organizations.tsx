import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { EmptyState } from "../components/empty-state";
import { KindBadge, type KindBadgeTone } from "../components/kind-badge";
import { PageHeader } from "../components/page-header";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "../components/ui/form";
import { Input } from "../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { authClient } from "../lib/auth";

export const Route = createFileRoute("/organizations")({ component: OrganizationsPage });

const slugify = (s: string) =>
  s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

// The better-auth client returns { data, error }; unwrap so TanStack Query sees errors.
async function unwrap<T>(p: Promise<{ data: T; error: unknown }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(typeof error === "string" ? error : JSON.stringify(error));
  return data;
}

const API_BASE = import.meta.env.VITE_API_BASE ?? "/api";

// SSO provider management lives under /auth/sso (session-authed).
async function ssoFetch<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}/auth/sso/${path}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : {},
    credentials: "include",
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

interface SsoProviderRow {
  id: string;
  providerId: string;
  issuer: string;
  domain: string;
  organizationId?: string | null;
}

const roleTone: Record<string, KindBadgeTone> = {
  owner: "violet",
  admin: "blue",
  member: "neutral",
  viewer: "amber",
};

const orgSchema = z.object({ name: z.string().min(1, "Organization name is required") });
type OrgForm = z.infer<typeof orgSchema>;

const inviteSchema = z.object({
  email: z.string().email("Valid email required"),
  role: z.enum(["member", "admin", "viewer", "owner"]),
});
type InviteForm = z.infer<typeof inviteSchema>;

const ssoSchema = z.object({
  providerId: z.string().min(1, "Provider id is required"),
  domain: z.string().min(1, "Email domain is required"),
  issuer: z.string().min(1, "Issuer URL is required"),
  discovery: z.string(),
  clientId: z.string(),
  clientSecret: z.string(),
});
type SsoForm = z.infer<typeof ssoSchema>;

function OrganizationsPage() {
  const qc = useQueryClient();
  const { data: orgs } = useQuery({
    queryKey: ["orgs"],
    queryFn: () => unwrap(authClient.organization.list()),
  });
  const { data: active } = useQuery({
    queryKey: ["active-org"],
    queryFn: () => unwrap(authClient.organization.getFullOrganization()),
  });

  const orgForm = useForm<OrgForm>({ resolver: zodResolver(orgSchema), defaultValues: { name: "" } });
  const createOrg = useMutation({
    mutationFn: (values: OrgForm) =>
      unwrap(authClient.organization.create({ name: values.name, slug: slugify(values.name) || `org-${Date.now()}` })),
    onSuccess: () => {
      toast.success("Organization created");
      orgForm.reset({ name: "" });
      qc.invalidateQueries({ queryKey: ["orgs"] });
    },
    onError: (e) => toast.error(`Failed to create organization: ${String(e)}`),
  });

  const setActive = useMutation({
    mutationFn: (organizationId: string) => unwrap(authClient.organization.setActive({ organizationId })),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["active-org"] });
      qc.invalidateQueries({ queryKey: ["projects"] });
    },
    onError: (e) => toast.error(`Failed to switch organization: ${String(e)}`),
  });

  const inviteForm = useForm<InviteForm>({
    resolver: zodResolver(inviteSchema),
    defaultValues: { email: "", role: "member" },
  });
  const invite = useMutation({
    mutationFn: (values: InviteForm) =>
      unwrap(
        authClient.organization.inviteMember({
          email: values.email,
          role: values.role as "member" | "admin" | "owner",
          organizationId: active?.id,
        }),
      ),
    onSuccess: () => {
      toast.success("Invitation sent");
      inviteForm.reset({ email: "", role: "member" });
      qc.invalidateQueries({ queryKey: ["active-org"] });
    },
    onError: (e) => toast.error(`Invite failed: ${String(e)}`),
  });

  const members = active?.members ?? [];
  const invitations = (active?.invitations ?? []).filter((i) => i.status === "pending");

  const { data: ssoProviders } = useQuery({
    queryKey: ["sso-providers"],
    queryFn: () => ssoFetch<{ providers: SsoProviderRow[] }>("providers").then((r) => r.providers),
  });
  const ssoForm = useForm<SsoForm>({
    resolver: zodResolver(ssoSchema),
    defaultValues: { providerId: "", domain: "", issuer: "", discovery: "", clientId: "", clientSecret: "" },
  });
  const registerSso = useMutation({
    mutationFn: (values: SsoForm) =>
      ssoFetch("register", {
        providerId: values.providerId,
        issuer: values.issuer,
        domain: values.domain,
        organizationId: active?.id,
        oidcConfig: {
          clientId: values.clientId,
          clientSecret: values.clientSecret,
          discoveryEndpoint: values.discovery,
        },
      }),
    onSuccess: () => {
      toast.success("OIDC provider registered");
      ssoForm.reset({ providerId: "", domain: "", issuer: "", discovery: "", clientId: "", clientSecret: "" });
      qc.invalidateQueries({ queryKey: ["sso-providers"] });
    },
    onError: (e) => toast.error(`Register failed: ${String(e)}`),
  });
  const deleteSso = useMutation({
    mutationFn: (providerId: string) => ssoFetch("delete-provider", { providerId }),
    onSuccess: () => {
      toast.success("Provider deleted");
      qc.invalidateQueries({ queryKey: ["sso-providers"] });
    },
    onError: (e) => toast.error(`Delete failed: ${String(e)}`),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Organizations"
        description="An organization is a tenant: its projects, members, and data are isolated."
      />

      <Card>
        <CardHeader>
          <CardTitle>Your organizations</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Form {...orgForm}>
            <form
              onSubmit={orgForm.handleSubmit((v) => createOrg.mutate(v))}
              className="flex flex-wrap items-start gap-3"
            >
              <FormField
                control={orgForm.control}
                name="name"
                render={({ field }) => (
                  <FormItem className="flex-1 min-w-60">
                    <FormControl>
                      <Input placeholder="New organization name" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <Button type="submit" disabled={createOrg.isPending}>
                {createOrg.isPending ? "Creating…" : "Create org"}
              </Button>
            </form>
          </Form>

          {orgs && orgs.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Slug</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {orgs.map((o) => (
                  <TableRow key={o.id}>
                    <TableCell className="font-medium">
                      <span className="inline-flex items-center gap-2">
                        {o.name}
                        {active?.id === o.id && <KindBadge tone="green">active</KindBadge>}
                      </span>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{o.slug}</TableCell>
                    <TableCell className="text-right">
                      {active?.id !== o.id && (
                        <Button variant="ghost" size="sm" onClick={() => setActive.mutate(o.id)}>
                          set active
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {active && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Members of {active.name}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <Form {...inviteForm}>
                <form
                  onSubmit={inviteForm.handleSubmit((v) => invite.mutate(v))}
                  className="flex flex-wrap items-start gap-3"
                >
                  <FormField
                    control={inviteForm.control}
                    name="email"
                    render={({ field }) => (
                      <FormItem className="flex-1 min-w-60">
                        <FormControl>
                          <Input type="email" placeholder="invite by email" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={inviteForm.control}
                    name="role"
                    render={({ field }) => (
                      <FormItem className="w-40">
                        <Select value={field.value} onValueChange={field.onChange}>
                          <FormControl>
                            <SelectTrigger className="w-full">
                              <SelectValue />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="member">member</SelectItem>
                            <SelectItem value="admin">admin</SelectItem>
                            <SelectItem value="viewer">viewer</SelectItem>
                            <SelectItem value="owner">owner</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <Button type="submit" disabled={invite.isPending}>
                    {invite.isPending ? "Inviting…" : "Invite"}
                  </Button>
                </form>
              </Form>

              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>User</TableHead>
                    <TableHead>Role</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {members.map((m) => (
                    <TableRow key={m.id}>
                      <TableCell>{m.user?.email ?? m.userId}</TableCell>
                      <TableCell>
                        <KindBadge tone={roleTone[m.role] ?? "neutral"}>{m.role}</KindBadge>
                      </TableCell>
                    </TableRow>
                  ))}
                  {invitations.map((i) => (
                    <TableRow key={i.id}>
                      <TableCell className="text-muted-foreground">{i.email}</TableCell>
                      <TableCell>
                        <KindBadge tone="amber">invited ({i.role})</KindBadge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>SSO providers</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Let users at a domain sign in with an external OIDC identity provider. Users whose email domain matches
                are routed to the provider and land in this organization.
              </p>
              <Form {...ssoForm}>
                <form onSubmit={ssoForm.handleSubmit((v) => registerSso.mutate(v))} className="space-y-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <FormField
                      control={ssoForm.control}
                      name="providerId"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Provider id</FormLabel>
                          <FormControl>
                            <Input placeholder="e.g. okta" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={ssoForm.control}
                      name="domain"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Email domain</FormLabel>
                          <FormControl>
                            <Input placeholder="example.com" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={ssoForm.control}
                      name="issuer"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Issuer URL</FormLabel>
                          <FormControl>
                            <Input placeholder="https://idp.example.com" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={ssoForm.control}
                      name="discovery"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Discovery endpoint</FormLabel>
                          <FormControl>
                            <Input placeholder=".well-known/openid-configuration" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={ssoForm.control}
                      name="clientId"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Client id</FormLabel>
                          <FormControl>
                            <Input {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={ssoForm.control}
                      name="clientSecret"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Client secret</FormLabel>
                          <FormControl>
                            <Input type="password" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>
                  <Button type="submit" disabled={registerSso.isPending}>
                    {registerSso.isPending ? "Registering…" : "Register OIDC provider"}
                  </Button>
                </form>
              </Form>

              {ssoProviders && ssoProviders.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Provider</TableHead>
                      <TableHead>Domain</TableHead>
                      <TableHead>Issuer</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {ssoProviders.map((p) => (
                      <TableRow key={p.id}>
                        <TableCell className="font-medium">{p.providerId}</TableCell>
                        <TableCell>{p.domain}</TableCell>
                        <TableCell className="text-muted-foreground">{p.issuer}</TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive"
                            onClick={() => deleteSso.mutate(p.providerId)}
                          >
                            delete
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <EmptyState title="No SSO providers" description="Register an OIDC provider above." />
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
