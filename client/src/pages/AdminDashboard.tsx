import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Building2, Wrench, Hammer, DollarSign, CalendarClock, ShieldCheck, ArrowLeft, Plus } from "lucide-react";

import { useAuth } from "@/hooks/useAuth";
import ActionItemList from "@/components/ActionItemList";
import RegionCard, { type RegionSummary } from "@/components/RegionCard";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Container, PageHeader, PageStack, Section } from "@/components/layout/page";
import { StatGrid, StatTile } from "@/components/stat-tile";
import { EmptyState } from "@/components/states";
import { formatCurrency } from "@/lib/format";
import type { ActionItem } from "@/lib/actionItems";
import type { Property } from "@shared/schema";

/** How many houses with open work the dashboard lists before pointing at the Maintenance page. */
const OPEN_WORK_HOUSES_SHOWN = 5;

export default function AdminDashboard() {
  const { user } = useAuth();
  const isAdmin = (user as { role?: string } | null)?.role === "admin";

  const [selectedRegion, setSelectedRegion] = useState<string | null>(null);

  const summariesQuery = useQuery<RegionSummary[]>({ queryKey: ["/api/region-summary"] });
  const propertiesQuery = useQuery<Property[]>({ queryKey: ["/api/properties"] });
  const actionItemsQuery = useQuery<ActionItem[]>({ queryKey: ["/api/action-items"] });

  const summaries = summariesQuery.data ?? [];
  const actionItems = actionItemsQuery.data ?? [];

  // Leadership KPIs, summed across every region the viewer can see. Repairs
  // and jobs (projects and capital projects) are two numbers, because they
  // are two different conversations: one about a handyman, one about a bid.
  const openRepairsTotal = summaries.reduce((sum, r) => sum + r.openRepairs, 0);
  const openJobsTotal = summaries.reduce((sum, r) => sum + r.openJobs, 0);
  const renewalsTotal = summaries.reduce((sum, r) => sum + r.leaseRenewalsDue, 0);
  const unpaidTotal = summaries.reduce((sum, r) => sum + Number(r.unpaidRent.amount), 0);

  // A single-region viewer (a regional admin over one region) lands straight in
  // that region; anyone with several regions sees the overview and drills in.
  const singleRegion = summaries.length === 1 ? summaries[0].region : null;
  const focusedRegion = selectedRegion ?? singleRegion;
  const showOverview = !focusedRegion && summaries.length > 1;
  const canGoBack = !!selectedRegion && summaries.length > 1;

  // Open work, one line per house, from the same action-item rule the Tasks
  // page reads. The items needing attention rather than the full list: the
  // list itself is one click away on the Maintenance page, filtered to the
  // house the line names.
  const openWorkItems = actionItems.filter((i) => i.source === "maintenance");
  const scopedOpenWork = (focusedRegion ? openWorkItems.filter((i) => i.region === focusedRegion) : openWorkItems).slice(
    0,
    OPEN_WORK_HOUSES_SHOWN,
  );

  // Per-house maintenance schedules plus the region-level safety reminders
  // (walkthroughs, utilities) — everything that belongs to safety & preventive.
  const safetyItems = actionItems.filter((i) => i.source === "schedule" || i.category === "safety");
  const scopedSafety = (focusedRegion ? safetyItems.filter((i) => i.region === focusedRegion) : safetyItems).slice(0, 5);

  const attentionHeading = focusedRegion ? `${focusedRegion} — needs attention` : "Needs attention";

  return (
    <Section size="compact">
      <Container>
        <PageStack>
          <PageHeader
            title="Dashboard"
            description={isAdmin ? "How each region is doing across your properties." : "What needs your attention."}
            actions={
              // Taking on a house starts here. An RA should be able to get a
              // property recorded in under two minutes and fill in the rest
              // later, and hunting for the page first is part of what makes
              // that not happen.
              <Button variant="primary" asChild data-testid="button-add-property">
                <Link href="/properties?add=1">
                  <Plus className="h-4 w-4" />
                  Add a property
                </Link>
              </Button>
            }
          />

          <StatGrid className="lg:grid-cols-5">
            <StatTile
              label="Properties"
              href="/properties"
              value={propertiesQuery.data?.length ?? 0}
              hint="Homes on file"
              icon={Building2}
              isLoading={propertiesQuery.isLoading}
            />
            <StatTile
              label="Open repairs"
              href="/maintenance?type=request"
              value={openRepairsTotal}
              hint="Reported, not yet finished"
              icon={Wrench}
              isLoading={summariesQuery.isLoading}
            />
            <StatTile
              label="Open jobs"
              href="/maintenance?view=open"
              value={openJobsTotal}
              hint="Projects and capital projects"
              icon={Hammer}
              isLoading={summariesQuery.isLoading}
            />
            <StatTile
              label="Renewals due"
              href="/properties"
              value={renewalsTotal}
              hint="Leases within 2 months"
              icon={CalendarClock}
              isLoading={summariesQuery.isLoading}
            />
            <StatTile
              label="Unpaid rent"
              href="/finances"
              value={formatCurrency(unpaidTotal)}
              hint="Outstanding — chase / notify"
              icon={DollarSign}
              isLoading={summariesQuery.isLoading}
            />
          </StatGrid>

          {showOverview && (
            <div className="space-y-4">
              <h2 className="text-xl font-semibold tracking-tight">Regions</h2>
              {summaries.length === 0 && !summariesQuery.isLoading ? (
                <Card>
                  <CardContent className="p-0">
                    <EmptyState title="No regions to show" description="Once properties and admins are set up, each region's health appears here." />
                  </CardContent>
                </Card>
              ) : (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {summaries.map((summary) => (
                    <RegionCard key={summary.region} summary={summary} onSelect={() => setSelectedRegion(summary.region)} />
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-xl font-semibold tracking-tight">{attentionHeading}</h2>
              {canGoBack && (
                <Button variant="secondary" size="sm" onClick={() => setSelectedRegion(null)} data-testid="button-all-regions">
                  <ArrowLeft className="mr-1 h-4 w-4" /> All regions
                </Button>
              )}
            </div>

            <div className="grid gap-6 lg:grid-cols-2">
              <div className="space-y-4">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="flex items-center gap-2 font-medium">
                    <Wrench className="h-4 w-4 text-muted-foreground" /> Open work by house
                  </h3>
                  <Button variant="secondary" size="sm" asChild data-testid="button-view-all-requests">
                    <Link href="/maintenance?view=open">View all</Link>
                  </Button>
                </div>
                <Card>
                  <CardContent className="p-4">
                    {scopedOpenWork.length === 0 ? (
                      <EmptyState icon={Wrench} title="No open work" description="Repairs, projects and capital projects still open show up here, one line per house." className="py-6" />
                    ) : (
                      <ActionItemList items={scopedOpenWork} />
                    )}
                  </CardContent>
                </Card>
              </div>

              <div className="space-y-4">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="flex items-center gap-2 font-medium">
                    <ShieldCheck className="h-4 w-4 text-muted-foreground" /> Safety &amp; preventive
                  </h3>
                  <Button variant="secondary" size="sm" asChild data-testid="button-view-tasks">
                    <Link href="/tasks">See all</Link>
                  </Button>
                </div>
                <Card>
                  <CardContent className="p-4">
                    {scopedSafety.length === 0 ? (
                      <EmptyState icon={ShieldCheck} title="Nothing due" description="Safety checks and preventive maintenance coming due show up here." className="py-6" />
                    ) : (
                      <ActionItemList items={scopedSafety} />
                    )}
                  </CardContent>
                </Card>
              </div>
            </div>
          </div>
        </PageStack>
      </Container>
    </Section>
  );
}
