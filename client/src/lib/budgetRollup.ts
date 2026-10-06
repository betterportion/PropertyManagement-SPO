/**
 * Owned houses' repair budgets against their QuickBooks spend, per house and
 * rolled up per region, for the dashboard and the house budget page.
 *
 * Pure, and built on the same pace rule as the server's alert
 * (shared/budgetPace.ts), so the dashboard's "behind pace" count and the
 * Needs attention items cannot disagree. A house whose spend is not known --
 * QuickBooks off, the house not linked, no sync yet, or out of date -- has no
 * pace and never counts as behind; its budget still counts in the totals.
 */
import { budgetPace, type BudgetPace } from "@shared/budgetPace";
import { isQuickBooksStale } from "@shared/quickbooks";
import type { Property, PropertySpend, RepairBudget } from "@shared/schema";

export interface SpendResponse {
  connected: boolean;
  lastSuccessAt: string | null;
  stale: boolean;
  linkedPropertyIds: string[];
  spend: PropertySpend[];
}

/** Why a house has, or has not, a spend figure. */
export type SpendState = "current" | "stale" | "not_connected" | "not_linked" | "waiting";

export interface HouseBudget {
  property: Property;
  budget: number | null;
  spent: number | null;
  spendState: SpendState;
  syncedAt: string | null;
  /** Only when there is a budget above zero and a current figure. */
  pace: BudgetPace | null;
}

export interface RegionBudget {
  region: string;
  houses: HouseBudget[];
  /** Every owned house's budget in the region. */
  budget: number;
  /** How many of its houses have a budget set at all. */
  budgeted: number;
  /** Spend across the houses with a current figure. */
  spent: number;
  /** The budgets of those same houses, so "% used" compares like with like. */
  reportingBudget: number;
  reporting: number;
  behind: number;
  over: number;
}

export function houseBudgets(
  properties: Property[],
  budgets: RepairBudget[],
  spendData: SpendResponse | undefined,
  fiscalYear: number,
  now: Date,
): HouseBudget[] {
  return properties
    .filter((p) => p.ownership === "owned")
    .map((property) => {
      const budgetRow = budgets.find((b) => b.propertyId === property.id && b.fiscalYear === fiscalYear);
      const budget = budgetRow ? Number(budgetRow.amount) : null;
      const row = spendData?.spend.find((s) => s.propertyId === property.id && s.fiscalYear === fiscalYear);

      let spendState: SpendState;
      if (!spendData?.connected) spendState = "not_connected";
      else if (!spendData.linkedPropertyIds.includes(property.id)) spendState = "not_linked";
      else if (!row) spendState = "waiting";
      else if (spendData.stale || isQuickBooksStale(row.syncedAt, now)) spendState = "stale";
      else spendState = "current";

      const spent = row && (spendState === "current" || spendState === "stale") ? Number(row.amount) : null;
      const pace =
        spendState === "current" && budget !== null && budget > 0 && spent !== null
          ? budgetPace(budget, spent, fiscalYear, now)
          : null;
      return { property, budget, spent, spendState, syncedAt: row ? String(row.syncedAt) : null, pace };
    })
    .sort((a, b) => a.property.name.localeCompare(b.property.name));
}

export function budgetsByRegion(houses: HouseBudget[]): RegionBudget[] {
  const regions = new Map<string, RegionBudget>();
  for (const house of houses) {
    const region = house.property.region;
    const entry =
      regions.get(region) ??
      { region, houses: [], budget: 0, budgeted: 0, spent: 0, reportingBudget: 0, reporting: 0, behind: 0, over: 0 };
    entry.houses.push(house);
    entry.budget += house.budget ?? 0;
    if (house.budget !== null) entry.budgeted += 1;
    if (house.pace) {
      entry.spent += house.spent ?? 0;
      entry.reportingBudget += house.budget ?? 0;
      entry.reporting += 1;
      if (house.pace.status === "behind") entry.behind += 1;
      if (house.pace.status === "over") entry.over += 1;
    }
    regions.set(region, entry);
  }
  return Array.from(regions.values()).sort((a, b) => a.region.localeCompare(b.region));
}

/** "31%", or null when nothing is reporting. */
export function usedShare(spent: number, budget: number): number | null {
  return budget > 0 ? spent / budget : null;
}

/**
 * What the dashboard's budget section shows. "empty" names the reason -- no
 * owned house on file -- because a section that simply is not there reads as a
 * feature that never arrived. Still hidden for somebody the budget routes
 * refuse, and until both lists have loaded, so the empty wording never flashes
 * up ahead of the houses.
 */
export type BudgetSectionState = "hidden" | "empty" | "list";

export function budgetSectionState({
  ownedHouses,
  propertiesLoaded,
  budgetsLoaded,
  budgetsRefused,
}: {
  /** Owned houses in view: one region's when the dashboard is focused on it. */
  ownedHouses: number;
  propertiesLoaded: boolean;
  budgetsLoaded: boolean;
  budgetsRefused: boolean;
}): BudgetSectionState {
  if (budgetsRefused) return "hidden";
  if (ownedHouses > 0) return "list";
  return propertiesLoaded && budgetsLoaded ? "empty" : "hidden";
}
