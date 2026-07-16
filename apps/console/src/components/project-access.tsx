import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "../lib/api";
import { KindBadge, type KindBadgeTone } from "./kind-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

const roleTone: Record<string, KindBadgeTone> = {
  owner: "violet",
  admin: "blue",
  member: "neutral",
  viewer: "amber",
};
const ROLES = ["owner", "admin", "member", "viewer"] as const;
// Sentinel for "no override" — clearing back to inheriting the org role.
const INHERIT = "__inherit__";

/**
 * Project-level RBAC management for the active project. Each org member can be given a role
 * that overrides their org role here; "Inherit" removes the override. Writes require OWNER/
 * ADMIN on this project (the API 403s otherwise — surfaced as a toast).
 */
export function ProjectAccess() {
  const qc = useQueryClient();
  const {
    data: members,
    isPending,
    error,
  } = useQuery({
    queryKey: ["project-members"],
    queryFn: api.listProjectMembers,
    retry: false,
  });

  const setRole = useMutation({
    mutationFn: ({ userId, value }: { userId: string; value: string }) =>
      value === INHERIT ? api.removeProjectMember(userId) : api.assignProjectMember(userId, value),
    onSuccess: () => {
      toast.success("Project role updated");
      qc.invalidateQueries({ queryKey: ["project-members"] });
      qc.invalidateQueries({ queryKey: ["projects"] });
    },
    onError: (e) => toast.error(`Update failed: ${String(e)}`),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Project access</CardTitle>
        <CardDescription>
          Assign per-project roles. A project role overrides the member's organization role for this project only —
          "Inherit" keeps their org role. Requires an owner/admin role on this project.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {error ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">Couldn't load project members.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b text-left text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Member</th>
                <th className="px-4 py-2 font-medium">Org role</th>
                <th className="px-4 py-2 font-medium">Project role</th>
              </tr>
            </thead>
            <tbody>
              {isPending ? (
                <tr>
                  <td colSpan={3} className="px-4 py-6 text-center text-muted-foreground">
                    Loading…
                  </td>
                </tr>
              ) : members && members.length > 0 ? (
                members.map((m) => (
                  <tr key={m.userId} className="border-b last:border-0">
                    <td className="px-4 py-2">
                      <div className="font-medium">{m.name || m.email}</div>
                      <div className="text-xs text-muted-foreground">{m.email}</div>
                    </td>
                    <td className="px-4 py-2">
                      <KindBadge tone={roleTone[m.orgRole] ?? "neutral"}>{m.orgRole}</KindBadge>
                    </td>
                    <td className="px-4 py-2">
                      <Select
                        value={m.projectRole ?? INHERIT}
                        onValueChange={(value) => setRole.mutate({ userId: m.userId, value })}
                      >
                        <SelectTrigger className="w-44">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={INHERIT}>Inherit ({m.orgRole})</SelectItem>
                          {ROLES.map((r) => (
                            <SelectItem key={r} value={r}>
                              {r}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={3} className="px-4 py-6 text-center text-muted-foreground">
                    No members.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}
