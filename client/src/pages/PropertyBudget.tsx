import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "wouter";
import { ArrowLeft, CalendarRange, PiggyBank, Receipt, Wallet } from "lucide-react";

import PropertyOpenWork from "@/components/PropertyOpenWork";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Container, PageHeader, PageStack, Section } from "@/components/layout/page";
import { StatGrid, StatTile } from "@/components/stat-tile";
import { AccessDeniedState, EmptyState, LoadingState } from "@/components/states";
import { formatCurrency, formatDate, formatDateTime, localToday } from "@/lib/format";
import { houseBudgets, type SpendResponse } from "@/lib/budgetRollup";
import { isForbiddenError } from "@/lib/authUtils";
import { fiscalYearBounds, fiscalYearElapsed, fiscalYearLabel, fiscalYearOf, monthsLeftInFiscalYear } from "@shared/fiscalYear";
import { isClosedMaintenanceStatus, type MaintenanceRequest, type Property, type RepairBudget } from "@shared/schema";

/** How much finished work the page lists, newest first. */
const RECENT_WORK_SHOWN = 10;

const PACE_TEXT = {
  behind: { label: "Behind the year's pace", variant: "warning" },
  over: { label: "Over budget", variant: "orange" },
  on_pace: { label: "On pace", variant: "success" },
  early: { label: "Early in the year", variant: "info" },
} as const;

const SPEND_STATE_TEXT = {
  not_connected: "Spending not connected yet",
  not_linked: "Not linked to QuickBooks",
  waiting: "Waiting for the first QuickBooks sync",
} as const;

/**
 * One owned house's repair & maintenance year at a glance: the budget, what is
 * spent, how far through the year it is, and what the rest could go on -- the
 * open work and the wishlist -- beside what was finished this year.
 *
 * Staff only (the staff router alone carries the path), and every figure comes
 * from routes that apply the same region and permission rules as everywhere
 * else.
 */
export default function PropertyBudget() {
  const { id } = useParams<{ id: string }>();
  const propertiesQuery = useQuery<Property[]>({ queryKey: ["/api/properties"] });
  const budgetsQuery = useQuery<RepairBudget[]>({ queryKey: ["/api/repair-budgets"] });
  const spendQuery = useQuery<SpendResponse>({ queryKey: ["/api/property-spend"] });
  const requestsQuery = useQuery<MaintenanceRequest[]>({ queryKey: ["/api/maintenance-requests"] });

  const today = new Date(`${localToday()}T00:00:00.000Z`);
  const fiscalYear = fiscalYearOf(today);
  const property = propertiesQuery.data?.find((p) => p.id === id);

  const house = property ? houseBudgets([property], budgetsQuery.data ?? [], spendQuery.data, fiscalYear, today)[0] : undefined;

  const forHouse = property ? (requestsQuery.data ?? []).filter((r) => r.buildingAddress === property.address) : [];
  const yearStart = fiscalYearBounds(fiscalYear).start;
  const open = forHouse.filter((r) => !isClosedMaintenanceStatus(r.status));
  const finished = forHouse
    .filter((r) => r.status === "completed" && r.completedDate && new Date(r.completedDate) >= yearStart)
    .sort((a, b) => new Date(b.completedDate!).getTime() - new Date(a.completedDate!).getTime())
    .slice(0, RECENT_WORK_SHOWN);

  if (propertiesQuery.isLoading || budgetsQuery.isLoading) return <LoadingState />;
  if (budgetsQuery.isError && isForbiddenError(budgetsQuery.error as Error)) return <AccessDeniedState />;
  if (!property || property.ownership !== "owned" || !house) {
    return (
      <Section size="compact">
        <Container>
          <EmptyState
            title="No repair budget for this house"
            description="Repair & maintenance budgets are kept for houses SPO owns."
          />
        </Container>
      </Section>
    );
  }

  const { startDate, endDate } = fiscalYearBounds(fiscalYear);
  const elapsed = fiscalYearElapsed(fiscalYear, today);
  const monthsLeft = monthsLeftInFiscalYear(today);
  const share = house.spent !== null && house.budget ? house.spent / house.budget : null;
  const remaining = house.spent !== null && house.budget !== null ? house.budget - house.spent : null;
  const spentText =
    house.spent !== null ? formatCurrency(house.spent) : SPEND_STATE_TEXT[house.spendState as keyof typeof SPEND_STATE_TEXT];

  return (
    <Section size="compact">
      <Container>
        <PageStack>
          <Link
            href={`/properties/${property.id}`}
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            data-testid="link-back-to-property"
          >
            <ArrowLeft className="h-4 w-4" />
            {property.name}
          </Link>
          <PageHeader
            title={`${property.name}: repair & maintenance`}
            description={`${fiscalYearLabel(fiscalYear)} · ${formatDate(startDate)} – ${formatDate(endDate)}`}
          />

          <StatGrid className="lg:grid-cols-4">
            <StatTile
              label="Budget"
              value={house.budget === null ? "Not set" : formatCurrency(house.budget, { whole: true })}
              hint="Set by an admin"
              icon={Wallet}
            />
            <StatTile
              label="Spent to date"
              value={house.spent !== null ? formatCurrency(house.spent, { whole: true }) : "—"}
              hint={house.spent !== null ? `From QuickBooks${house.syncedAt ? `, ${formatDateTime(house.syncedAt)}` : ""}` : spentText}
              icon={Receipt}
            />
            <StatTile
              label="Budget used"
              value={share === null ? "—" : `${Math.round(share * 100)}%`}
              hint={remaining !== null ? `${formatCurrency(Math.max(remaining, 0), { whole: true })} left` : "Needs a budget and spend"}
              icon={PiggyBank}
            />
            <StatTile
              label="Year gone"
              value={`${Math.round(elapsed * 100)}%`}
              hint={`${monthsLeft + 1} month${monthsLeft === 0 ? "" : "s"} left, counting this one`}
              icon={CalendarRange}
            />
          </StatGrid>

          {house.pace ? (
            <div className="flex flex-wrap items-center gap-2" data-testid="text-budget-pace">
              <Badge variant={PACE_TEXT[house.pace.status].variant}>{PACE_TEXT[house.pace.status].label}</Badge>
              {house.pace.status === "behind" && (
                <span className="text-sm text-muted-foreground">
                  Steady improvements keep a house in good shape. The wishlist below has ideas for the rest of the budget.
                </span>
              )}
            </div>
          ) : house.spendState === "stale" ? (
            <p className="text-sm text-destructive">QuickBooks figures are out of date, so no pace is shown.</p>
          ) : null}

          <PropertyOpenWork requests={open} isLoading={requestsQuery.isLoading} />

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Finished this year</CardTitle>
            </CardHeader>
            <CardContent>
              {requestsQuery.isError ? (
                <p className="text-sm text-muted-foreground">Maintenance history is not available to your account.</p>
              ) : finished.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nothing finished yet in {fiscalYearLabel(fiscalYear)}.</p>
              ) : (
                <ul className="divide-y" data-testid="list-finished-work">
                  {finished.map((r) => (
                    <li key={r.id} className="flex items-center justify-between gap-3 py-2">
                      <Link href={`/maintenance/${r.id}`} className="hover:underline">
                        {r.title}
                      </Link>
                      <span className="text-sm text-muted-foreground">{formatDate(r.completedDate)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </PageStack>
      </Container>
    </Section>
  );
}
