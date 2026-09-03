import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { formatCurrency } from "@/lib/format";
import { fromCents, splitEvenly, toCents } from "@shared/depositLedger";
import type { Property, Resident } from "@shared/schema";

/**
 * Dividing a common-area charge across a house.
 *
 * A hole in a common room has to be split across the people living there. Two
 * things about this screen matter more than they look:
 *
 *   - **The split is shown before it is saved, and who is on it is editable.**
 *     An RA has to be able to see that one person is paying the extra cent,
 *     and to take somebody off who was away that term.
 *   - **The result is stored as individual per-person line items.** This
 *     screen computes the same shares the server does, from the same
 *     `splitEvenly` in `shared/`, so what an RA approves is exactly what gets
 *     written. A second copy of the arithmetic here is how the preview and the
 *     ledger would come to disagree.
 *
 * Where damage is attributable to one person, the single-deduction form is the
 * right tool instead.
 */

/** Today as "YYYY-MM-DD"; most charges are entered the day they are noticed. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function SplitChargeDialog({
  property,
  residents,
  open,
  onOpenChange,
}: {
  property: Property;
  residents: Resident[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { toast } = useToast();
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [chargeDate, setChargeDate] = useState(today);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());

  /**
   * Who the split defaults to: the people active on the charge date.
   *
   * Somebody who had already moved out is not on the hook for a hole made
   * after they left, and somebody who had not moved in yet is not either.
   */
  const candidates = useMemo(() => {
    const on = new Date(chargeDate).getTime();
    if (Number.isNaN(on)) return residents;
    return residents.filter((resident) => {
      const movedIn = resident.moveInDate ? new Date(resident.moveInDate).getTime() : null;
      const movedOut = resident.moveOutDate ? new Date(resident.moveOutDate).getTime() : null;
      if (movedIn !== null && !Number.isNaN(movedIn) && movedIn > on) return false;
      if (movedOut !== null && !Number.isNaN(movedOut) && movedOut < on) return false;
      return true;
    });
  }, [residents, chargeDate]);

  const chosen = candidates.filter((resident) => !excluded.has(resident.id));

  // The same arithmetic the server runs, from the same module, so the preview
  // an RA approves is exactly what gets written.
  const shares = useMemo(
    () => splitEvenly(toCents(amount), chosen.length),
    [amount, chosen.length],
  );

  const save = useMutation({
    mutationFn: async () =>
      await apiRequest("POST", "/api/deposit-deductions/split", {
        propertyId: property.id,
        description,
        amount: Number(amount),
        chargeDate,
        residentIds: chosen.map((resident) => resident.id),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/deposit-deductions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/action-items"] });
      onOpenChange(false);
      setDescription("");
      setAmount("");
      setExcluded(new Set());
      toast({
        title: "Charge split",
        description: `${formatCurrency(amount)} divided across ${chosen.length} people.`,
      });
    },
    onError: () => {
      toast({
        title: "That did not save",
        description: "Nothing was charged. Check the amount and who is on the split.",
        variant: "destructive",
      });
    },
  });

  const toggle = (residentId: string) => {
    // A new Set each time rather than mutating the old one.
    setExcluded((current) => {
      const next = new Set(current);
      if (next.has(residentId)) next.delete(residentId);
      else next.add(residentId);
      return next;
    });
  };

  const canSave =
    description.trim().length > 0 && toCents(amount) > 0 && chosen.length > 0 && !save.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Split a common-area charge</DialogTitle>
          <DialogDescription>
            {property.name} — divided across the people living there.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="split-description">What the charge is for</Label>
            <Input
              id="split-description"
              value={description}
              maxLength={300}
              placeholder="e.g. Hole in the common room wall"
              onChange={(event) => setDescription(event.target.value)}
              data-testid="input-split-description"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="split-amount">Total amount ($)</Label>
              <Input
                id="split-amount"
                type="number"
                min={0}
                step="0.01"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                data-testid="input-split-amount"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="split-date">When it happened</Label>
              <Input
                id="split-date"
                type="date"
                value={chargeDate}
                onChange={(event) => setChargeDate(event.target.value)}
                data-testid="input-split-date"
              />
              <p className="text-xs text-muted-foreground">
                Decides who was living here at the time.
              </p>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Who it is split across</Label>
            {candidates.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="text-split-nobody">
                Nobody on the roster was living here on that date. Change the date, or record this
                against one person instead.
              </p>
            ) : (
              <ul className="divide-y divide-border rounded-md border border-border">
                {candidates.map((resident) => {
                  const index = chosen.findIndex((person) => person.id === resident.id);
                  const share = index >= 0 ? shares[index] : null;
                  return (
                    <li
                      key={resident.id}
                      className="flex items-center gap-3 p-3"
                      data-testid={`row-split-${resident.id}`}
                    >
                      <Checkbox
                        checked={!excluded.has(resident.id)}
                        onCheckedChange={() => toggle(resident.id)}
                        aria-label={`Include ${resident.firstName} ${resident.lastName}`}
                        data-testid={`checkbox-split-${resident.id}`}
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {resident.firstName} {resident.lastName}
                      </span>
                      <span
                        className="font-medium tabular-nums"
                        data-testid={`text-split-share-${resident.id}`}
                      >
                        {share === null ? "—" : formatCurrency(fromCents(share))}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {chosen.length > 0 && toCents(amount) > 0 && (
            <p className="text-sm text-muted-foreground" data-testid="text-split-summary">
              {formatCurrency(amount)} across {chosen.length}{" "}
              {chosen.length === 1 ? "person" : "people"}. The remainder is spread a cent at a time
              from the top, so nobody pays more than a cent above anybody else. Each person is
              charged their own line — editing one later will not re-divide the rest.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!canSave}
            onClick={() => save.mutate()}
            data-testid="button-confirm-split"
          >
            {save.isPending ? "Charging…" : `Charge ${chosen.length}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
