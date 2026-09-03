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
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Plus, MoreVertical, Check, Undo2, Wallet, PiggyBank, CalendarClock, AlertCircle } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { type RentPayment, type SecurityDeposit, type Resident, type Property } from "@shared/schema";
import { z } from "zod";
import { Section, Container, PageHeader, PageStack } from "@/components/layout/page";
import DepositLedger from "@/components/deposit/DepositLedger";
import SplitChargeDialog from "@/components/deposit/SplitChargeDialog";
import { LoadingState, EmptyState } from "@/components/states";
import { formatCurrency, formatDate } from "@/lib/format";

/** The current month as "YYYY-MM", read from the calendar parts locally. */
function currentPeriod(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}
const today = () => new Date().toISOString().slice(0, 10);

const generateFormSchema = z.object({
  propertyId: z.string().min(1, "Choose a house"),
  period: z.string().regex(/^\d{4}-\d{2}$/, "Pick a month"),
  amount: z.coerce.number().finite().min(0, "Enter an amount"),
});
type GenerateForm = z.infer<typeof generateFormSchema>;

const depositFormSchema = z.object({
  residentId: z.string().min(1, "Choose a resident"),
  amountHeld: z.coerce.number().finite().min(0, "Enter an amount"),
});
type DepositForm = z.infer<typeof depositFormSchema>;

const RENT_STATUS: Record<RentPayment["status"], { label: string; variant: "outline" | "secondary" | "destructive" }> = {
  paid: { label: "Paid", variant: "outline" },
  unpaid: { label: "Unpaid", variant: "destructive" },
  waived: { label: "Waived", variant: "secondary" },
  failed: { label: "Payment failed", variant: "destructive" },
};

const DEPOSIT_STATUS: Record<SecurityDeposit["status"], { label: string; variant: "outline" | "secondary" | "destructive" | "warning" }> = {
  held: { label: "Held", variant: "secondary" },
  statement_sent: { label: "Statement sent", variant: "warning" },
  returned: { label: "Returned", variant: "outline" },
  partially_returned: { label: "Partially returned", variant: "outline" },
  withheld: { label: "Withheld", variant: "destructive" },
};

