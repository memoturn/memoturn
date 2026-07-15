import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { toast } from "sonner";
import { PageHeader } from "../../components/page-header";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
import { authClient } from "../../lib/auth";

export const Route = createFileRoute("/admin/users")({ component: AdminUsersPage });

function AdminUsersPage() {
  const qc = useQueryClient();
  const {
    data: users,
    isPending,
    error,
  } = useQuery({
    queryKey: ["admin-users"],
    queryFn: async () => {
      const res = await authClient.admin.listUsers({ query: { limit: 200 } });
      if (res.error) throw new Error(res.error.message ?? "Failed to list users");
      return res.data?.users ?? [];
    },
    retry: false,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["admin-users"] });

  const setRole = useMutation({
    mutationFn: async (v: { userId: string; role: "admin" | "user" }) => {
      const res = await authClient.admin.setRole({ userId: v.userId, role: v.role });
      if (res.error) throw new Error(res.error.message);
    },
    onSuccess: () => {
      toast.success("Role updated");
      invalidate();
    },
    onError: (e) => toast.error(String(e)),
  });

  const ban = useMutation({
    mutationFn: async (v: { userId: string; banned: boolean }) => {
      const res = v.banned
        ? await authClient.admin.unbanUser({ userId: v.userId })
        : await authClient.admin.banUser({ userId: v.userId });
      if (res.error) throw new Error(res.error.message);
    },
    onSuccess: () => {
      toast.success("Updated");
      invalidate();
    },
    onError: (e) => toast.error(String(e)),
  });

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Platform users" description="Manage every user account across the deployment." />
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            You don't have platform administrator access.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Platform users" description="Manage every user account across the deployment." />
      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b text-left text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">User</th>
                <th className="px-4 py-2 font-medium">Role</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {isPending ? (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-muted-foreground">
                    Loading…
                  </td>
                </tr>
              ) : (
                users?.map((u) => {
                  const isAdmin = u.role === "admin";
                  const isBanned = Boolean(u.banned);
                  return (
                    <tr key={u.id} className="border-b last:border-0">
                      <td className="px-4 py-2">
                        <div className="font-medium">{u.name || u.email}</div>
                        <div className="text-xs text-muted-foreground">{u.email}</div>
                      </td>
                      <td className="px-4 py-2">
                        <Badge variant={isAdmin ? "default" : "outline"}>{u.role || "user"}</Badge>
                      </td>
                      <td className="px-4 py-2">
                        {isBanned ? (
                          <Badge variant="destructive">banned</Badge>
                        ) : (
                          <span className="text-muted-foreground">active</span>
                        )}
                      </td>
                      <td className="px-4 py-2">
                        <div className="flex justify-end gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={setRole.isPending}
                            onClick={() => setRole.mutate({ userId: u.id, role: isAdmin ? "user" : "admin" })}
                          >
                            {isAdmin ? "Revoke admin" : "Make admin"}
                          </Button>
                          <Button
                            variant={isBanned ? "outline" : "destructive"}
                            size="sm"
                            disabled={ban.isPending}
                            onClick={() => ban.mutate({ userId: u.id, banned: isBanned })}
                          >
                            {isBanned ? "Unban" : "Ban"}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
