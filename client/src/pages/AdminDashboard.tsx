import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Building2, DollarSign, ListChecks, Package, Wrench } from "lucide-react";

import MaintenanceRequestCard from "@/components/MaintenanceRequestCard";
import MaintenanceEditDialog from "@/components/MaintenanceEditDialog";
import ActionItemList from "@/components/ActionItemList";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Container, PageHeader, PageStack, Section } from "@/components/layout/page";
import { StatGrid, StatTile } from "@/components/stat-tile";
import { EmptyState } from "@/components/states";
import type { ActionItem } from "@/lib/actionItems";
import type {
  Asset,
  Invoice,
  MaintenanceRequest,
  Property,
} from "@shared/schema";

function time(value: Date | string | null | undefined) {
  if (!value) return 0;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

export default function AdminDashboard() {
  const [selectedRequest, setSelectedRequest] = useState<MaintenanceRequest | null>(null);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);

  const requestsQuery = useQuery<MaintenanceRequest[]>({
    queryKey: ["/api/maintenance-requests"],
  });
  const propertiesQuery = useQuery<Property[]>({ queryKey: ["/api/properties"] });
  const assetsQuery = useQuery<Asset[]>({ queryKey: ["/api/assets"] });
  const invoicesQuery = useQuery<Invoice[]>({ queryKey: ["/api/invoices"] });
  const actionItemsQuery = useQuery<ActionItem[]>({ queryKey: ["/api/action-items"] });

  const requests = requestsQuery.data ?? [];
  const invoices = invoicesQuery.data ?? [];

  const activeRequests = requests.filter(
    (r) => r.status === "pending" || r.status === "in_progress",
  );
  const openInvoices = invoices.filter((i) => i.status === "pending" || i.status === "overdue");

  const recentRequests = [...requests]
    .sort((a, b) => time(b.submittedDate) - time(a.submittedDate))
    .slice(0, 3);

  // The server already ranks action items most-urgent first; show the top few.
  const topActionItems = (actionItemsQuery.data ?? []).slice(0, 5);

  const handleEditRequest = (request: MaintenanceRequest) => {
    setSelectedRequest(request);
    setIsEditDialogOpen(true);
  };

  const handleCloseDialog = () => {
    setIsEditDialogOpen(false);
    setSelectedRequest(null);
  };

  return (
    <Section size="compact">
      <Container>
        <PageStack>
          <PageHeader title="Dashboard" description="Here's what's happening across your properties." />

          <StatGrid>
            <StatTile
              label="Properties"
              href="/properties"
              value={propertiesQuery.data?.length ?? 0}
              hint="Properties on file"
              icon={Building2}
              isLoading={propertiesQuery.isLoading}
            />
            <StatTile
              label="Active requests"
              href="/maintenance"
              value={activeRequests.length}
              hint="Reported and not yet finished"
              icon={Wrench}
              isLoading={requestsQuery.isLoading}
            />
            <StatTile
              label="Open invoices"
              href="/contacts"
              value={openInvoices.length}
              hint="Awaiting payment"
              icon={DollarSign}
              isLoading={invoicesQuery.isLoading}
            />
            <StatTile
              label="Tracked assets"
              href="/assets"
              value={assetsQuery.data?.length ?? 0}
              hint="Appliances and equipment"
              icon={Package}
              isLoading={assetsQuery.isLoading}
            />
          </StatGrid>

          <div className="grid gap-6 lg:grid-cols-2">
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-xl font-semibold tracking-tight">Recent maintenance requests</h2>
                <Button variant="secondary" size="sm" asChild data-testid="button-view-all-requests">
                  <Link href="/maintenance">View all</Link>
                </Button>
              </div>
              <div className="space-y-4">
                {recentRequests.map((request) => (
                  <MaintenanceRequestCard
                    key={request.id}
                    request={request}
                    isAdmin={true}
                    onEdit={() => handleEditRequest(request)}
                  />
                ))}
                {!requestsQuery.isLoading && recentRequests.length === 0 && (
                  <Card>
                    <CardContent className="p-0">
                      <EmptyState
                        icon={Wrench}
                        title="No requests yet"
                        description="When a resident reports a problem, it will appear here."
                      />
                    </CardContent>
                  </Card>
                )}
              </div>
            </div>

            <div className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-xl font-semibold tracking-tight">Action items</h2>
                <Button variant="secondary" size="sm" asChild data-testid="button-view-tasks">
                  <Link href="/tasks">See all tasks</Link>
                </Button>
              </div>
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <ListChecks className="h-4 w-4" />
                    Needs attention
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {topActionItems.length === 0 ? (
                    <EmptyState
                      title="You're all caught up"
                      description="Unpaid rent, deposits to return, maintenance coming due and open tasks show up here."
                      className="py-4"
                    />
                  ) : (
                    <ActionItemList items={topActionItems} />
                  )}
                </CardContent>
              </Card>
            </div>
          </div>
        </PageStack>

        {selectedRequest && (
          <MaintenanceEditDialog
            request={selectedRequest}
            open={isEditDialogOpen}
            onClose={handleCloseDialog}
          />
        )}
      </Container>
    </Section>
  );
}
