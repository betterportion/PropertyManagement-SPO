import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import RegionSelector from "@/components/RegionSelector";
import BuildingSelector from "@/components/BuildingSelector";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Plus, MoreVertical, CheckCircle2, ShieldCheck, Wrench, ClipboardList } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { type MaintenanceSchedule, type Property } from "@shared/schema";
import { z } from "zod";
import { Section, Container, PageHeader, PageStack } from "@/components/layout/page";
import { LoadingState, EmptyState } from "@/components/states";
import { formatDate } from "@/lib/format";

const scheduleFormSchema = z.object({
  propertyId: z.string().min(1, "Choose a property"),
  title: z.string().min(1, "Give the task a name"),
  category: z.enum(["safety", "preventive"]),
  intervalMonths: z.coerce.number().int().min(1, "Recurs at least every month"),
  nextDueDate: z.string().min(1, "Pick the next due date"),
  notes: z.string().optional(),
});
type ScheduleForm = z.infer<typeof scheduleFormSchema>;

const DAY = 24 * 60 * 60 * 1000;

/** Overdue (past), due soon (within 30 days), or up to date. */
function statusOf(schedule: MaintenanceSchedule) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(schedule.nextDueDate);
  const days = Math.round((due.getTime() - today.getTime()) / DAY);
  if (days < 0) return { label: "Overdue", variant: "destructive" as const, ok: false };
  if (days <= 30) return { label: "Due soon", variant: "secondary" as const, ok: false };
  return { label: "Up to date", variant: "outline" as const, ok: true };
}

