import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "../lib/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Label } from "./ui/label";
import { Switch } from "./ui/switch";

/**
 * Per-user notification settings.
 *
 * Deliberately NOT gated on `useIsReadOnly()` — every other panel on this page edits project
 * data, but this one edits the signed-in user's own inbox. A read-only viewer who gets
 * @mentioned must still be able to turn the email off.
 */
export function NotificationSettings() {
  const qc = useQueryClient();
  const { data: prefs, isPending } = useQuery({
    queryKey: ["notification-preferences"],
    queryFn: () => api.getNotificationPreferences(),
  });

  const save = useMutation({
    mutationFn: (patch: { mentionEmail?: boolean }) => api.updateNotificationPreferences(patch),
    onSuccess: (updated) => {
      qc.setQueryData(["notification-preferences"], updated);
      toast.success("Notification preferences saved");
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : String(e)),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Notifications</CardTitle>
        <CardDescription>
          What Memoturn emails you about. These are your own settings — they follow your account, not the project you're
          viewing.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-start justify-between gap-6">
          <div className="space-y-1">
            <Label htmlFor="mention-email">Mentions</Label>
            <p className="text-sm text-muted-foreground">
              Email me when a teammate @mentions me in a comment on a trace, observation, session, or prompt.
            </p>
          </div>
          <Switch
            id="mention-email"
            checked={prefs?.mentionEmail ?? true}
            disabled={isPending || save.isPending}
            onCheckedChange={(mentionEmail) => save.mutate({ mentionEmail })}
          />
        </div>
      </CardContent>
    </Card>
  );
}
