import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import RegionSelector from "@/components/RegionSelector";
import BuildingSelector from "@/components/BuildingSelector";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Plus, MoreVertical, LogOut, Users } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { type Resident, type Property } from "@shared/schema";
import { z } from "zod";
import { Section, Container, PageHeader, PageStack } from "@/components/layout/page";
import { LoadingState, EmptyState } from "@/components/states";
import { formatDate } from "@/lib/format";

const residentFormSchema = z.object({
  propertyId: z.string().min(1, "Choose a house"),
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().min(1, "Last name is required"),
  email: z.string().email("Enter a valid email address"),
  moveInDate: z.string().optional(),
});
type ResidentForm = z.infer<typeof residentFormSchema>;

export default function Residents() {
  const { user } = useAuth();
  const typedUser = user as { id?: string; email?: string; role?: string } | null;
  const { toast } = useToast();

  const [selectedRegion, setSelectedRegion] = useState("all");
  const [selectedBuilding, setSelectedBuilding] = useState("all");
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const { data: residents = [], isLoading } = useQuery<Resident[]>({
    queryKey: ["/api/residents"],
  });
  const { data: properties = [] } = useQuery<Property[]>({ queryKey: ["/api/properties"] });

  const { data: permissionsData } = useQuery<{ canManageProperties?: boolean } | null>({
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
    permissionsData?.canManageProperties ||
    false;

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/residents"] });
  };

  const createMutation = useMutation({
    mutationFn: async (data: ResidentForm) => apiRequest("POST", "/api/residents", data),
    onSuccess: () => {
      invalidate();
      setIsAddOpen(false);
      addForm.reset();
      toast({ title: "Resident added" });
    },
    onError: () => toast({ title: "Error", description: "Could not add the resident", variant: "destructive" }),
  });

  const moveOutMutation = useMutation({
    mutationFn: async (id: string) =>
      apiRequest("PATCH", `/api/residents/${id}`, {
        isActive: false,
        moveOutDate: new Date().toISOString().slice(0, 10),
      }),
    onSuccess: () => {
      invalidate();
      toast({ title: "Marked moved out", description: "They now show under Former residents." });
    },
    onError: () => toast({ title: "Error", description: "Could not update the resident", variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => apiRequest("DELETE", `/api/residents/${id}`),
    onSuccess: () => {
      invalidate();
      setDeletingId(null);
      toast({ title: "Resident removed" });
    },
    onError: () => toast({ title: "Error", description: "Could not remove the resident", variant: "destructive" }),
  });

  const addForm = useForm<ResidentForm>({
    resolver: zodResolver(residentFormSchema),
    defaultValues: { propertyId: "", firstName: "", lastName: "", email: "", moveInDate: "" },
  });

  const propertyName = (id: string) => properties.find((p) => p.id === id)?.name ?? "Unknown house";

  const visible = residents.filter(
    (r) =>
      (selectedRegion === "all" || r.region === selectedRegion) &&
      (selectedBuilding === "all" || r.buildingAddress === selectedBuilding),
  );
  const buildings = Array.from(new Set(residents.map((r) => r.buildingAddress).filter(Boolean))).map((a) => ({ id: a, address: a }));

  const renderTab = (active: boolean) => {
    const items = visible.filter((r) => r.isActive === active);
    if (items.length === 0) {
      return (
        <EmptyState
          title={active ? "No current residents" : "No former residents"}
          description={active ? "Add a resident to start the roster for a house." : "Residents you mark as moved out appear here."}
        />
      );
    }
    // Group by house so each shows its own headcount.
    const byProperty = new Map<string, Resident[]>();
    for (const r of items) {
      const list = byProperty.get(r.propertyId) ?? [];
      list.push(r);
      byProperty.set(r.propertyId, list);
    }
    return (
      <div className="space-y-6">
        {Array.from(byProperty.entries()).map(([propertyId, list]) => (
          <div key={propertyId} className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h3 className="font-semibold">{propertyName(propertyId)}</h3>
              <span className="text-sm text-muted-foreground" data-testid={`headcount-${propertyId}`}>
                {list.length} {active ? (list.length === 1 ? "resident" : "residents") : "former"}
              </span>
            </div>
            <div className="space-y-3">
              {list.map((r) => (
                <Card key={r.id} data-testid={`card-resident-${r.id}`}>
                  <CardContent className="flex items-start justify-between gap-4 p-4">
                    <div className="min-w-0">
                      <p className="font-medium">{r.firstName} {r.lastName}</p>
                      <p className="mt-1 text-sm text-muted-foreground break-words">{r.email}</p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {r.moveInDate ? `Moved in ${formatDate(r.moveInDate)}` : "Move-in date not recorded"}
                        {r.moveOutDate ? ` · moved out ${formatDate(r.moveOutDate)}` : ""}
                      </p>
                    </div>
                    {canManage && (
                      <div className="flex shrink-0 items-center gap-2">
                        {active && (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => moveOutMutation.mutate(r.id)}
                            disabled={moveOutMutation.isPending}
                            data-testid={`button-moveout-${r.id}`}
                          >
                            <LogOut className="mr-1 h-4 w-4" /> Mark moved out
                          </Button>
                        )}
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button size="icon" variant="ghost" aria-label={`Actions for ${r.firstName} ${r.lastName}`} data-testid={`button-menu-resident-${r.id}`}>
                              <MoreVertical className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => setDeletingId(r.id)} className="text-destructive">
                              Remove
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  };

  return (
    <Section size="compact">
      <Container>
        <PageStack>
          <PageHeader
            title="Residents"
            description="Track who is living in each house — name, email, and when they moved in and out."
          />

          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex flex-wrap items-center gap-4">
              <RegionSelector selectedRegion={selectedRegion} onRegionChange={setSelectedRegion} />
              <BuildingSelector selectedBuilding={selectedBuilding} onBuildingChange={setSelectedBuilding} buildings={buildings} />
            </div>
            {canManage && (
              <Dialog open={isAddOpen} onOpenChange={(o) => { setIsAddOpen(o); if (!o) addForm.reset(); }}>
                <DialogTrigger asChild>
                  <Button data-testid="button-add-resident"><Plus className="mr-2 h-4 w-4" /> Add resident</Button>
                </DialogTrigger>
                <DialogContent className="max-w-lg">
                  <DialogHeader>
                    <DialogTitle>Add a resident</DialogTitle>
                    <DialogDescription>Record who is living in one of the houses.</DialogDescription>
                  </DialogHeader>
                  <Form {...addForm}>
                    <form onSubmit={addForm.handleSubmit((data) => createMutation.mutate(data))} className="space-y-4">
                      <FormField control={addForm.control} name="propertyId" render={({ field }) => (
                        <FormItem>
                          <FormLabel>House</FormLabel>
                          <Select onValueChange={field.onChange} value={field.value}>
                            <FormControl><SelectTrigger data-testid="select-resident-property"><SelectValue placeholder="Select a house" /></SelectTrigger></FormControl>
                            <SelectContent>
                              {properties.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )} />
                      <div className="grid grid-cols-2 gap-4">
                        <FormField control={addForm.control} name="firstName" render={({ field }) => (
                          <FormItem>
                            <FormLabel>First name</FormLabel>
                            <FormControl><Input {...field} data-testid="input-resident-first" /></FormControl>
                            <FormMessage />
                          </FormItem>
                        )} />
                        <FormField control={addForm.control} name="lastName" render={({ field }) => (
                          <FormItem>
                            <FormLabel>Last name</FormLabel>
                            <FormControl><Input {...field} data-testid="input-resident-last" /></FormControl>
                            <FormMessage />
                          </FormItem>
                        )} />
                      </div>
                      <FormField control={addForm.control} name="email" render={({ field }) => (
                        <FormItem>
                          <FormLabel>Email</FormLabel>
                          <FormControl><Input type="email" {...field} placeholder="name@spo.org" data-testid="input-resident-email" /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                      <FormField control={addForm.control} name="moveInDate" render={({ field }) => (
                        <FormItem>
                          <FormLabel>Move-in date <span className="text-muted-foreground text-xs">(optional)</span></FormLabel>
                          <FormControl><Input type="date" {...field} data-testid="input-resident-movein" /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                      <DialogFooter>
                        <Button type="button" variant="secondary" onClick={() => setIsAddOpen(false)}>Cancel</Button>
                        <Button type="submit" disabled={createMutation.isPending} data-testid="button-submit-resident">
                          {createMutation.isPending ? "Saving..." : "Add resident"}
                        </Button>
                      </DialogFooter>
                    </form>
                  </Form>
                </DialogContent>
              </Dialog>
            )}
          </div>

          {isLoading ? (
            <LoadingState message="Loading residents..." />
          ) : (
            <Tabs defaultValue="current" className="w-full">
              <TabsList className="grid w-full max-w-md grid-cols-2">
                <TabsTrigger value="current" data-testid="tab-current">
                  <Users className="mr-2 h-4 w-4" /> Current
                </TabsTrigger>
                <TabsTrigger value="former" data-testid="tab-former">
                  <LogOut className="mr-2 h-4 w-4" /> Former
                </TabsTrigger>
              </TabsList>
              <TabsContent value="current" className="mt-6">{renderTab(true)}</TabsContent>
              <TabsContent value="former" className="mt-6">{renderTab(false)}</TabsContent>
            </Tabs>
          )}
        </PageStack>
      </Container>

      <AlertDialog open={!!deletingId} onOpenChange={() => setDeletingId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this resident?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes the record entirely. To keep the history of who lived here, use “Mark moved out” instead.
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
