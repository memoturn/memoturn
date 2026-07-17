import { zodResolver } from "@hookform/resolvers/zod";
import type { Automation } from "@memoturn/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { Zap } from "lucide-react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { api } from "../lib/api";
import { useIsReadOnly } from "../lib/role";
import { DataTable } from "./data-table";
import { EmptyState } from "./empty-state";
import { HelpTip } from "./help-tip";
import { KindBadge } from "./kind-badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "./ui/form";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

const automationSchema = z.object({
  name: z.string().min(1, "Name is required"),
  trigger: z.string(),
  action: z.string(),
  target: z.string().min(1, "Target URL is required"),
  threshold: z.string(),
  filter: z.string(),
});
type AutomationForm = z.infer<typeof automationSchema>;

/**
 * Automations: run an action (webhook / Slack) when a trigger event fires. Extracted from the
 * settings page so it can serve both the Settings "Automations" tab and the first-class
 * `/automations` route (the Operate nav group) without duplicating the form/mutations.
 */
export function AutomationsPanel() {
  const qc = useQueryClient();
  const readOnly = useIsReadOnly();
  const { data: automations } = useQuery({ queryKey: ["automations"], queryFn: () => api.listAutomations() });
  const automationForm = useForm<AutomationForm>({
    resolver: zodResolver(automationSchema),
    defaultValues: { name: "", trigger: "score.created", action: "webhook", target: "", threshold: "", filter: "" },
  });
  const addAutomation = useMutation({
    mutationFn: (v: AutomationForm) =>
      api.createAutomation({
        name: v.name,
        trigger: v.trigger,
        action: v.action,
        target: v.target,
        threshold: v.threshold === "" ? null : Number(v.threshold),
        filter: v.filter || undefined,
      }),
    onSuccess: () => {
      toast.success("Automation added");
      automationForm.reset();
      qc.invalidateQueries({ queryKey: ["automations"] });
    },
    onError: (e) => toast.error(`Failed to add automation: ${String(e)}`),
  });
  const removeAutomation = useMutation({
    mutationFn: (id: string) => api.deleteAutomation(id),
    onSuccess: () => {
      toast.success("Automation deleted");
      qc.invalidateQueries({ queryKey: ["automations"] });
    },
    onError: (e) => toast.error(`Failed to delete automation: ${String(e)}`),
  });
  const automationColumns: ColumnDef<Automation>[] = [
    {
      accessorKey: "name",
      header: "Name",
      cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
    },
    {
      accessorKey: "trigger",
      header: "Trigger",
      cell: ({ row }) => <KindBadge tone="blue">{row.original.trigger}</KindBadge>,
    },
    {
      accessorKey: "action",
      header: "Action",
      cell: ({ row }) => <KindBadge tone="neutral">{row.original.action}</KindBadge>,
    },
    {
      accessorKey: "target",
      header: "Target",
      cell: ({ row }) => <span className="text-muted-foreground">{row.original.target}</span>,
    },
    { accessorKey: "threshold", header: "Threshold", cell: ({ row }) => row.original.threshold ?? "—" },
    {
      accessorKey: "filter",
      header: "Filter",
      cell: ({ row }) => <span className="text-muted-foreground">{row.original.filter || "—"}</span>,
    },
    {
      id: "actions",
      header: "",
      cell: ({ row }) => (
        <Button
          variant="destructive"
          size="sm"
          disabled={readOnly || removeAutomation.isPending}
          onClick={() => removeAutomation.mutate(row.original.id)}
        >
          Delete
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-1.5">
            Automations
            <HelpTip>Runs an action, such as a webhook or chat message, whenever a chosen trigger event fires.</HelpTip>
          </CardTitle>
          <CardDescription>
            Run an action when a trigger fires. Triggers: score.created, trace.created, eval.completed. Actions: a
            generic webhook (POST JSON) or a Slack message (to an incoming-webhook URL). Threshold fires only on low
            scores; filter is a substring match on the entity name.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...automationForm}>
            <form onSubmit={automationForm.handleSubmit((v) => addAutomation.mutate(v))} className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <FormField
                  control={automationForm.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Name</FormLabel>
                      <FormControl>
                        <Input placeholder="name" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={automationForm.control}
                  name="trigger"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Trigger</FormLabel>
                      <Select value={field.value} onValueChange={field.onChange}>
                        <FormControl>
                          <SelectTrigger className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="score.created">score.created</SelectItem>
                          <SelectItem value="trace.created">trace.created</SelectItem>
                          <SelectItem value="eval.completed">eval.completed</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={automationForm.control}
                  name="action"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Action</FormLabel>
                      <Select value={field.value} onValueChange={field.onChange}>
                        <FormControl>
                          <SelectTrigger className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="webhook">webhook</SelectItem>
                          <SelectItem value="slack">slack</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={automationForm.control}
                  name="target"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Target URL</FormLabel>
                      <FormControl>
                        <Input placeholder="target URL" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={automationForm.control}
                  name="threshold"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Threshold</FormLabel>
                      <FormControl>
                        <Input type="number" step="0.1" placeholder="optional" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={automationForm.control}
                  name="filter"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Filter</FormLabel>
                      <FormControl>
                        <Input placeholder="optional" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <Button type="submit" disabled={readOnly || addAutomation.isPending}>
                {addAutomation.isPending ? "Saving…" : "Add automation"}
              </Button>
            </form>
          </Form>
        </CardContent>
      </Card>

      {!automations || automations.length === 0 ? (
        <EmptyState icon={Zap} title="No automations yet" description="Add one above to react to score events." />
      ) : (
        <DataTable columns={automationColumns} data={automations} />
      )}
    </div>
  );
}