export default function Safety() {
  const { user } = useAuth();
  const typedUser = user as { id?: string; email?: string; role?: string } | null;
  const { toast } = useToast();

  const [selectedRegion, setSelectedRegion] = useState("all");
  const [selectedBuilding, setSelectedBuilding] = useState("all");
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const { data: schedules = [], isLoading } = useQuery<MaintenanceSchedule[]>({
    queryKey: ["/api/maintenance-schedules"],
  });
  const { data: properties = [] } = useQuery<Property[]>({ queryKey: ["/api/properties"] });

  const { data: permissionsData } = useQuery<{ canManageMaintenance?: boolean } | null>({
    queryKey: ["/api/users", typedUser?.id, "/permissions"],
    queryFn: async () => {
      if (!typedUser?.id) return null;
      const response = await fetch(`/api/users/${typedUser.id}/permissions`);
      if (!response.ok) return null;
      return response.json();
    },
    enabled: !!typedUser?.id,
  });
  const canManage =
    typedUser?.role === "admin" ||
    typedUser?.role === "regional_administrator" ||
    permissionsData?.canManageMaintenance ||
    false;

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/maintenance-schedules"] });
  };

  const createMutation = useMutation({
    mutationFn: async (data: ScheduleForm) => apiRequest("POST", "/api/maintenance-schedules", data),
    onSuccess: () => {
      invalidate();
      setIsAddOpen(false);
      addForm.reset();
      toast({ title: "Schedule added" });
    },
    onError: () => toast({ title: "Error", description: "Could not add the schedule", variant: "destructive" }),
  });

  const completeMutation = useMutation({
    mutationFn: async (id: string) => apiRequest("POST", `/api/maintenance-schedules/${id}/complete`),
    onSuccess: () => {
      invalidate();
      toast({ title: "Marked done", description: "The next due date has been advanced." });
    },
    onError: () => toast({ title: "Error", description: "Could not update the schedule", variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => apiRequest("DELETE", `/api/maintenance-schedules/${id}`),
    onSuccess: () => {
      invalidate();
      setDeletingId(null);
      toast({ title: "Schedule removed" });
    },
    onError: () => toast({ title: "Error", description: "Could not remove the schedule", variant: "destructive" }),
  });

  const applyTemplateMutation = useMutation({
    mutationFn: async (propertyId: string) =>
      apiRequest("POST", "/api/maintenance-schedules/apply-template", { propertyId }),
    onSuccess: async (res) => {
      const body = await res.json();
      invalidate();
      toast({
        title: body.created > 0 ? `Added ${body.created} standard schedules` : "Already up to date",
        description: body.created > 0 ? "Edit any of them to match this house." : "This house already has the standard set.",
      });
    },
    onError: () => toast({ title: "Error", description: "Could not apply the standard schedule", variant: "destructive" }),
  });

  const addForm = useForm<ScheduleForm>({
    resolver: zodResolver(scheduleFormSchema),
    defaultValues: { propertyId: "", title: "", category: "safety", intervalMonths: 12, nextDueDate: "", notes: "" },
  });

  const propertyName = (id: string) => properties.find((p) => p.id === id)?.name ?? "Unknown house";

  const visible = schedules.filter(
    (s) =>
      (selectedRegion === "all" || s.region === selectedRegion) &&
      (selectedBuilding === "all" || s.buildingAddress === selectedBuilding),
  );
  const buildings = Array.from(new Set(schedules.map((s) => s.buildingAddress).filter(Boolean))).map((a) => ({ id: a, address: a }));

  const renderTab = (category: "safety" | "preventive") => {
    const items = visible.filter((s) => s.category === category);
    if (items.length === 0) {
      return (
        <EmptyState
          title={category === "safety" ? "No safety checks scheduled" : "No preventive tasks scheduled"}
          description="Use “Apply standard schedule” on a house to add the usual set in one step, or add a task."
        />
      );
    }
    // Group by house so each shows its own compliance count.
    const byProperty = new Map<string, MaintenanceSchedule[]>();
    for (const s of items) {
      const list = byProperty.get(s.propertyId) ?? [];
      list.push(s);
      byProperty.set(s.propertyId, list);
    }
    return (
      <div className="space-y-6">
        {Array.from(byProperty.entries()).map(([propertyId, list]) => {
          const upToDate = list.filter((s) => statusOf(s).ok).length;
          return (
            <div key={propertyId} className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <h3 className="font-semibold">{propertyName(propertyId)}</h3>
                <span className="text-sm text-muted-foreground" data-testid={`compliance-${propertyId}`}>
                  {upToDate} of {list.length} up to date
                </span>
              </div>
              <div className="space-y-3">
                {list.map((s) => {
                  const status = statusOf(s);
                  return (
                    <Card key={s.id} data-testid={`card-schedule-${s.id}`}>
                      <CardContent className="flex items-start justify-between gap-4 p-4">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <p className="font-medium">{s.title}</p>
                            <Badge variant={status.variant}>{status.label}</Badge>
                          </div>
                          <p className="mt-1 text-sm text-muted-foreground">
                            Every {s.intervalMonths} {s.intervalMonths === 1 ? "month" : "months"} · next due {formatDate(s.nextDueDate)}
                            {s.lastCompletedDate ? ` · last done ${formatDate(s.lastCompletedDate)}` : " · never recorded"}
                          </p>
                          {s.notes && <p className="mt-1 text-sm text-muted-foreground">{s.notes}</p>}
                        </div>
                        {canManage && (
                          <div className="flex shrink-0 items-center gap-2">
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => completeMutation.mutate(s.id)}
                              disabled={completeMutation.isPending}
                              data-testid={`button-complete-${s.id}`}
                            >
                              <CheckCircle2 className="mr-1 h-4 w-4" /> Mark done
                            </Button>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button size="icon" variant="ghost" aria-label={`Actions for ${s.title}`} data-testid={`button-menu-schedule-${s.id}`}>
                                  <MoreVertical className="h-4 w-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem onClick={() => setDeletingId(s.id)} className="text-destructive">
                                  Remove
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <Section size="compact">
      <Container>
        <PageStack>
          <PageHeader
            title="Safety & Upkeep"
            description="Keep recurring safety checks and preventive maintenance on schedule across every house."
          />

          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex flex-wrap items-center gap-4">
              <RegionSelector selectedRegion={selectedRegion} onRegionChange={setSelectedRegion} />
              <BuildingSelector selectedBuilding={selectedBuilding} onBuildingChange={setSelectedBuilding} buildings={buildings} />
            </div>
            {canManage && (
              <div className="flex items-center gap-2">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="secondary" data-testid="button-apply-template">
                      <ClipboardList className="mr-2 h-4 w-4" /> Apply standard schedule
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto">
                    {properties.length === 0 && <DropdownMenuItem disabled>No houses yet</DropdownMenuItem>}
                    {properties.map((p) => (
                      <DropdownMenuItem
                        key={p.id}
                        onClick={() => applyTemplateMutation.mutate(p.id)}
                        data-testid={`apply-template-${p.id}`}
                      >
                        {p.name}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>

                <Dialog open={isAddOpen} onOpenChange={(o) => { setIsAddOpen(o); if (!o) addForm.reset(); }}>
                  <DialogTrigger asChild>
                    <Button data-testid="button-add-schedule"><Plus className="mr-2 h-4 w-4" /> Add schedule</Button>
                  </DialogTrigger>
                  <DialogContent className="max-w-lg">
                    <DialogHeader>
                      <DialogTitle>Add a maintenance schedule</DialogTitle>
                      <DialogDescription>A recurring safety check or preventive task for one house.</DialogDescription>
                    </DialogHeader>
                    <Form {...addForm}>
                      <form onSubmit={addForm.handleSubmit((data) => createMutation.mutate(data))} className="space-y-4">
                        <FormField control={addForm.control} name="propertyId" render={({ field }) => (
                          <FormItem>
                            <FormLabel>House</FormLabel>
                            <Select onValueChange={field.onChange} value={field.value}>
                              <FormControl><SelectTrigger data-testid="select-schedule-property"><SelectValue placeholder="Select a house" /></SelectTrigger></FormControl>
                              <SelectContent>
                                {properties.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                              </SelectContent>
                            </Select>
                            <FormMessage />
                          </FormItem>
                        )} />
                        <FormField control={addForm.control} name="title" render={({ field }) => (
                          <FormItem>
                            <FormLabel>Task</FormLabel>
                            <FormControl><Input {...field} placeholder="e.g. Fire extinguisher check" data-testid="input-schedule-title" /></FormControl>
                            <FormMessage />
                          </FormItem>
                        )} />
                        <div className="grid grid-cols-2 gap-4">
                          <FormField control={addForm.control} name="category" render={({ field }) => (
                            <FormItem>
                              <FormLabel>Type</FormLabel>
                              <Select onValueChange={field.onChange} value={field.value}>
                                <FormControl><SelectTrigger data-testid="select-schedule-category"><SelectValue /></SelectTrigger></FormControl>
                                <SelectContent>
                                  <SelectItem value="safety">Safety check</SelectItem>
                                  <SelectItem value="preventive">Preventive</SelectItem>
                                </SelectContent>
                              </Select>
                              <FormMessage />
                            </FormItem>
                          )} />
                          <FormField control={addForm.control} name="intervalMonths" render={({ field }) => (
                            <FormItem>
                              <FormLabel>Every (months)</FormLabel>
                              <FormControl><Input type="number" min={1} {...field} data-testid="input-schedule-interval" /></FormControl>
                              <FormMessage />
                            </FormItem>
                          )} />
                        </div>
                        <FormField control={addForm.control} name="nextDueDate" render={({ field }) => (
                          <FormItem>
                            <FormLabel>Next due</FormLabel>
                            <FormControl><Input type="date" {...field} data-testid="input-schedule-due" /></FormControl>
                            <FormMessage />
                          </FormItem>
                        )} />
                        <FormField control={addForm.control} name="notes" render={({ field }) => (
                          <FormItem>
                            <FormLabel>Notes <span className="text-muted-foreground text-xs">(optional)</span></FormLabel>
                            <FormControl><Textarea {...field} rows={2} data-testid="input-schedule-notes" /></FormControl>
                            <FormMessage />
                          </FormItem>
                        )} />
                        <DialogFooter>
                          <Button type="button" variant="secondary" onClick={() => setIsAddOpen(false)}>Cancel</Button>
                          <Button type="submit" disabled={createMutation.isPending} data-testid="button-submit-schedule">
                            {createMutation.isPending ? "Saving..." : "Add schedule"}
                          </Button>
                        </DialogFooter>
                      </form>
                    </Form>
                  </DialogContent>
                </Dialog>
              </div>
            )}
          </div>

          {isLoading ? (
            <LoadingState message="Loading schedules..." />
          ) : (
            <Tabs defaultValue="safety" className="w-full">
              <TabsList className="grid w-full max-w-md grid-cols-2">
                <TabsTrigger value="safety" data-testid="tab-safety">
                  <ShieldCheck className="mr-2 h-4 w-4" /> Safety checks
                </TabsTrigger>
                <TabsTrigger value="preventive" data-testid="tab-preventive">
                  <Wrench className="mr-2 h-4 w-4" /> Preventive
                </TabsTrigger>
              </TabsList>
              <TabsContent value="safety" className="mt-6">{renderTab("safety")}</TabsContent>
              <TabsContent value="preventive" className="mt-6">{renderTab("preventive")}</TabsContent>
            </Tabs>
          )}
        </PageStack>
      </Container>

      <AlertDialog open={!!deletingId} onOpenChange={() => setDeletingId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this schedule?</AlertDialogTitle>
            <AlertDialogDescription>
              This stops the recurring reminder. Requests it already created stay in the maintenance queue.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deletingId && deleteMutation.mutate(deletingId)}
              className="bg-destructive text-destructive-foreground"
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Section>
  );
}
