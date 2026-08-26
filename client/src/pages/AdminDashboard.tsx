import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Building2, Wrench, DollarSign, CalendarClock, ShieldCheck, ArrowLeft } from "lucide-react";

import { useAuth } from "@/hooks/useAuth";
import MaintenanceRequestCard from "@/components/MaintenanceRequestCard";
import MaintenanceEditDialog from "@/components/MaintenanceEditDialog";
import ActionItemList from "@/components/ActionItemList";
import RegionCard, { type RegionSummary } from "@/components/RegionCard";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Container, PageHeader, PageStack, Section } from "@/components/layout/page";
import { StatGrid, StatTile } from "@/components/stat-tile";
import { EmptyState } from "@/components/states";
import { formatCurrency } from "@/lib/format";
import type { ActionItem } from "@/lib/actionItems";
import type { MaintenanceRequest, Property } from "@shared/schema";

function time(value: Date | string | null | undefined) {
  if (!value) return 0;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

export default function AdminDashboard() {
  const { user } = useAuth();
  const isAdmin = (user as { role?: string } | null)?.role === "admin";

  const [selectedRegion, setSelectedRegion] = useState<string | null>(null);
  const [selectedRequest, setSelectedRequest] = useState<MaintenanceRequest | null>(null);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);

  const summariesQuery = useQuery<RegionSummary[]>({ queryKey: ["/api/region-summary"] });
  const requestsQuery = useQuery<MaintenanceRequest[]>({ queryKey: ["/api/maintenance-requests"] });
  const propertiesQuery = useQuery<Property[]>({ queryKey: ["/api/properties"] });
  const actionItemsQuery = useQuery<ActionItem[]>({ queryKey: ["/api/action-items"] });

  const summaries = summariesQuery.data ?? [];
  const requests = requestsQuery.data ?? [];
  const actionItems = actionItemsQuery.data ?? [];

  // Leadership KPIs, summed across every region the viewer can see.
  const openRequestsTotal = summaries.reduce((sum, r) => sum + r.openRequests, 0);
  const renewalsTotal = summaries.reduce((sum, r) => sum + r.leaseRenewalsDue, 0);
  const unpaidTotal = summaries.reduce((sum, r) => sum + Number(r.unpaidRent.amount), 0);

  // A single-region viewer (a regional admin over one region) lands straight in
  // that region; anyone with several regions sees the overview and drills in.
  const singleRegion = summaries.length === 1 ? summaries[0].region : null;
  const focusedRegion = selectedRegion ?? singleRegion;
  const showOverview = !focusedRegion && summaries.length > 1;
  const canGoBack = !!selectedRegion && summaries.length > 1;

  const openRequests = requests
    .filter((r) => r.status === "pending" || r.status === "in_progress")
    .sort((a, b) => time(b.submittedDate) - time(a.submittedDate));
  const scopedRequests = (focusedRegion ? openRequests.filter((r) => r.region === focusedRegion) : openRequests).slice(0, 5);

  // Per-house maintenance schedules plus the region-level safety reminders
  // (walkthroughs, utilities) — everything that belongs to safety & preventive.
  const safetyItems = actionItems.filter((i) => i.source === "schedule" || i.category === "safety");
  const scopedSafety = (focusedRegion ? safetyItems.filter((i) => i.region === focusedRegion) : safetyItems).slice(0, 5);

  const handleEditRequest = (request: MaintenanceRequest) => {
    setSelectedRequest(request);
    setIsEditDialogOpen(true);
  };
  const handleCloseDialog = () => {
    setIsEditDialogOpen(false);
    setSelectedRequest(null);
  };

  const attentionHeading = focusedRegion ? `${focusedRegion} — needs attention` : "Needs attention";

  return (
    <Section size="compact">
      <Container>
        <PageStack>
          <PageHeader
            title="Dashboard"
            description={isAdmin ? "How each region is doing across your properties." : "What needs your attention."}
          />

          <StatGrid>
            <StatTile
              label="Properties"
              href="/properties"
              value={propertiesQuery.data?.length ?? 0}
              hint="Homes on file"
              icon={Building2}
              isLoading={propertiesQuery.isLoading}
            />
            <StatTile
              label="Open requests"
              href="/maintenance"
              value={openRequestsTotal}
              hint="Reported, not yet finished"
              icon={Wrench}
              isLoading={requestsQuery.isLoading}
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
                    <Wrench className="h-4 w-4 text-muted-foreground" /> Maintenance requests
                  </h3>
                  <Button variant="secondary" size="sm" asChild data-testid="button-view-all-requests">
                    <Link href="/maintenance">View all</Link>
                  </Button>
                </div>
                {scopedRequests.length === 0 ? (
                  <Card>
                    <CardContent className="p-0">
                      <EmptyState icon={Wrench} title="No open requests" description="Reported problems that aren't finished yet show up here." className="py-6" />
                    </CardContent>
                  </Card>
                ) : (
                  <div className="space-y-4">
                    {scopedRequests.map((request) => (
                      <MaintenanceRequestCard key={request.id} request={request} isAdmin onEdit={() => handleEditRequest(request)} />
                    ))}
                  </div>
                )}
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

        {selectedRequest && (
          <MaintenanceEditDialog request={selectedRequest} open={isEditDialogOpen} onClose={handleCloseDialog} />
        )}
      </Container>
    </Section>
  );
}
