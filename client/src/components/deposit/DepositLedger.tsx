import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { FileText, Plus, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState, LoadingState } from "@/components/states";
import DepositStatement from "@/components/deposit/DepositStatement";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { formatCurrency, formatDate } from "@/lib/format";
import { fromCents, runningBalance, toCents } from "@shared/depositLedger";
import type {
  DepositDeduction,
  FlaggedWalkthroughItem,
  MaintenanceRequest,
  Resident,
  SecurityDeposit,
} from "@shared/schema";

/**
 * One resident's deposit: what is held, what has been taken off it, and what
 * is left.
 *
 * This replaces a free-text deductions note with an itemised ledger, which is
 * what any deposit statement has to be built from. **The old note is still
 * shown, as legacy history, and is never parsed into rows** — it is free text
 * written by people, and a migration that guessed would be wrong in ways
 * nobody notices until a deposit comes back short.
 *
 * Admins and the finance team only. Residents never see any of this.
 */

/** Today as "YYYY-MM-DD". */
const today = () => new Date().toISOString().slice(0, 10);

/**
 * How each status reads on the card.
 *
 * "Statement sent" is progress, not completion -- the money is still held, and
 * the dashboard keeps saying so until it goes back.
 */
const DEPOSIT_STATUS_BADGE: Record<
  SecurityDeposit["status"],
  { label: string; variant: "secondary" | "warning" | "outline" | "destructive" }
> = {
  held: { label: "Held", variant: "secondary" },
  statement_sent: { label: "Statement sent", variant: "warning" },
  returned: { label: "Returned", variant: "outline" },
  partially_returned: { label: "Partially returned", variant: "outline" },
  withheld: { label: "Withheld", variant: "destructive" },
};

/** The "not linked to anything" option; a Select cannot carry "". */
const NO_LINK = "__none__";

