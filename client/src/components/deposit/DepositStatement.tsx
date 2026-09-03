import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Copy, Printer } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { formatCurrency, formatDate } from "@/lib/format";
import { fromCents, runningBalance } from "@shared/depositLedger";
import type { DepositDeduction, Resident, SecurityDeposit } from "@shared/schema";

/**
 * The deposit worksheet an RA hands to finance.
 *
 * **Internal.** This is not a document the portal issues to a resident, and
 * there is deliberately no send button: delivery happens outside the portal by
 * product decision, not because email is unavailable. Residents never see
 * deposits, deductions, balances or statements anywhere in the app.
 *
 * Because delivery happens elsewhere, the date worth recording is the one the
 * RA sets by hand — there is no send action to infer it from.
 */

/** Today as "YYYY-MM-DD". */
const today = () => new Date().toISOString().slice(0, 10);

/** The worksheet as plain text, for pasting into an email or a message. */
function asPlainText(
  resident: Resident,
  deposit: SecurityDeposit,
  deductions: readonly DepositDeduction[],
  balanceCents: number,
): string {
  const lines = [
    `Deposit statement — ${resident.firstName} ${resident.lastName}`,
    resident.buildingAddress,
    "",
    `Deposit held: ${formatCurrency(deposit.amountHeld)}`,
    "",
    "Deductions:",
    ...(deductions.length === 0
      ? ["  (none)"]
      : deductions.map(
          (deduction) =>
            `  ${formatDate(deduction.chargeDate)}  ${formatCurrency(deduction.amount)}  ${deduction.description}`,
        )),
    "",
    `Balance to return: ${formatCurrency(fromCents(balanceCents))}`,
  ];
  return lines.join("\n");
}

export default function DepositStatement({
  resident,
  deposit,
  deductions,
  open,
  onOpenChange,
}: {
  resident: Resident;
  deposit: SecurityDeposit;
  deductions: DepositDeduction[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { toast } = useToast();
  const [providedOn, setProvidedOn] = useState(
    deposit.statementProvidedOn
      ? new Date(deposit.statementProvidedOn).toISOString().slice(0, 10)
      : today(),
  );

  const balanceCents = runningBalance(deposit.amountHeld, deductions);
  const text = asPlainText(resident, deposit, deductions, balanceCents);

  const recordProvided = useMutation({
    mutationFn: async () =>
      await apiRequest("PATCH", `/api/security-deposits/${deposit.id}`, {
        statementProvidedOn: providedOn,
        // "Statement sent" is progress, not completion -- the money is still
        // held, and the dashboard keeps saying so until it goes back.
        status: deposit.status === "held" ? "statement_sent" : deposit.status,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/security-deposits"] });
      queryClient.invalidateQueries({ queryKey: ["/api/action-items"] });
      toast({ title: "Recorded", description: "The date the statement was handed over is saved." });
    },
    onError: () => {
      toast({ title: "That did not save", variant: "destructive" });
    },
  });

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: "Copied", description: "The worksheet is on your clipboard." });
    } catch {
      // Clipboard access can be refused outright (an insecure origin, a
      // browser setting). Say so rather than appearing to have worked.
      toast({
        title: "Could not copy",
        description: "Select the text below and copy it by hand.",
        variant: "destructive",
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto print:max-h-none print:overflow-visible">
        <DialogHeader>
          <DialogTitle>
            Deposit statement — {resident.firstName} {resident.lastName}
          </DialogTitle>
          <DialogDescription>
            An internal worksheet for finance. The portal does not send this to the resident.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4" data-testid="deposit-statement">
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <dt className="text-muted-foreground">House</dt>
            <dd>{resident.buildingAddress}</dd>
            <dt className="text-muted-foreground">Deposit held</dt>
            <dd className="tabular-nums" data-testid="text-statement-held">
              {formatCurrency(deposit.amountHeld)}
            </dd>
          </dl>

          <div>
            <h3 className="mb-2 text-sm font-semibold">Deductions</h3>
            {deductions.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing has been deducted.</p>
            ) : (
              <ul className="divide-y divide-border rounded-md border border-border text-sm">
                {deductions.map((deduction) => (
                  <li key={deduction.id} className="flex items-baseline gap-3 p-2">
                    <span className="w-24 shrink-0 text-muted-foreground">
                      {formatDate(deduction.chargeDate)}
                    </span>
                    <span className="min-w-0 flex-1">{deduction.description}</span>
                    <span className="tabular-nums">{formatCurrency(deduction.amount)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="flex items-baseline justify-between border-t border-border pt-3">
            <span className="font-semibold">Balance to return</span>
            <span
              className={
                balanceCents < 0
                  ? "text-lg font-semibold tabular-nums text-destructive"
                  : "text-lg font-semibold tabular-nums"
              }
              data-testid="text-statement-balance"
            >
              {formatCurrency(fromCents(balanceCents))}
            </span>
          </div>

          {balanceCents < 0 && (
            <p className="text-sm text-destructive" data-testid="text-statement-shortfall">
              The deductions come to more than the deposit held. That shortfall is shown rather
              than rounded away — somebody has to decide what to do about it.
            </p>
          )}

          <div className="space-y-2 print:hidden">
            <Label htmlFor="statement-provided">Statement provided on</Label>
            <div className="flex gap-2">
              <Input
                id="statement-provided"
                type="date"
                value={providedOn}
                onChange={(event) => setProvidedOn(event.target.value)}
                data-testid="input-statement-provided"
              />
              <Button
                variant="secondary"
                disabled={!providedOn || recordProvided.isPending}
                onClick={() => recordProvided.mutate()}
                data-testid="button-record-statement-date"
              >
                Record
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Delivery happens outside the portal, so this is the date worth keeping.
            </p>
          </div>
        </div>

        <DialogFooter className="print:hidden">
          <Button variant="secondary" onClick={copy} data-testid="button-copy-statement">
            <Copy className="h-4 w-4" />
            Copy
          </Button>
          <Button variant="secondary" onClick={() => window.print()} data-testid="button-print-statement">
            <Printer className="h-4 w-4" />
            Print
          </Button>
          <Button variant="primary" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
