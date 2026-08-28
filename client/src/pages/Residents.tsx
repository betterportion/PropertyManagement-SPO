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
import { Plus, MoreVertical, LogOut, Users, Download } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { type Resident, type Property, type RentPayment, type SecurityDeposit } from "@shared/schema";
import { z } from "zod";
import { Section, Container, PageHeader, PageStack } from "@/components/layout/page";
import { LoadingState, EmptyState } from "@/components/states";
import { formatDate, formatCurrency } from "@/lib/format";

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
  // How many people have been added since the dialog opened — the "enter a
  // full house in one sitting" flow keeps the dialog open between saves.
  const [addedCount, setAddedCount] = useState(0);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const { data: residents = [], isLoading } = useQuery<Resident[]>({
    queryKey: ["/api/residents"],
  });
  const { data: properties = [] } = useQuery<Property[]>({ queryKey: ["/api/properties"] });

  const { data: permissionsData } = useQuery<{
    canManageProperties?: boolean;
    canViewFinancials?: boolean;
    canManageFinancials?: boolean;
  } | null>({
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
    mutationFn: async ({ data }: { data: ResidentForm; addAnother: boolean }) =>
      apiRequest("POST", "/api/residents", data),
    onSuccess: (_result, { data, addAnother }) => {
      invalidate();
      if (addAnother) {
        // Keep the dialog open for the next housemate: same house, same
        // move-in date, fresh name and email.
        addForm.reset({
          propertyId: data.propertyId,
          moveInDate: data.moveInDate,
          firstName: "",
          lastName: "",
          email: "",
        });
        addForm.setFocus("firstName");
        setAddedCount((n) => n + 1);
        toast({ title: `${data.firstName} ${data.lastName} added` });
      } else {
        setIsAddOpen(false);
        setAddedCount(0);
        addForm.reset();
        toast({ title: "Resident added" });
      }
    },
    onError: () => toast({ title: "Error", description: "Could not add the resident", variant: "destructive" }),
  });

  // Move-out is a considered action, not a one-click one: the dialog states
  // who and which house, lets the date be corrected, shows what is still
  // outstanding, and offers to switch off a matching portal login.
  const [movingOut, setMovingOut] = useState<Resident | null>(null);
  const [moveOutDate, setMoveOutDate] = useState("");
  const [deactivateAccount, setDeactivateAccount] = useState(true);

  const seesFinance =
    typedUser?.role === "admin" ||
    permissionsData?.canViewFinancials === true ||
    permissionsData?.canManageFinancials === true;

  const { data: accountStatus } = useQuery<{ hasActiveAccount: boolean }>({
    queryKey: ["/api/residents", movingOut?.id ?? "", "account-status"],
    enabled: !!movingOut,
  });
  const { data: rentPayments = [] } = useQuery<RentPayment[]>({
    queryKey: ["/api/rent-payments"],
    enabled: !!movingOut && seesFinance,
  });
  const { data: deposits = [] } = useQuery<SecurityDeposit[]>({
    queryKey: ["/api/security-deposits"],
    enabled: !!movingOut && seesFinance,
  });

  const outstandingRent = movingOut
    ? rentPayments.filter(
        (p) => p.residentId === movingOut.id && (p.status === "unpaid" || p.status === "failed"),
      )
    : [];
  const heldDeposit = movingOut
    ? deposits.find((d) => d.residentId === movingOut.id && d.status === "held")
    : undefined;

  const openMoveOut = (resident: Resident) => {
    setMoveOutDate(new Date().toISOString().slice(0, 10));
    setDeactivateAccount(true);
    setMovingOut(resident);
  };

  const moveOutMutation = useMutation({
    mutationFn: async ({ id }: { id: string }) => {
      const response = await apiRequest("POST", `/api/residents/${id}/move-out`, {
        moveOutDate,
        deactivateAccount: deactivateAccount && accountStatus?.hasActiveAccount === true,
      });
      return response.json() as Promise<{ accountDeactivated: boolean }>;
    },
    onSuccess: ({ accountDeactivated }) => {
      invalidate();
      setMovingOut(null);
      toast({
        title: "Marked moved out",
        description: accountDeactivated
          ? "They now show under Former residents, and their portal login was switched off."
          : "They now show under Former residents.",
      });
    },
    onError: () => toast({ title: "Error", description: "Could not move the resident out", variant: "destructive" }),
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
  // The house filter lists every real property (optionally narrowed to the
  // chosen region), not just houses that already have residents -- so you can
  // pick any house and see its roster, even an empty one, and add the first
  // resident there. The value is the property address, which is what a
  // resident's buildingAddress holds.
  const buildings = properties
    .filter((p) => selectedRegion === "all" || p.region === selectedRegion)
    .map((p) => ({ id: p.address, address: p.name }));
  const selectedHouseName = selectedBuilding === "all"
    ? null
    : properties.find((p) => p.address === selectedBuilding)?.name ?? null;

  // Export the former residents currently in view (respects the region/house
  // filters) as a CSV the user can open in a spreadsheet.
  const formerResidents = visible.filter((r) => !r.isActive);
  const csvCell = (value: string | null | undefined) => {
    const s = String(value ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const exportFormerResidents = () => {
    const headers = ["First name", "Last name", "Email", "House", "Region", "Moved in", "Moved out"];
    const rows = formerResidents.map((r) => [
      r.firstName,
      r.lastName,
      r.email,
      propertyName(r.propertyId),
      r.region,
      r.moveInDate ? formatDate(r.moveInDate) : "",
      r.moveOutDate ? formatDate(r.moveOutDate) : "",
    ]);
    const csv = [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "former-residents.csv";
    link.click();
    URL.revokeObjectURL(url);
  };

  const renderTab = (active: boolean) => {
    const items = visible.filter((r) => r.isActive === active);
    if (items.length === 0) {
      const where = selectedHouseName ? ` in ${selectedHouseName}` : "";
      return (
        <EmptyState
          title={active ? `No current residents${where}` : `No former residents${where}`}
          description={active ? "Use “Add resident” to start the roster for a house." : "Residents you mark as moved out appear here."}
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
                            onClick={() => openMoveOut(r)}
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
              <RegionSelector
                selectedRegion={selectedRegion}
                onRegionChange={(v) => { setSelectedRegion(v); setSelectedBuilding("all"); }}
              />
              <BuildingSelector selectedBuilding={selectedBuilding} onBuildingChange={setSelectedBuilding} buildings={buildings} />
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                onClick={exportFormerResidents}
                disabled={formerResidents.length === 0}
                data-testid="button-export-former"
              >
                <Download className="mr-2 h-4 w-4" /> Export former
              </Button>
              {canManage && (
              <Dialog open={isAddOpen} onOpenChange={(o) => { setIsAddOpen(o); if (!o) { addForm.reset(); setAddedCount(0); } }}>
                <DialogTrigger asChild>
                  <Button data-testid="button-add-resident"><Plus className="mr-2 h-4 w-4" /> Add resident</Button>
                </DialogTrigger>
                <DialogContent className="max-w-lg">
                  <DialogHeader>
                    <DialogTitle>Add a resident</DialogTitle>
                    <DialogDescription>Record who is living in one of the houses.</DialogDescription>
                  </DialogHeader>
                  <Form {...addForm}>
                    <form onSubmit={addForm.handleSubmit((data) => createMutation.mutate({ data, addAnother: false }))} className="space-y-4">
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
                      {addedCount > 0 && (
                        <p className="text-sm text-muted-foreground" data-testid="text-added-count">
                          {addedCount} added to {propertyName(addForm.getValues("propertyId"))} so far.
                        </p>
                      )}
                      <DialogFooter>
                        <Button type="button" variant="secondary" onClick={() => setIsAddOpen(false)}>
                          {addedCount > 0 ? "Done" : "Cancel"}
                        </Button>
                        <Button
                          type="button"
                          variant="secondary"
                          disabled={createMutation.isPending}
                          onClick={addForm.handleSubmit((data) => createMutation.mutate({ data, addAnother: true }))}
                          data-testid="button-submit-resident-again"
                        >
                          Save & add another
                        </Button>
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

      <Dialog open={!!movingOut} onOpenChange={(o) => { if (!o) setMovingOut(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              Move out {movingOut?.firstName} {movingOut?.lastName}?
            </DialogTitle>
            <DialogDescription>
              From {movingOut ? propertyName(movingOut.propertyId) : ""}. Their maintenance
              history stays on record, and they move to the Former residents list. Nothing is
              deleted.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div>
              <Label htmlFor="move-out-date">Move-out date</Label>
              <Input
                id="move-out-date"
                type="date"
                value={moveOutDate}
                onChange={(e) => setMoveOutDate(e.target.value)}
                className="mt-1"
                data-testid="input-moveout-date"
              />
            </div>

            {seesFinance && (outstandingRent.length > 0 || heldDeposit) && (
              <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950" data-testid="text-moveout-outstanding">
                <p className="font-medium">Still outstanding</p>
                {outstandingRent.length > 0 && (
                  <p>
                    {outstandingRent.length} unpaid rent charge{outstandingRent.length === 1 ? "" : "s"} totaling{" "}
                    {formatCurrency(outstandingRent.reduce((sum, p) => sum + Number(p.amount), 0))}. These stay
                    on record after move-out.
                  </p>
                )}
                {heldDeposit && (
                  <p>
                    A security deposit of {formatCurrency(heldDeposit.amountHeld)} is still held. Settle it
                    from the Finances page.
                  </p>
                )}
              </div>
            )}

            {accountStatus?.hasActiveAccount && (
              <div className="flex items-start gap-2">
                <Checkbox
                  id="deactivate-account"
                  checked={deactivateAccount}
                  onCheckedChange={(checked) => setDeactivateAccount(checked === true)}
                  data-testid="checkbox-deactivate-account"
                />
                <div className="grid gap-1">
                  <Label htmlFor="deactivate-account">Also switch off their portal login</Label>
                  <p className="text-xs text-muted-foreground">
                    Their login can see the whole house's maintenance requests. Leave this checked
                    unless they are staying involved; an admin can reactivate it from Settings.
                  </p>
                </div>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setMovingOut(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => movingOut && moveOutMutation.mutate({ id: movingOut.id })}
              disabled={moveOutMutation.isPending || !moveOutDate}
              data-testid="button-confirm-moveout"
            >
              {moveOutMutation.isPending ? "Saving..." : "Mark moved out"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