export default function DepositLedger({
  resident,
  deposit,
  canManage,
  onEdit,
  onRemove,
}: {
  resident: Resident;
  deposit: SecurityDeposit;
  canManage: boolean;
  /** Opens the status / amount-returned / close-out form for this deposit. */
  onEdit?: () => void;
  /** Removes the whole deposit record, not a deduction. */
  onRemove?: () => void;
}) {
  const { toast } = useToast();
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [isStatementOpen, setIsStatementOpen] = useState(false);
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [chargeDate, setChargeDate] = useState(today);
  const [requestId, setRequestId] = useState<string>(NO_LINK);
  const [walkthroughItemId, setWalkthroughItemId] = useState<string>(NO_LINK);

  const { data: allDeductions = [], isLoading } = useQuery<DepositDeduction[]>({
    queryKey: ["/api/deposit-deductions"],
  });

  // The house's own requests, so a deduction can point at the repair it paid
  // for. A real reference rather than a sentence retyped into the description.
  const { data: requests = [] } = useQuery<MaintenanceRequest[]>({
    queryKey: ["/api/maintenance-requests"],
  });

  // And the walkthrough items already recorded poor or damaged — which is
  // usually where a deduction comes from in the first place. Linking to the
  // item rather than retyping "hole in the wall" is what makes the charge
  // traceable back to the inspection that found it.
  const { data: flagged = [] } = useQuery<FlaggedWalkthroughItem[]>({
    queryKey: ["/api/walkthrough-flagged-items"],
    retry: false,
  });

  const deductions = useMemo(
    () => allDeductions.filter((deduction) => deduction.residentId === resident.id),
    [allDeductions, resident.id],
  );

  const houseRequests = useMemo(
    () => requests.filter((request) => request.buildingAddress === resident.buildingAddress),
    [requests, resident.buildingAddress],
  );

  const houseFlagged = useMemo(
    () => flagged.filter((item) => item.buildingAddress === resident.buildingAddress),
    [flagged, resident.buildingAddress],
  );

  const balanceCents = runningBalance(deposit.amountHeld, deductions);

  const add = useMutation({
    mutationFn: async () =>
      await apiRequest("POST", "/api/deposit-deductions", {
        residentId: resident.id,
        description,
        amount: Number(amount),
        chargeDate,
        maintenanceRequestId: requestId === NO_LINK ? null : requestId,
        walkthroughItemId: walkthroughItemId === NO_LINK ? null : walkthroughItemId,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/deposit-deductions"] });
      setIsAddOpen(false);
      setDescription("");
      setAmount("");
      setRequestId(NO_LINK);
      setWalkthroughItemId(NO_LINK);
    },
    onError: () => {
      toast({
        title: "That did not save",
        description: "Nothing was deducted. Check the amount and try again.",
        variant: "destructive",
      });
    },
  });

  const remove = useMutation({
    mutationFn: async (id: string) => await apiRequest("DELETE", `/api/deposit-deductions/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/deposit-deductions"] });
    },
    onError: () => {
      toast({ title: "That deduction was not removed", variant: "destructive" });
    },
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
        <CardTitle className="flex flex-wrap items-center gap-2">
          <span>
            Deposit — {resident.firstName} {resident.lastName}
          </span>
          <Badge variant={DEPOSIT_STATUS_BADGE[deposit.status].variant}>
            {DEPOSIT_STATUS_BADGE[deposit.status].label}
          </Badge>
        </CardTitle>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setIsStatementOpen(true)}
            data-testid={`button-statement-${resident.id}`}
          >
            <FileText className="h-4 w-4" />
            Statement
          </Button>
          {canManage && (
            <Button
              variant="primary"
              size="sm"
              onClick={() => setIsAddOpen(true)}
              data-testid={`button-add-deduction-${resident.id}`}
            >
              <Plus className="h-4 w-4" />
              Deduction
            </Button>
          )}
          {canManage && onEdit && (
            <Button size="sm" variant="secondary" onClick={onEdit} data-testid={`button-edit-deposit-${deposit.id}`}>
              Update
            </Button>
          )}
          {canManage && onRemove && (
            <Button
              size="icon"
              variant="ghost"
              aria-label={`Remove ${resident.firstName} ${resident.lastName}'s deposit record`}
              onClick={onRemove}
              data-testid={`button-menu-deposit-${deposit.id}`}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-baseline gap-x-8 gap-y-2">
          <div>
            <p className="text-xs text-muted-foreground">Held</p>
            <p className="text-lg font-semibold tabular-nums" data-testid={`text-deposit-held-${resident.id}`}>
              {formatCurrency(deposit.amountHeld)}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Deducted</p>
            <p className="text-lg font-semibold tabular-nums">
              {formatCurrency(
                fromCents(toCents(deposit.amountHeld) - balanceCents),
              )}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Balance</p>
            <p
              className={
                balanceCents < 0
                  ? "text-lg font-semibold tabular-nums text-destructive"
                  : "text-lg font-semibold tabular-nums"
              }
              data-testid={`text-deposit-balance-${resident.id}`}
            >
              {formatCurrency(fromCents(balanceCents))}
            </p>
          </div>
          {deposit.amountReturned && (
            <div>
              <p className="text-xs text-muted-foreground">Returned</p>
              <p className="text-lg font-semibold tabular-nums">
                {formatCurrency(deposit.amountReturned)}
                {deposit.returnedDate && (
                  <span className="ml-1 text-xs font-normal text-muted-foreground">
                    {formatDate(deposit.returnedDate)}
                  </span>
                )}
              </p>
            </div>
          )}
          {deposit.closeoutReference && (
            <Badge variant="outline" data-testid={`badge-closeout-${resident.id}`}>
              Ref {deposit.closeoutReference}
            </Badge>
          )}
          {deposit.statementProvidedOn && (
            <Badge variant="secondary" data-testid={`badge-statement-provided-${resident.id}`}>
              Statement provided {formatDate(deposit.statementProvidedOn)}
            </Badge>
          )}
        </div>

        {balanceCents < 0 && (
          <p className="text-sm text-destructive">
            The deductions come to more than the deposit held. The shortfall is shown rather than
            rounded away.
          </p>
        )}

        {isLoading ? (
          <LoadingState message="Loading deductions..." />
        ) : deductions.length === 0 ? (
          <EmptyState
            title="Nothing has been deducted"
            description="The whole deposit is still due back. Adding a deduction records what it was for, when, and who entered it."
          />
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {deductions.map((deduction) => (
              <li
                key={deduction.id}
                className="flex items-start gap-3 p-3 text-sm"
                data-testid={`row-deduction-${deduction.id}`}
              >
                <span className="w-24 shrink-0 text-muted-foreground">
                  {formatDate(deduction.chargeDate)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block">{deduction.description}</span>
                  <span className="block text-xs text-muted-foreground">
                    {/* The email is kept on the row so a deduction still says
                        who entered it after that account is gone. This is
                        money; the question gets asked. */}
                    {deduction.recordedByEmail ?? "Someone no longer with SPO"}
                    {deduction.splitGroupId ? " · part of a shared charge" : ""}
                  </span>
                </span>
                <span className="tabular-nums">{formatCurrency(deduction.amount)}</span>
                {canManage && (
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Remove this deduction"
                    onClick={() => remove.mutate(deduction.id)}
                    data-testid={`button-remove-deduction-${deduction.id}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}

        {deposit.deductionsNotes && (
          <div className="rounded-md border border-border bg-muted/40 p-3">
            <p className="text-xs font-medium text-muted-foreground">
              Earlier notes, before deductions were itemised
            </p>
            <p className="mt-1 whitespace-pre-line text-sm" data-testid={`text-legacy-notes-${resident.id}`}>
              {deposit.deductionsNotes}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Kept as written. Nothing here is counted in the balance above — reading amounts out
              of a sentence somebody typed would be a guess, and a guess here is a deposit that
              comes back short.
            </p>
          </div>
        )}
      </CardContent>

      <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Deduct from {resident.firstName} {resident.lastName}'s deposit
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="deduction-description">What it is for</Label>
              <Input
                id="deduction-description"
                value={description}
                maxLength={300}
                placeholder="e.g. Hole in bedroom wall"
                onChange={(event) => setDescription(event.target.value)}
                data-testid="input-deduction-description"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="deduction-amount">Amount ($)</Label>
                <Input
                  id="deduction-amount"
                  type="number"
                  min={0}
                  step="0.01"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  data-testid="input-deduction-amount"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="deduction-date">When it happened</Label>
                <Input
                  id="deduction-date"
                  type="date"
                  value={chargeDate}
                  onChange={(event) => setChargeDate(event.target.value)}
                  data-testid="input-deduction-date"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="deduction-request">The repair it paid for (optional)</Label>
              <Select value={requestId} onValueChange={setRequestId}>
                <SelectTrigger id="deduction-request" data-testid="select-deduction-request">
                  <SelectValue placeholder="Not linked" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_LINK}>Not linked</SelectItem>
                  {houseRequests.map((request) => (
                    <SelectItem key={request.id} value={request.id}>
                      {request.title} — {request.location}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                A real link rather than a retyped sentence, so the charge can be traced later.
              </p>
            </div>

            {houseFlagged.length > 0 && (
              <div className="space-y-2">
                <Label htmlFor="deduction-walkthrough">The walkthrough item it came from (optional)</Label>
                <Select value={walkthroughItemId} onValueChange={setWalkthroughItemId}>
                  <SelectTrigger id="deduction-walkthrough" data-testid="select-deduction-walkthrough">
                    <SelectValue placeholder="Not linked" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_LINK}>Not linked</SelectItem>
                    {houseFlagged.map((item) => (
                      <SelectItem key={item.itemId} value={item.itemId}>
                        {item.roomName} — {item.label} ({item.condition})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Only items an inspection already recorded as poor or damaged.
                </p>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="secondary" onClick={() => setIsAddOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={description.trim().length === 0 || toCents(amount) <= 0 || add.isPending}
              onClick={() => add.mutate()}
              data-testid="button-confirm-deduction"
            >
              {add.isPending ? "Saving…" : "Deduct"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DepositStatement
        resident={resident}
        deposit={deposit}
        deductions={deductions}
        open={isStatementOpen}
        onOpenChange={setIsStatementOpen}
      />
    </Card>
  );
}
