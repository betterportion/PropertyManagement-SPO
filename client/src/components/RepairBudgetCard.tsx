import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { formatCurrency, formatDate, formatDateTime, localToday } from "@/lib/format";
import { serverMessage } from "@/lib/serverMessage";
import { fiscalYearBounds, fiscalYearLabel, fiscalYearOf } from "@shared/fiscalYear";
import type { Property, PropertySpend, RepairBudget } from "@shared/schema";

/** What /api/property-spend answers: the figures, and whether to trust them. */
export interface SpendResponse {
  connected: boolean;
  lastSuccessAt: string | null;
  stale: boolean;
  linkedPropertyIds: string[];
  spend: PropertySpend[];
}

/**
 * One owned house's repair & maintenance budget for the fiscal year.
 *
 * Staff only, and set by admins only. The spend beside it comes from
 * QuickBooks; until that is connected the card says so in words rather than
 * showing $0, because $0 spent would read as a house nobody is looking after.
 */
export default function RepairBudgetCard({ property, canManage }: { property: Property; canManage: boolean }) {
  const { toast } = useToast();
  // The reader's own calendar day, not the UTC one: after 7pm Central on
  // May 31 the UTC day is already the next fiscal year.
  const currentYear = fiscalYearOf(new Date(`${localToday()}T00:00:00.000Z`));
  const [fiscalYear, setFiscalYear] = useState(String(currentYear));
  const [amount, setAmount] = useState("");

  const { data: budgets = [] } = useQuery<RepairBudget[]>({ queryKey: ["/api/repair-budgets"] });
  const { data: spendData } = useQuery<SpendResponse>({ queryKey: ["/api/property-spend"] });

  const byYear = useMemo(
    () => new Map(budgets.filter((b) => b.propertyId === property.id).map((b) => [b.fiscalYear, b])),
    [budgets, property.id],
  );
  const current = byYear.get(currentYear);
  const next = byYear.get(currentYear + 1);
  const { startDate, endDate } = fiscalYearBounds(currentYear);

  const save = useMutation({
    mutationFn: async () =>
      await apiRequest("PUT", `/api/properties/${property.id}/repair-budget`, {
        fiscalYear: Number(fiscalYear),
        amount: Number(amount),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/repair-budgets"] });
      setAmount("");
      toast({ title: "Saved", description: `${fiscalYearLabel(Number(fiscalYear))} budget recorded.` });
    },
    onError: (error) => {
      toast({ title: "That did not save", description: serverMessage(error), variant: "destructive" });
    },
  });

  return (
    <Card data-testid="card-repair-budget">
      <CardHeader>
        <CardTitle>Repair &amp; maintenance budget</CardTitle>
        <p className="text-sm text-muted-foreground">
          {fiscalYearLabel(currentYear)} · {formatDate(startDate)} – {formatDate(endDate)}
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid gap-4 sm:grid-cols-2">
          <div>
            <dt className="text-xs text-muted-foreground">Budget</dt>
            <dd className="mt-0.5 text-lg font-semibold" data-testid="text-repair-budget">
              {current ? formatCurrency(current.amount) : <span className="text-base font-normal text-muted-foreground">Not set yet</span>}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Spent so far</dt>
            <SpendFigure propertyId={property.id} fiscalYear={currentYear} budget={current?.amount ?? null} data={spendData} />
          </div>
        </dl>

        {next && (
          <p className="text-sm text-muted-foreground" data-testid="text-repair-budget-next">
            {fiscalYearLabel(currentYear + 1)} budget: {formatCurrency(next.amount)}
          </p>
        )}

        {canManage ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="repair-budget-year">Fiscal year</Label>
                <Select value={fiscalYear} onValueChange={setFiscalYear}>
                  <SelectTrigger id="repair-budget-year" data-testid="select-repair-budget-year">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[currentYear, currentYear + 1].map((year) => (
                      <SelectItem key={year} value={String(year)}>
                        {fiscalYearLabel(year)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="repair-budget-amount">Amount ($)</Label>
                <Input
                  id="repair-budget-amount"
                  type="number"
                  min={0}
                  step="0.01"
                  value={amount}
                  placeholder={byYear.get(Number(fiscalYear))?.amount ?? ""}
                  onChange={(event) => setAmount(event.target.value)}
                  data-testid="input-repair-budget-amount"
                />
              </div>
            </div>
            <Button
              variant="primary"
              disabled={!amount || save.isPending}
              onClick={() => save.mutate()}
              data-testid="button-save-repair-budget"
            >
              {save.isPending ? "Saving…" : "Save"}
            </Button>
            <p className="text-xs text-muted-foreground">Saving a year that already has a figure replaces it.</p>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">Only an admin can set this figure.</p>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The spend, or why there isn't one. Every state that is not a real figure is
 * said in words: $0 would read as a house nobody spent anything on.
 */
function SpendFigure({
  propertyId,
  fiscalYear,
  budget,
  data,
}: {
  propertyId: string;
  fiscalYear: number;
  budget: string | null;
  data: SpendResponse | undefined;
}) {
  const muted = (text: string) => (
    <dd className="mt-0.5 text-sm text-muted-foreground" data-testid="text-repair-spend">
      {text}
    </dd>
  );
  if (!data || !data.connected) return muted("Spending not connected yet");
  if (!data.linkedPropertyIds.includes(propertyId)) return muted("Not linked to QuickBooks");
  const row = data.spend.find((s) => s.propertyId === propertyId && s.fiscalYear === fiscalYear);
  if (!row) return muted("Waiting for the first QuickBooks sync");

  const share = budget && Number(budget) > 0 ? Math.round((Number(row.amount) / Number(budget)) * 100) : null;
  return (
    <>
      <dd className="mt-0.5 text-lg font-semibold" data-testid="text-repair-spend">
        {formatCurrency(row.amount)}
        {share !== null && <span className="ml-2 text-sm font-normal text-muted-foreground">{share}% of budget</span>}
      </dd>
      <dd className={data.stale ? "text-xs text-destructive" : "text-xs text-muted-foreground"} data-testid="text-repair-spend-synced">
        {data.stale ? "Out of date — QuickBooks last updated " : "From QuickBooks, "}
        {formatDateTime(row.syncedAt)}
      </dd>
    </>
  );
}
