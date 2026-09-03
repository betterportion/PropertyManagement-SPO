import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { formatCurrency } from "@/lib/format";
import type { Property, PropertyBudget } from "@shared/schema";

/**
 * The startup budget for one house, one year.
 *
 * An **operating** figure — what the house has to furnish and settle itself —
 * and deliberately not deposit or rent data. That distinction is what lets a
 * household leader see their own on the Resources page without the rule that
 * residents never see financial data being bent: this is the number they are
 * expected to spend, not a record of money held against them.
 */
export default function PropertyBudgetCard({
  property,
  canManage,
}: {
  property: Property;
  canManage: boolean;
}) {
  const { toast } = useToast();
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(String(thisYear));
  const [amount, setAmount] = useState("");
  const [notes, setNotes] = useState("");

  const { data: budgets = [] } = useQuery<PropertyBudget[]>({
    queryKey: ["/api/property-budgets"],
  });

  const forHouse = useMemo(
    () =>
      budgets
        .filter((budget) => budget.propertyId === property.id)
        .sort((a, b) => b.year - a.year),
    [budgets, property.id],
  );

  const save = useMutation({
    mutationFn: async () =>
      await apiRequest("PUT", `/api/properties/${property.id}/budget`, {
        year: Number(year),
        amount: Number(amount),
        notes: notes || null,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/property-budgets"] });
      setAmount("");
      setNotes("");
      toast({ title: "Saved", description: `Startup budget for ${year} recorded.` });
    },
    onError: () => {
      toast({ title: "That did not save", variant: "destructive" });
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Startup budget</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {forHouse.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="text-no-budget">
            No figure recorded yet. The household leaders see this on their Resources page once it
            is set.
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {forHouse.map((budget) => (
              <li key={budget.id} className="p-3" data-testid={`row-budget-${budget.year}`}>
                <p className="font-medium">
                  {budget.year}: {formatCurrency(budget.amount)}
                </p>
                {budget.notes && (
                  <p className="mt-1 text-sm text-muted-foreground">{budget.notes}</p>
                )}
              </li>
            ))}
          </ul>
        )}

        {canManage && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="budget-year">Year</Label>
                <Input
                  id="budget-year"
                  type="number"
                  min={2000}
                  max={2100}
                  value={year}
                  onChange={(event) => setYear(event.target.value)}
                  data-testid="input-budget-year"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="budget-amount">Amount ($)</Label>
                <Input
                  id="budget-amount"
                  type="number"
                  min={0}
                  step="0.01"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  data-testid="input-budget-amount"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="budget-notes">Notes (optional)</Label>
              <Textarea
                id="budget-notes"
                rows={2}
                value={notes}
                maxLength={1000}
                placeholder="What it is meant to cover, and anything the household should know."
                onChange={(event) => setNotes(event.target.value)}
                data-testid="textarea-budget-notes"
              />
            </div>
            <Button
              variant="primary"
              disabled={!year || !amount || save.isPending}
              onClick={() => save.mutate()}
              data-testid="button-save-budget"
            >
              {save.isPending ? "Saving…" : "Save"}
            </Button>
            {/* Setting the same year twice replaces it rather than adding a
                second row -- one figure per house per year. */}
            <p className="text-xs text-muted-foreground">
              Saving a year that already has a figure replaces it.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
