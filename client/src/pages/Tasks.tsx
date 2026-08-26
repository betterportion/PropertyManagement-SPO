import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import RegionSelector from "@/components/RegionSelector";
import ActionItemList from "@/components/ActionItemList";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Plus, MoreVertical, ListChecks, CheckCircle2 } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { REGIONS } from "@shared/regions";
import { type Task } from "@shared/schema";
import { Section, Container, PageHeader, PageStack } from "@/components/layout/page";
import { LoadingState, EmptyState } from "@/components/states";
import { formatDate } from "@/lib/format";
import { type ActionItem } from "@/lib/actionItems";

const PERSONAL = "__me__";
const ALL_REGIONS = "__all__";

const taskFormSchema = z.object({
  title: z.string().min(1, "Enter a title").max(200),
  notes: z.string().max(2000).optional(),
  category: z.enum(["general", "property", "finance"]),
  dueDate: z.string().optional(),
  // Where the task goes: "Just me", "All regions" (admin), or a region name.
  scope: z.string().min(1, "Choose who this is for"),
});
type TaskForm = z.infer<typeof taskFormSchema>;

export default function Tasks() {
  const { user } = useAuth();
  const typedUser = user as { id?: string; role?: string } | null;
  const isAdmin = typedUser?.role === "admin";
  const { toast } = useToast();

  const [selectedRegion, setSelectedRegion] = useState("all");
  const [isAddOpen, setIsAddOpen] = useState(false);

  const { data: actionItems = [], isLoading } = useQuery<ActionItem[]>({ queryKey: ["/api/action-items"] });
  const { data: tasks = [] } = useQuery<Task[]>({ queryKey: ["/api/tasks"] });

  // A non-admin may only broadcast to regions they are assigned. Admins get all.
  const { data: permissionsData } = useQuery<{ allowedRegions?: string[] } | null>({
    queryKey: ["/api/users", typedUser?.id, "/permissions"],
    queryFn: async () => {
      if (!typedUser?.id) return null;
      const response = await fetch(`/api/users/${typedUser.id}/permissions`);
      if (!response.ok) return null;
      return response.json();
    },
    enabled: !!typedUser?.id && !isAdmin,
  });
  const scopeRegions = isAdmin ? REGIONS : (permissionsData?.allowedRegions ?? []);

  const addForm = useForm<TaskForm>({
    resolver: zodResolver(taskFormSchema),
    defaultValues: { title: "", notes: "", category: "general", dueDate: "", scope: PERSONAL },
  });

  const createMutation = useMutation({
    mutationFn: async (data: TaskForm) => {
      const payload: Record<string, unknown> = {
        title: data.title,
        notes: data.notes || null,
        category: data.category,
        dueDate: data.dueDate || null,
      };
      if (data.scope === PERSONAL) {
        payload.assignedToUserId = typedUser?.id;
        payload.region = null;
      } else if (data.scope === ALL_REGIONS) {
        payload.region = null;
      } else {
        payload.region = data.scope;
      }
      return apiRequest("POST", "/api/tasks", payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/action-items"] });
      setIsAddOpen(false);
      addForm.reset();
      toast({ title: "Task created" });
    },
    onError: () => toast({ title: "Error", description: "Could not create the task", variant: "destructive" }),
  });

  const setStatusMutation = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: "open" | "done" }) =>
      apiRequest("PATCH", `/api/tasks/${id}`, { status }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/action-items"] });
    },
    onError: () => toast({ title: "Error", description: "Could not update the task", variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => apiRequest("DELETE", `/api/tasks/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/action-items"] });
      toast({ title: "Task deleted" });
    },
    onError: () => toast({ title: "Error", description: "Could not delete the task", variant: "destructive" }),
  });

  const visibleItems = actionItems.filter(
    (item) => selectedRegion === "all" || item.region === selectedRegion || item.region === null,
  );

  const scopeLabel = (task: Task) => {
    if (task.assignedToUserId) return "Personal";
    if (task.region === null) return "All regions";
    return task.region;
  };

  return (
    <Section size="compact">
      <Container>
        <PageStack>
          <PageHeader
            title="Tasks"
            description="What needs attention across your houses — plus notes you add or broadcast to your regional admins."
          />

          <div className="flex flex-wrap items-center justify-between gap-4">
            <RegionSelector selectedRegion={selectedRegion} onRegionChange={setSelectedRegion} />
            <Dialog open={isAddOpen} onOpenChange={(o) => { setIsAddOpen(o); if (!o) addForm.reset(); }}>
              <DialogTrigger asChild>
                <Button data-testid="button-add-task"><Plus className="mr-2 h-4 w-4" /> Add task</Button>
              </DialogTrigger>
              <DialogContent className="max-w-lg">
                <DialogHeader>
                  <DialogTitle>Add a task</DialogTitle>
                  <DialogDescription>A note for yourself, or one broadcast to a region's admins.</DialogDescription>
                </DialogHeader>
                <Form {...addForm}>
                  <form onSubmit={addForm.handleSubmit((data) => createMutation.mutate(data))} className="space-y-4">
                    <FormField control={addForm.control} name="title" render={({ field }) => (
                      <FormItem>
                        <FormLabel>Title</FormLabel>
                        <FormControl><Input {...field} data-testid="input-task-title" placeholder="e.g. Replace furnace filters" /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                    <FormField control={addForm.control} name="notes" render={({ field }) => (
                      <FormItem>
                        <FormLabel>Notes <span className="text-muted-foreground text-xs">(optional)</span></FormLabel>
                        <FormControl><Textarea {...field} data-testid="input-task-notes" rows={3} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                    <div className="grid grid-cols-2 gap-4">
                      <FormField control={addForm.control} name="category" render={({ field }) => (
                        <FormItem>
                          <FormLabel>Category</FormLabel>
                          <Select onValueChange={field.onChange} value={field.value}>
                            <FormControl><SelectTrigger data-testid="select-task-category"><SelectValue /></SelectTrigger></FormControl>
                            <SelectContent>
                              <SelectItem value="general">General</SelectItem>
                              <SelectItem value="property">Property</SelectItem>
                              <SelectItem value="finance">Finance</SelectItem>
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )} />
                      <FormField control={addForm.control} name="dueDate" render={({ field }) => (
                        <FormItem>
                          <FormLabel>Due date <span className="text-muted-foreground text-xs">(optional)</span></FormLabel>
                          <FormControl><Input type="date" {...field} data-testid="input-task-due" /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                    </div>
                    <FormField control={addForm.control} name="scope" render={({ field }) => (
                      <FormItem>
                        <FormLabel>For</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value}>
                          <FormControl><SelectTrigger data-testid="select-task-scope"><SelectValue /></SelectTrigger></FormControl>
                          <SelectContent>
                            <SelectItem value={PERSONAL}>Just me</SelectItem>
                            {scopeRegions.map((r) => (
                              <SelectItem key={r} value={r}>{r} admins</SelectItem>
                            ))}
                            {isAdmin && <SelectItem value={ALL_REGIONS}>All regions</SelectItem>}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )} />
                    <DialogFooter>
                      <Button type="button" variant="secondary" onClick={() => setIsAddOpen(false)}>Cancel</Button>
                      <Button type="submit" disabled={createMutation.isPending} data-testid="button-submit-task">
                        {createMutation.isPending ? "Saving..." : "Add task"}
                      </Button>
                    </DialogFooter>
                  </form>
                </Form>
              </DialogContent>
            </Dialog>
          </div>

          {isLoading ? (
            <LoadingState message="Loading tasks..." />
          ) : (
            <Tabs defaultValue="todo" className="w-full">
              <TabsList className="grid w-full max-w-md grid-cols-2">
                <TabsTrigger value="todo" data-testid="tab-todo">
                  <ListChecks className="mr-2 h-4 w-4" /> To do
                </TabsTrigger>
                <TabsTrigger value="manage" data-testid="tab-manage">
                  <CheckCircle2 className="mr-2 h-4 w-4" /> Manage tasks
                </TabsTrigger>
              </TabsList>

              <TabsContent value="todo" className="mt-6">
                {visibleItems.length === 0 ? (
                  <EmptyState
                    icon={ListChecks}
                    title="Nothing needs attention"
                    description="Unpaid rent, deposits to return, maintenance coming due and your open tasks show up here."
                  />
                ) : (
                  <ActionItemList items={visibleItems} />
                )}
              </TabsContent>

              <TabsContent value="manage" className="mt-6">
                {tasks.length === 0 ? (
                  <EmptyState
                    title="No manual tasks yet"
                    description="Use “Add task” to create a note for yourself or broadcast one to a region's admins."
                  />
                ) : (
                  <div className="space-y-3">
                    {tasks.map((task) => (
                      <Card key={task.id} data-testid={`card-task-${task.id}`}>
                        <CardContent className="flex items-start justify-between gap-4 p-4">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className={`font-medium ${task.status === "done" ? "text-muted-foreground line-through" : ""}`}>{task.title}</p>
                              <Badge variant="secondary">{scopeLabel(task)}</Badge>
                              {task.status === "done" && <Badge variant="success">Done</Badge>}
                            </div>
                            {task.notes && <p className="mt-1 text-sm text-muted-foreground break-words">{task.notes}</p>}
                            {task.dueDate && (
                              <p className="mt-1 text-xs text-muted-foreground">Due {formatDate(task.dueDate)}</p>
                            )}
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => setStatusMutation.mutate({ id: task.id, status: task.status === "done" ? "open" : "done" })}
                              disabled={setStatusMutation.isPending}
                              data-testid={`button-toggle-task-${task.id}`}
                            >
                              {task.status === "done" ? "Reopen" : "Mark done"}
                            </Button>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button size="icon" variant="ghost" aria-label={`Actions for ${task.title}`} data-testid={`button-menu-task-${task.id}`}>
                                  <MoreVertical className="h-4 w-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem onClick={() => deleteMutation.mutate(task.id)} className="text-destructive">
                                  Delete
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                )}
              </TabsContent>
            </Tabs>
          )}
        </PageStack>
      </Container>
    </Section>
  );
}
