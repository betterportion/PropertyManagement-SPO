import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { ChevronDown, ChevronRight } from "lucide-react";

import ActionItemList from "@/components/ActionItemList";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/states";
import { formatCurrency, localToday } from "@/lib/format";
import type { ActionItem } from "@/lib/actionItems";
import { budgetSectionState, budgetsByRegion, houseBudgets, usedShare, type HouseBudget, type SpendResponse } from "@/lib/budgetRollup";
import { fiscalYearElapsed, fiscalYearLabel, fiscalYearOf } from "@shared/fiscalYear";
import type { Property, RepairBudget } from "@shared/schema";

/**
 * The dashboard's repair & maintenance budget: each region's owned houses,
 * budget against QuickBooks spend. Rolled up by region on the national view,
 * each region opening to its houses; one region's houses when the dashboard is
 * focused on it (a regional administrator's own, or an admin's drill-in).
 *
 * Nothing at all for somebody without the property permission -- the budget
 * routes refuse them. With no owned house to show it says so, rather than
 * leaving a gap where the section should be.
 */
export default function RepairBudgetSection({
  region,
  properties,
  actionItems,
}: {
  /** Show this region's houses; null for the region rollup. */
  region: string | null;
  /** Undefined until the houses have loaded. */
  properties: Property[] | undefined;
  actionItems: ActionItem[];
}) {
  const budgetsQuery = useQuery<RepairBudget[]>({ queryKey: ["/api/repair-budgets"] });
  const spendQuery = useQuery<SpendResponse>({ queryKey: ["/api/property-spend"] });
  const [open, setOpen] = useState<string | null>(null);

  // The reader's own day, as the budget card reads it.
  const today = new Date(`${localToday()}T00:00:00.000Z`);
  const fiscalYear = fiscalYearOf(today);
  const houses = houseBudgets(properties ?? [], budgetsQuery.data ?? [], spendQuery.data, fiscalYear, today);
  const scoped = region ? houses.filter((h) => h.property.region === region) : houses;
  const regions = budgetsByRegion(scoped);
  const alerts = actionItems.filter((i) => i.source === "budget" && (!region || i.region === region));

  const state = budgetSectionState({
    ownedHouses: scoped.length,
    propertiesLoaded: properties !== undefined,
    budgetsLoaded: budgetsQuery.isSuccess,
    budgetsRefused: budgetsQuery.isError,
  });
  if (state === "hidden") return null;

  if (state === "empty") {
    return (
      <div className="space-y-4" data-testid="section-repair-budget">
        <h2 className="text-xl font-semibold tracking-tight">Repair &amp; maintenance budget</h2>
        <Card>
          <CardContent className="p-0">
            <EmptyState
              title={region ? `No owned houses in ${region}` : "No owned houses yet"}
              description="Repair budgets are kept for houses SPO owns. Once an owned house is on file, its budget and spending show here."
            />
          </CardContent>
        </Card>
      </div>
    );
  }

  const elapsed = Math.round(fiscalYearElapsed(fiscalYear, today) * 100);

  return (
    <div className="space-y-4" data-testid="section-repair-budget">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-xl font-semibold tracking-tight">Repair &amp; maintenance budget</h2>
        <p className="text-sm text-muted-foreground">
          {fiscalYearLabel(fiscalYear)} · {elapsed}% of the year gone
        </p>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="hidden grid-cols-[minmax(0,2fr)_repeat(4,minmax(0,1fr))] gap-3 border-b px-4 py-2 text-xs text-muted-foreground sm:grid">
            <span>{region ? "House" : "Region"}</span>
            <span className="text-right">Budget</span>
            <span className="text-right">Spent</span>
            <span className="text-right">Used</span>
            <span className="text-right">{region ? "Pace" : "Behind pace"}</span>
          </div>

          {region ? (
            <ul className="divide-y">
              {scoped.map((house) => (
                <HouseRow key={house.property.id} house={house} />
              ))}
            </ul>
          ) : (
            <ul className="divide-y">
              {regions.map((r) => {
                const share = usedShare(r.spent, r.reportingBudget);
                const expanded = open === r.region;
                return (
                  <li key={r.region}>
                    <button
                      type="button"
                      className="grid w-full grid-cols-2 gap-3 px-4 py-3 text-left hover:bg-muted/50 sm:grid-cols-[minmax(0,2fr)_repeat(4,minmax(0,1fr))]"
                      onClick={() => setOpen(expanded ? null : r.region)}
                      aria-expanded={expanded}
                      data-testid={`row-budget-region-${r.region}`}
                    >
                      <span className="col-span-2 flex items-center gap-1 font-medium sm:col-span-1">
                        {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        {r.region}
                        <span className="ml-1 text-xs font-normal text-muted-foreground">
                          {r.houses.length} house{r.houses.length === 1 ? "" : "s"}
                        </span>
                      </span>
                      {/* No house budgeted reads as "Not set", never as a $0 budget. */}
                      <Figure
                        label="Budget"
                        value={r.budgeted === 0 ? "Not set" : formatCurrency(r.budget, { whole: true })}
                        note={r.budgeted > 0 && r.budgeted < r.houses.length ? `${r.budgeted} of ${r.houses.length} set` : undefined}
                      />
                      <Figure
                        label="Spent"
                        value={r.reporting > 0 ? formatCurrency(r.spent, { whole: true }) : "—"}
                        note={r.reporting < r.houses.length ? `${r.reporting} of ${r.houses.length} reporting` : undefined}
                      />
                      <Figure label="Used" value={share === null ? "—" : `${Math.round(share * 100)}%`} />
                      <span className="text-right">
                        <span className="block text-xs text-muted-foreground sm:hidden">Behind pace</span>
                        {r.behind > 0 ? (
                          <Badge variant="warning">{r.behind} behind</Badge>
                        ) : (
                          <span className="text-sm text-muted-foreground">{r.reporting > 0 ? "None" : "—"}</span>
                        )}
                      </span>
                    </button>
                    {expanded && (
                      <ul className="divide-y border-t bg-muted/30">
                        {r.houses.map((house) => (
                          <HouseRow key={house.property.id} house={house} indent />
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      {alerts.length > 0 && (
        <Card>
          <CardContent className="p-4">
            <ActionItemList items={alerts} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Figure({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <span className="text-right">
      <span className="block text-xs text-muted-foreground sm:hidden">{label}</span>
      <span className="text-sm">{value}</span>
      {note && <span className="block text-xs text-muted-foreground">{note}</span>}
    </span>
  );
}

const SPEND_STATE_TEXT: Record<Exclude<HouseBudget["spendState"], "current" | "stale">, string> = {
  not_connected: "Not connected",
  not_linked: "Not linked",
  waiting: "Not synced yet",
};

// The design system's status palette, never new colours.
const PACE_BADGE = {
  behind: { label: "Behind pace", variant: "warning" },
  over: { label: "Over budget", variant: "orange" },
  on_pace: { label: "On pace", variant: "success" },
  early: { label: "Early in the year", variant: "info" },
} as const;

function HouseRow({ house, indent = false }: { house: HouseBudget; indent?: boolean }) {
  const share = house.spent !== null && house.budget ? usedShare(house.spent, house.budget) : null;
  return (
    <li
      className={`grid grid-cols-2 gap-3 px-4 py-3 sm:grid-cols-[minmax(0,2fr)_repeat(4,minmax(0,1fr))] ${indent ? "sm:pl-9" : ""}`}
      data-testid={`row-budget-house-${house.property.id}`}
    >
      <Link href={`/properties/${house.property.id}/budget`} className="col-span-2 font-medium hover:underline sm:col-span-1">
        {house.property.name}
      </Link>
      <Figure label="Budget" value={house.budget === null ? "Not set" : formatCurrency(house.budget, { whole: true })} />
      <Figure
        label="Spent"
        value={house.spent !== null ? formatCurrency(house.spent, { whole: true }) : SPEND_STATE_TEXT[house.spendState as keyof typeof SPEND_STATE_TEXT]}
        note={house.spendState === "stale" ? "Out of date" : undefined}
      />
      <Figure label="Used" value={share === null ? "—" : `${Math.round(share * 100)}%`} />
      <span className="text-right">
        <span className="block text-xs text-muted-foreground sm:hidden">Pace</span>
        {house.pace ? (
          <Badge variant={PACE_BADGE[house.pace.status].variant}>{PACE_BADGE[house.pace.status].label}</Badge>
        ) : (
          <span className="text-sm text-muted-foreground">—</span>
        )}
      </span>
    </li>
  );
}