export default function Finances() {
  const { user } = useAuth();
  const typedUser = user as { id?: string; email?: string; role?: string; permissions?: { canManageFinancials?: boolean } } | null;
  const { toast } = useToast();

  // Admins bypass the flag, exactly as the server does.
  const canManage = typedUser?.role === "admin" || typedUser?.permissions?.canManageFinancials === true;

  const [selectedRegion, setSelectedRegion] = useState("all");
  const [selectedBuilding, setSelectedBuilding] = useState("all");
  const [selectedPeriod, setSelectedPeriod] = useState(currentPeriod());
  const [isGenerateOpen, setIsGenerateOpen] = useState(false);
  const [isDepositOpen, setIsDepositOpen] = useState(false);
  const [editingDeposit, setEditingDeposit] = useState<SecurityDeposit | null>(null);
  const [deletingRent, setDeletingRent] = useState<string | null>(null);
  const [deletingDeposit, setDeletingDeposit] = useState<string | null>(null);

  const { data: payments = [], isLoading: rentLoading } = useQuery<RentPayment[]>({ queryKey: ["/api/rent-payments"] });
  const { data: deposits = [], isLoading: depLoading } = useQuery<SecurityDeposit[]>({ queryKey: ["/api/security-deposits"] });
  const { data: residents = [] } = useQuery<Resident[]>({ queryKey: ["/api/residents"] });
  const { data: properties = [] } = useQuery<Property[]>({ queryKey: ["/api/properties"] });

  const residentName = (id: string) => {
    const r = residents.find((x) => x.id === id);
    return r ? `${r.firstName} ${r.lastName}` : "Former resident";
  };
  const propertyName = (id: string) => properties.find((p) => p.id === id)?.name ?? "Unknown house";

  const invalidateRent = () => queryClient.invalidateQueries({ queryKey: ["/api/rent-payments"] });
  const invalidateDeposits = () => queryClient.invalidateQueries({ queryKey: ["/api/security-deposits"] });

  const inRegion = <T extends { region: string; buildingAddress: string }>(rows: T[]) =>
    rows.filter(
      (r) =>
        (selectedRegion === "all" || r.region === selectedRegion) &&
        (selectedBuilding === "all" || r.buildingAddress === selectedBuilding),
    );

  // List every real house (optionally narrowed to the region), not only houses
  // that already have finance records, so any house is selectable. The value is
  // the property address, matching each record's buildingAddress.
  const buildings = properties
    .filter((p) => selectedRegion === "all" || p.region === selectedRegion)
    .map((p) => ({ id: p.address, address: p.name }));

  // ── Rent ──────────────────────────────────────────────────────────────────
  const generateMutation = useMutation({
    mutationFn: async (data: GenerateForm) => apiRequest("POST", "/api/rent-payments/generate", data),
    onSuccess: async (res) => {
      const body = await res.json();
      invalidateRent();
      setIsGenerateOpen(false);
      generateForm.reset({ propertyId: "", period: selectedPeriod, amount: 0 });
      toast({
        title: body.created > 0 ? `Recorded rent for ${body.created} resident(s)` : "Nothing to record",
        description: body.created > 0 ? "Mark each one paid as the rent comes in." : "Every current resident already has a charge for that month.",
      });
    },
    onError: () => toast({ title: "Error", description: "Could not record rent for the house", variant: "destructive" }),
  });

  const setRentStatusMutation = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: RentPayment["status"] }) =>
      apiRequest("PATCH", `/api/rent-payments/${id}`, {
        status,
        paidDate: status === "paid" ? today() : null,
      }),
    onSuccess: () => invalidateRent(),
    onError: () => toast({ title: "Error", description: "Could not update the payment", variant: "destructive" }),
  });

  const deleteRentMutation = useMutation({
    mutationFn: async (id: string) => apiRequest("DELETE", `/api/rent-payments/${id}`),
    onSuccess: () => { invalidateRent(); setDeletingRent(null); toast({ title: "Charge removed" }); },
    onError: () => toast({ title: "Error", description: "Could not remove the charge", variant: "destructive" }),
  });

  const generateForm = useForm<GenerateForm>({
    resolver: zodResolver(generateFormSchema),
    defaultValues: { propertyId: "", period: selectedPeriod, amount: 0 },
  });

  // Prefill the amount from the last rent recorded for the chosen house.
  const watchedProperty = generateForm.watch("propertyId");
  const forWatchedHouse = payments.filter((p) => p.propertyId === watchedProperty);
  const lastAmountForHouse = forWatchedHouse.length ? forWatchedHouse[0].amount : undefined;

  const periodPayments = inRegion(payments).filter((p) => p.period === selectedPeriod);

  const renderRent = () => {
    if (periodPayments.length === 0) {
      return (
        <EmptyState
          title="No rent recorded for this month"
          description={canManage ? "Use “Record rent for a house” to add a charge for every current resident in one step." : "Nothing has been recorded for the selected month."}
        />
      );
    }
    const byProperty = new Map<string, RentPayment[]>();
    for (const p of periodPayments) {
      const list = byProperty.get(p.propertyId) ?? [];
      list.push(p);
      byProperty.set(p.propertyId, list);
    }
    return (
      <div className="space-y-6">
        {Array.from(byProperty.entries()).map(([propertyId, list]) => {
          const paid = list.filter((p) => p.status === "paid" || p.status === "waived").length;
          return (
            <div key={propertyId} className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <h3 className="font-semibold">{propertyName(propertyId)}</h3>
                <span className="text-sm text-muted-foreground" data-testid={`rent-paid-${propertyId}`}>
                  {paid} of {list.length} paid
                </span>
              </div>
              <div className="space-y-3">
                {list.map((p) => {
                  const status = RENT_STATUS[p.status];
                  return (
                    <Card key={p.id} data-testid={`card-rent-${p.id}`}>
                      <CardContent className="flex items-start justify-between gap-4 p-4">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <p className="font-medium">{residentName(p.residentId)}</p>
                            <Badge variant={status.variant}>{status.label}</Badge>
                          </div>
                          <p className="mt-1 text-sm text-muted-foreground">
                            {formatCurrency(p.amount)}
                            {p.paidDate ? ` · paid ${formatDate(p.paidDate)}` : ""}
                            {p.reference ? ` · ${p.reference}` : ""}
                          </p>
                        </div>
                        {canManage && (
                          <div className="flex shrink-0 items-center gap-2">
                            {p.status !== "paid" ? (
                              <Button size="sm" variant="secondary" onClick={() => setRentStatusMutation.mutate({ id: p.id, status: "paid" })} data-testid={`button-markpaid-${p.id}`}>
                                <Check className="mr-1 h-4 w-4" /> Mark paid
                              </Button>
                            ) : (
                              <Button size="sm" variant="ghost" onClick={() => setRentStatusMutation.mutate({ id: p.id, status: "unpaid" })} data-testid={`button-markunpaid-${p.id}`}>
                                <Undo2 className="mr-1 h-4 w-4" /> Mark unpaid
                              </Button>
                            )}
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button size="icon" variant="ghost" aria-label={`Actions for ${residentName(p.residentId)}'s rent`} data-testid={`button-menu-rent-${p.id}`}>
                                  <MoreVertical className="h-4 w-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                {p.status !== "waived" && (
                                  <DropdownMenuItem onClick={() => setRentStatusMutation.mutate({ id: p.id, status: "waived" })}>
                                    Mark waived
                                  </DropdownMenuItem>
                                )}
                                {p.status !== "failed" && (
                                  <DropdownMenuItem onClick={() => setRentStatusMutation.mutate({ id: p.id, status: "failed" })}>
                                    Mark payment failed
                                  </DropdownMenuItem>
                                )}
                                <DropdownMenuItem onClick={() => setDeletingRent(p.id)} className="text-destructive">
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

  // ── Deposits ────────────────────────────────────────────────────────────────
  const depositCreateMutation = useMutation({
    mutationFn: async (data: DepositForm) => apiRequest("POST", "/api/security-deposits", data),
    onSuccess: () => { invalidateDeposits(); setIsDepositOpen(false); depositForm.reset(); toast({ title: "Deposit recorded" }); },
    onError: async (err: any) => {
      const msg = err?.message?.includes("409") ? "This resident already has a deposit on file." : "Could not record the deposit";
      toast({ title: "Error", description: msg, variant: "destructive" });
    },
  });

  const depositUpdateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      apiRequest("PATCH", `/api/security-deposits/${id}`, data),
    onSuccess: () => { invalidateDeposits(); setEditingDeposit(null); toast({ title: "Deposit updated" }); },
    onError: () => toast({ title: "Error", description: "Could not update the deposit", variant: "destructive" }),
  });

  const deleteDepositMutation = useMutation({
    mutationFn: async (id: string) => apiRequest("DELETE", `/api/security-deposits/${id}`),
    onSuccess: () => { invalidateDeposits(); setDeletingDeposit(null); toast({ title: "Deposit removed" }); },
    onError: () => toast({ title: "Error", description: "Could not remove the deposit", variant: "destructive" }),
  });

  const depositForm = useForm<DepositForm>({
    resolver: zodResolver(depositFormSchema),
    defaultValues: { residentId: "", amountHeld: 0 },
  });

  // Only current residents who do not already have a deposit can be added.
  const residentsWithoutDeposit = residents.filter(
    (r) => r.isActive && !deposits.some((d) => d.residentId === r.id),
  );

  const visibleDeposits = inRegion(deposits);

  // Which house a common-area charge is being split across, if any.
  const [splitPropertyId, setSplitPropertyId] = useState<string>("");
  const [isSplitOpen, setIsSplitOpen] = useState(false);
  const splitProperty = properties.find((property) => property.id === splitPropertyId) ?? null;

  const renderDeposits = () => {
    if (visibleDeposits.length === 0) {
      return (
        <EmptyState
          title="No deposits on file"
          description={canManage ? "Record a resident's deposit so it can be tracked through to return." : "Nothing has been recorded."}
        />
      );
    }
    const byProperty = new Map<string, SecurityDeposit[]>();
    for (const d of visibleDeposits) {
      const list = byProperty.get(d.propertyId) ?? [];
      list.push(d);
      byProperty.set(d.propertyId, list);
    }
    return (
      <div className="space-y-6">
        {Array.from(byProperty.entries()).map(([propertyId, list]) => (
          <div key={propertyId} className="space-y-3">
            <h3 className="font-semibold">{propertyName(propertyId)}</h3>
            <div className="space-y-3">
              {list.map((d) => {
                const status = DEPOSIT_STATUS[d.status];
                return (
                  <Card key={d.id} data-testid={`card-deposit-${d.id}`}>
                    <CardContent className="flex items-start justify-between gap-4 p-4">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="font-medium">{residentName(d.residentId)}</p>
                          <Badge variant={status.variant}>{status.label}</Badge>
                        </div>
                        <p className="mt-1 text-sm text-muted-foreground">
                          {formatCurrency(d.amountHeld)} held
                          {d.amountReturned ? ` · ${formatCurrency(d.amountReturned)} returned` : ""}
                          {d.returnedDate ? ` ${formatDate(d.returnedDate)}` : ""}
                        </p>
                      </div>
                      {canManage && (
                        <div className="flex shrink-0 items-center gap-2">
                          <Button size="sm" variant="secondary" onClick={() => setEditingDeposit(d)} data-testid={`button-edit-deposit-${d.id}`}>
                            Update
                          </Button>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button size="icon" variant="ghost" aria-label={`Actions for ${residentName(d.residentId)}'s deposit`} data-testid={`button-menu-deposit-${d.id}`}>
                                <MoreVertical className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => setDeletingDeposit(d.id)} className="text-destructive">
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

              {/* The itemised ledger, one per resident: what is held, what has
                  been taken off it, what is left, and the statement. The
                  legacy free-text note is shown inside it as history and is
                  never counted -- reading amounts out of a sentence somebody
                  typed would be a guess, and a guess here is a deposit that
                  comes back short. */}
              {list.map((d) => {
                const resident = residents.find((r) => r.id === d.residentId);
                if (!resident) return null;
                return (
                  <DepositLedger
                    key={`ledger-${d.id}`}
                    resident={resident}
                    deposit={d}
                    canManage={canManage}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>
    );
  };

  // ── Outstanding ─────────────────────────────────────────────────────────
  // The chase list, as opposed to the month-by-month bookkeeping views: every
  // unpaid or failed charge from any month, and every deposit still held for
  // someone who has moved out. Region and house filters apply as everywhere.
  const outstandingPayments = inRegion(payments)
    .filter((p) => p.status === "unpaid" || p.status === "failed")
    .sort((a, b) => a.period.localeCompare(b.period));
  const outstandingTotal = outstandingPayments.reduce((sum, p) => sum + Number(p.amount), 0);
  const failedPayments = outstandingPayments.filter((p) => p.status === "failed");
  const activeResidentIds = new Set(residents.filter((r) => r.isActive).map((r) => r.id));
  const depositsToSettle = inRegion(deposits).filter(
    (d) => d.status === "held" && !activeResidentIds.has(d.residentId),
  );

  const renderOutstanding = () => {
    if (outstandingPayments.length === 0 && depositsToSettle.length === 0) {
      return (
        <EmptyState
          title="Nothing outstanding"
          description="Every recorded charge is settled and no former resident's deposit is waiting. New unpaid months appear here as soon as rent is recorded."
        />
      );
    }
    const byProperty = new Map<string, RentPayment[]>();
    for (const p of outstandingPayments) {
      const list = byProperty.get(p.propertyId) ?? [];
      list.push(p);
      byProperty.set(p.propertyId, list);
    }
    return (
      <div className="space-y-6">
        <p className="text-sm text-muted-foreground" data-testid="text-outstanding-summary">
          {outstandingPayments.length > 0
            ? `${formatCurrency(outstandingTotal)} outstanding across ${outstandingPayments.length} charge${outstandingPayments.length === 1 ? "" : "s"}.`
            : "No rent outstanding."}
          {failedPayments.length > 0 &&
            ` ${failedPayments.length} ${failedPayments.length === 1 ? "payment has" : "payments have"} failed and may need a new payment or a follow-up.`}
          {depositsToSettle.length > 0 &&
            ` ${depositsToSettle.length} deposit${depositsToSettle.length === 1 ? "" : "s"} still held for former residents.`}
        </p>

        {Array.from(byProperty.entries()).map(([propertyId, list]) => (
          <div key={propertyId} className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h3 className="font-semibold">{propertyName(propertyId)}</h3>
              <span className="text-sm text-muted-foreground" data-testid={`outstanding-total-${propertyId}`}>
                {formatCurrency(list.reduce((sum, p) => sum + Number(p.amount), 0))} owed
              </span>
            </div>
            <div className="space-y-3">
              {list.map((p) => {
                const status = RENT_STATUS[p.status];
                return (
                  <Card key={p.id} data-testid={`card-outstanding-${p.id}`}>
                    <CardContent className="flex items-start justify-between gap-4 p-4">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="font-medium">{residentName(p.residentId)}</p>
                          <Badge variant={status.variant}>{status.label}</Badge>
                        </div>
                        <p className="mt-1 text-sm text-muted-foreground">
                          {p.period} · {formatCurrency(p.amount)}
                          {p.reference ? ` · ${p.reference}` : ""}
                        </p>
                      </div>
                      {canManage && (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => setRentStatusMutation.mutate({ id: p.id, status: "paid" })}
                          data-testid={`button-outstanding-markpaid-${p.id}`}
                        >
                          <Check className="mr-1 h-4 w-4" /> Mark paid
                        </Button>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </div>
        ))}

        {depositsToSettle.length > 0 && (
          <div className="space-y-3">
            <h3 className="font-semibold">Deposits to settle</h3>
            <div className="space-y-3">
              {depositsToSettle.map((d) => (
                <Card key={d.id} data-testid={`card-settle-deposit-${d.id}`}>
                  <CardContent className="flex items-start justify-between gap-4 p-4">
                    <div className="min-w-0">
                      <p className="font-medium">{residentName(d.residentId)}</p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {formatCurrency(d.amountHeld)} held · {propertyName(d.propertyId)} · resident has moved out
                      </p>
                    </div>
                    {canManage && (
                      <Button size="sm" variant="secondary" onClick={() => setEditingDeposit(d)} data-testid={`button-settle-deposit-${d.id}`}>
                        Settle
                      </Button>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <Section size="compact">
      <Container>
        <PageStack>
          <PageHeader
            title="Finances"
            description="Track monthly rent and security deposits for each resident. Visible to regional leads only."
          />

          <div className="flex flex-wrap items-center gap-4">
            <RegionSelector
              selectedRegion={selectedRegion}
              onRegionChange={(v) => { setSelectedRegion(v); setSelectedBuilding("all"); }}
            />
            <BuildingSelector selectedBuilding={selectedBuilding} onBuildingChange={setSelectedBuilding} buildings={buildings} />
          </div>

          {rentLoading || depLoading ? (
            <LoadingState message="Loading finances..." />
          ) : (
            <Tabs defaultValue="outstanding" className="w-full">
              <TabsList className="grid w-full max-w-md grid-cols-3">
                {/* The chase list lands first: the question a finance person
                    opens this page with is "who still owes us?" */}
                <TabsTrigger value="outstanding" data-testid="tab-outstanding"><AlertCircle className="mr-2 h-4 w-4" /> Outstanding</TabsTrigger>
                <TabsTrigger value="rent" data-testid="tab-rent"><Wallet className="mr-2 h-4 w-4" /> Rent</TabsTrigger>
                <TabsTrigger value="deposits" data-testid="tab-deposits"><PiggyBank className="mr-2 h-4 w-4" /> Deposits</TabsTrigger>
              </TabsList>

              <TabsContent value="outstanding" className="mt-6 space-y-4">
                {renderOutstanding()}
              </TabsContent>

              <TabsContent value="rent" className="mt-6 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div className="flex items-center gap-2">
                    <CalendarClock className="h-4 w-4 text-muted-foreground" />
                    <Label htmlFor="rent-period" className="text-sm text-muted-foreground">Month</Label>
                    <Input
                      id="rent-period"
                      type="month"
                      value={selectedPeriod}
                      onChange={(e) => setSelectedPeriod(e.target.value || currentPeriod())}
                      className="w-40"
                      data-testid="input-rent-period"
                    />
                  </div>
                  {canManage && (
                    <Dialog open={isGenerateOpen} onOpenChange={(o) => { setIsGenerateOpen(o); if (o) generateForm.reset({ propertyId: "", period: selectedPeriod, amount: 0 }); }}>
                      <DialogTrigger asChild>
                        <Button data-testid="button-record-rent"><Plus className="mr-2 h-4 w-4" /> Record rent for a house</Button>
                      </DialogTrigger>
                      <DialogContent className="max-w-lg">
                        <DialogHeader>
                          <DialogTitle>Record rent for a house</DialogTitle>
                          <DialogDescription>Adds an unpaid charge for every current resident of the house for the chosen month.</DialogDescription>
                        </DialogHeader>
                        <Form {...generateForm}>
                          <form onSubmit={generateForm.handleSubmit((data) => generateMutation.mutate(data))} className="space-y-4">
                            <FormField control={generateForm.control} name="propertyId" render={({ field }) => (
                              <FormItem>
                                <FormLabel>House</FormLabel>
                                <Select onValueChange={(v) => { field.onChange(v); const fh = payments.filter((p) => p.propertyId === v); if (fh.length) generateForm.setValue("amount", Number(fh[0].amount)); }} value={field.value}>
                                  <FormControl><SelectTrigger data-testid="select-rent-property"><SelectValue placeholder="Select a house" /></SelectTrigger></FormControl>
                                  <SelectContent>
                                    {properties.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                                  </SelectContent>
                                </Select>
                                <FormMessage />
                              </FormItem>
                            )} />
                            <div className="grid grid-cols-2 gap-4">
                              <FormField control={generateForm.control} name="period" render={({ field }) => (
                                <FormItem>
                                  <FormLabel>Month</FormLabel>
                                  <FormControl><Input type="month" {...field} data-testid="input-generate-period" /></FormControl>
                                  <FormMessage />
                                </FormItem>
                              )} />
                              <FormField control={generateForm.control} name="amount" render={({ field }) => (
                                <FormItem>
                                  <FormLabel>Monthly rent ($)</FormLabel>
                                  <FormControl><Input type="number" min={0} step="0.01" {...field} data-testid="input-generate-amount" /></FormControl>
                                  <FormMessage />
                                </FormItem>
                              )} />
                            </div>
                            {lastAmountForHouse && (
                              <p className="text-xs text-muted-foreground">Last recorded for this house: {formatCurrency(lastAmountForHouse)}.</p>
                            )}
                            <DialogFooter>
                              <Button type="button" variant="secondary" onClick={() => setIsGenerateOpen(false)}>Cancel</Button>
                              <Button type="submit" disabled={generateMutation.isPending} data-testid="button-submit-rent">
                                {generateMutation.isPending ? "Recording..." : "Record rent"}
                              </Button>
                            </DialogFooter>
                          </form>
                        </Form>
                      </DialogContent>
                    </Dialog>
                  )}
                </div>
                {renderRent()}
              </TabsContent>

              <TabsContent value="deposits" className="mt-6 space-y-4">
                {canManage && splitProperty && (
                  <SplitChargeDialog
                    property={splitProperty}
                    residents={residents.filter((r) => r.propertyId === splitProperty.id)}
                    open={isSplitOpen}
                    onOpenChange={setIsSplitOpen}
                  />
                )}
                {canManage && (
                  <div className="flex justify-end gap-2">
                    {/* A hole in a common room has to be divided across the
                        house. Where damage is attributable to one person, the
                        per-resident deduction is the right tool instead. */}
                    <Select
                      value={splitProperty?.id ?? ""}
                      onValueChange={(id) => {
                        setSplitPropertyId(id);
                        setIsSplitOpen(true);
                      }}
                    >
                      <SelectTrigger className="w-64" data-testid="select-split-property" aria-label="Split a common-area charge">
                        <SelectValue placeholder="Split a common-area charge" />
                      </SelectTrigger>
                      <SelectContent>
                        {properties.map((property) => (
                          <SelectItem key={property.id} value={property.id}>{property.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Dialog open={isDepositOpen} onOpenChange={(o) => { setIsDepositOpen(o); if (!o) depositForm.reset(); }}>
                      <DialogTrigger asChild>
                        <Button data-testid="button-add-deposit"><Plus className="mr-2 h-4 w-4" /> Add deposit</Button>
                      </DialogTrigger>
                      <DialogContent className="max-w-lg">
                        <DialogHeader>
                          <DialogTitle>Record a security deposit</DialogTitle>
                          <DialogDescription>Amounts and status only — never bank or card details.</DialogDescription>
                        </DialogHeader>
                        <Form {...depositForm}>
                          <form onSubmit={depositForm.handleSubmit((data) => depositCreateMutation.mutate(data))} className="space-y-4">
                            <FormField control={depositForm.control} name="residentId" render={({ field }) => (
                              <FormItem>
                                <FormLabel>Resident</FormLabel>
                                <Select onValueChange={field.onChange} value={field.value}>
                                  <FormControl><SelectTrigger data-testid="select-deposit-resident"><SelectValue placeholder="Select a resident" /></SelectTrigger></FormControl>
                                  <SelectContent>
                                    {residentsWithoutDeposit.length === 0 && <SelectItem value="none" disabled>Every current resident already has one</SelectItem>}
                                    {residentsWithoutDeposit.map((r) => (
                                      <SelectItem key={r.id} value={r.id}>{r.firstName} {r.lastName} — {propertyName(r.propertyId)}</SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                                <FormMessage />
                              </FormItem>
                            )} />
                            <FormField control={depositForm.control} name="amountHeld" render={({ field }) => (
                              <FormItem>
                                <FormLabel>Amount held ($)</FormLabel>
                                <FormControl><Input type="number" min={0} step="0.01" {...field} data-testid="input-deposit-amount" /></FormControl>
                                <FormMessage />
                              </FormItem>
                            )} />
                            <DialogFooter>
                              <Button type="button" variant="secondary" onClick={() => setIsDepositOpen(false)}>Cancel</Button>
                              <Button type="submit" disabled={depositCreateMutation.isPending} data-testid="button-submit-deposit">
                                {depositCreateMutation.isPending ? "Saving..." : "Add deposit"}
                              </Button>
                            </DialogFooter>
                          </form>
                        </Form>
                      </DialogContent>
                    </Dialog>
                  </div>
                )}
                {renderDeposits()}
              </TabsContent>
            </Tabs>
          )}
        </PageStack>
      </Container>

      <DepositEditDialog deposit={editingDeposit} onClose={() => setEditingDeposit(null)} onSave={(data) => editingDeposit && depositUpdateMutation.mutate({ id: editingDeposit.id, data })} pending={depositUpdateMutation.isPending} />

      <AlertDialog open={!!deletingRent} onOpenChange={() => setDeletingRent(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this rent charge?</AlertDialogTitle>
            <AlertDialogDescription>This deletes the record for that resident and month.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => deletingRent && deleteRentMutation.mutate(deletingRent)} className="bg-destructive text-destructive-foreground">Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!deletingDeposit} onOpenChange={() => setDeletingDeposit(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this deposit?</AlertDialogTitle>
            <AlertDialogDescription>This deletes the deposit record entirely.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => deletingDeposit && deleteDepositMutation.mutate(deletingDeposit)} className="bg-destructive text-destructive-foreground">Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Section>
  );
}

const depositEditSchema = z.object({
  status: z.enum(["held", "statement_sent", "returned", "partially_returned", "withheld"]),
  amountReturned: z.string().optional(),
  returnedDate: z.string().optional(),
  // The QuickBooks or Ramp reference for the transaction that returned the
  // money. A reference ONLY -- never an account or routing number. One column,
  // and it is what makes reconciliation possible later.
  closeoutReference: z.string().optional(),
  deductionsNotes: z.string().optional(),
});
type DepositEditForm = z.infer<typeof depositEditSchema>;

function DepositEditDialog({
  deposit,
  onClose,
  onSave,
  pending,
}: {
  deposit: SecurityDeposit | null;
  onClose: () => void;
  onSave: (data: Record<string, unknown>) => void;
  pending: boolean;
}) {
  const form = useForm<DepositEditForm>({
    resolver: zodResolver(depositEditSchema),
    values: {
      status: deposit?.status ?? "held",
      amountReturned: deposit?.amountReturned ?? "",
      returnedDate: deposit?.returnedDate ? new Date(deposit.returnedDate).toISOString().slice(0, 10) : "",
      closeoutReference: deposit?.closeoutReference ?? "",
      deductionsNotes: deposit?.deductionsNotes ?? "",
    },
  });

  return (
    <Dialog open={!!deposit} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Update deposit</DialogTitle>
          <DialogDescription>Record what is being returned and why, as the resident moves out.</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit((data) =>
              onSave({
                status: data.status,
                amountReturned: data.amountReturned === "" ? null : data.amountReturned,
                returnedDate: data.returnedDate === "" ? null : data.returnedDate,
                closeoutReference: data.closeoutReference === "" ? null : data.closeoutReference,
                deductionsNotes: data.deductionsNotes === "" ? null : data.deductionsNotes,
              }),
            )}
            className="space-y-4"
          >
            <FormField control={form.control} name="status" render={({ field }) => (
              <FormItem>
                <FormLabel>Status</FormLabel>
                <Select onValueChange={field.onChange} value={field.value}>
                  <FormControl><SelectTrigger data-testid="select-deposit-status"><SelectValue /></SelectTrigger></FormControl>
                  <SelectContent>
                    <SelectItem value="held">Held</SelectItem>
                    <SelectItem value="statement_sent">Statement sent</SelectItem>
                    <SelectItem value="returned">Returned</SelectItem>
                    <SelectItem value="partially_returned">Partially returned</SelectItem>
                    <SelectItem value="withheld">Withheld</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )} />
            <div className="grid grid-cols-2 gap-4">
              <FormField control={form.control} name="amountReturned" render={({ field }) => (
                <FormItem>
                  <FormLabel>Amount returned ($)</FormLabel>
                  <FormControl><Input type="number" min={0} step="0.01" {...field} data-testid="input-deposit-returned" /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="returnedDate" render={({ field }) => (
                <FormItem>
                  <FormLabel>Returned date</FormLabel>
                  <FormControl><Input type="date" {...field} data-testid="input-deposit-returndate" /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
            </div>
            <FormField control={form.control} name="closeoutReference" render={({ field }) => (
              <FormItem>
                <FormLabel>QuickBooks / Ramp reference <span className="text-muted-foreground text-xs">(optional)</span></FormLabel>
                <FormControl><Input {...field} placeholder="e.g. QB bill 4471" data-testid="input-deposit-reference" /></FormControl>
                <p className="text-xs text-muted-foreground">A reference the transaction can be found by. Never an account or card number.</p>
                <FormMessage />
              </FormItem>
            )} />
            <FormField control={form.control} name="deductionsNotes" render={({ field }) => (
              <FormItem>
                <FormLabel>Earlier notes <span className="text-muted-foreground text-xs">(legacy — deductions are itemised now)</span></FormLabel>
                <FormControl><Textarea {...field} rows={3} placeholder="e.g. $75 held back for wall repair in the kitchen." data-testid="input-deposit-notes" /></FormControl>
                <FormMessage />
              </FormItem>
            )} />
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
              <Button type="submit" disabled={pending} data-testid="button-submit-deposit-edit">{pending ? "Saving..." : "Save"}</Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
