import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
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

  const [name, setName] = useState("");
  const createOrg = useMutation({
    mutationFn: () => unwrap(authClient.organization.create({ name, slug: slugify(name) || `org-${Date.now()}` })),
    onSuccess: () => {
      setName("");
      qc.invalidateQueries({ queryKey: ["orgs"] });
    },
  });

  const setActive = useMutation({
    mutationFn: (organizationId: string) => unwrap(authClient.organization.setActive({ organizationId })),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["active-org"] });
      qc.invalidateQueries({ queryKey: ["projects"] });
    },
  });

  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const invite = useMutation({
    mutationFn: () =>
      unwrap(
        authClient.organization.inviteMember({
          email,
          role: role as "member" | "admin" | "owner",
          organizationId: active?.id,
        }),
      ),
    onSuccess: () => {
      setEmail("");
      qc.invalidateQueries({ queryKey: ["active-org"] });
    },
  });

  const members = active?.members ?? [];
  const invitations = (active?.invitations ?? []).filter((i) => i.status === "pending");

  const { data: ssoProviders } = useQuery({
    queryKey: ["sso-providers"],
    queryFn: () => ssoFetch<{ providers: SsoProviderRow[] }>("providers").then((r) => r.providers),
  });
  const [ssoProviderId, setSsoProviderId] = useState("");
  const [ssoDomain, setSsoDomain] = useState("");
  const [ssoIssuer, setSsoIssuer] = useState("");
  const [ssoDiscovery, setSsoDiscovery] = useState("");
  const [ssoClientId, setSsoClientId] = useState("");
  const [ssoClientSecret, setSsoClientSecret] = useState("");
  const registerSso = useMutation({
    mutationFn: () =>
      ssoFetch("register", {
        providerId: ssoProviderId,
        issuer: ssoIssuer,
        domain: ssoDomain,
        organizationId: active?.id,
        oidcConfig: {
          clientId: ssoClientId,
          clientSecret: ssoClientSecret,
          discoveryEndpoint: ssoDiscovery,
        },
      }),
    onSuccess: () => {
      setSsoProviderId("");
      setSsoDomain("");
      setSsoIssuer("");
      setSsoDiscovery("");
      setSsoClientId("");
      setSsoClientSecret("");
      qc.invalidateQueries({ queryKey: ["sso-providers"] });
    },
  });
  const deleteSso = useMutation({
    mutationFn: (providerId: string) => ssoFetch("delete-provider", { providerId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sso-providers"] }),
  });

  return (
    <div>
      <h1>Organizations</h1>

      <h2>Your organizations</h2>
      <p className="obs-meta">An organization is a tenant: its projects, members, and data are isolated.</p>
      <div className="filters">
        <input placeholder="New organization name" value={name} onChange={(e) => setName(e.target.value)} />
        <button disabled={!name || createOrg.isPending} onClick={() => createOrg.mutate()}>
          {createOrg.isPending ? "Creating…" : "Create org"}
        </button>
      </div>
      {orgs && orgs.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Slug</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {orgs.map((o) => (
              <tr key={o.id}>
                <td>
                  {o.name}
                  {active?.id === o.id && <span className="badge gen"> active</span>}
                </td>
                <td className="obs-meta">{o.slug}</td>
                <td>
                  {active?.id !== o.id && (
                    <button className="link-btn" onClick={() => setActive.mutate(o.id)}>
                      set active
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {active && (
        <>
          <h2>Members of {active.name}</h2>
          <div className="filters">
            <input
              type="email"
              placeholder="invite by email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={{ width: 240 }}
            />
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="member">member</option>
              <option value="admin">admin</option>
              <option value="viewer">viewer</option>
              <option value="owner">owner</option>
            </select>
            <button disabled={!email || invite.isPending} onClick={() => invite.mutate()}>
              {invite.isPending ? "Inviting…" : "Invite"}
            </button>
          </div>
          {invite.isError && <p className="obs-meta">Invite failed: {String(invite.error)}</p>}
          <table>
            <thead>
              <tr>
                <th>User</th>
                <th>Role</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.id}>
                  <td>{m.user?.email ?? m.userId}</td>
                  <td>
                    <span className="badge">{m.role}</span>
                  </td>
                </tr>
              ))}
              {invitations.map((i) => (
                <tr key={i.id}>
                  <td className="obs-meta">{i.email}</td>
                  <td>
                    <span className="badge gen">invited ({i.role})</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <h2>SSO providers</h2>
          <p className="obs-meta">
            Let users at a domain sign in with an external OIDC identity provider. Users whose email domain matches are
            routed to the provider and land in this organization.
          </p>
          <div className="filters" style={{ flexWrap: "wrap", gap: 8 }}>
            <input
              placeholder="provider id (e.g. okta)"
              value={ssoProviderId}
              onChange={(e) => setSsoProviderId(e.target.value)}
            />
            <input placeholder="email domain" value={ssoDomain} onChange={(e) => setSsoDomain(e.target.value)} />
            <input
              placeholder="issuer URL"
              value={ssoIssuer}
              onChange={(e) => setSsoIssuer(e.target.value)}
              style={{ width: 220 }}
            />
            <input
              placeholder="discovery endpoint (.well-known)"
              value={ssoDiscovery}
              onChange={(e) => setSsoDiscovery(e.target.value)}
              style={{ width: 260 }}
            />
            <input placeholder="client id" value={ssoClientId} onChange={(e) => setSsoClientId(e.target.value)} />
            <input
              type="password"
              placeholder="client secret"
              value={ssoClientSecret}
              onChange={(e) => setSsoClientSecret(e.target.value)}
            />
            <button
              disabled={!ssoProviderId || !ssoDomain || !ssoIssuer || registerSso.isPending}
              onClick={() => registerSso.mutate()}
            >
              {registerSso.isPending ? "Registering…" : "Register OIDC provider"}
            </button>
          </div>
          {registerSso.isError && <p className="obs-meta">Register failed: {String(registerSso.error)}</p>}
          {ssoProviders && ssoProviders.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Domain</th>
                  <th>Issuer</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {ssoProviders.map((p) => (
                  <tr key={p.id}>
                    <td>{p.providerId}</td>
                    <td>{p.domain}</td>
                    <td className="obs-meta">{p.issuer}</td>
                    <td>
                      <button className="link-btn" onClick={() => deleteSso.mutate(p.providerId)}>
                        delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}
