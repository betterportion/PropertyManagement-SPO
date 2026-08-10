import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Building2, Camera, DollarSign, Package, Wrench } from "lucide-react";

import MaintenanceRequestCard from "@/components/MaintenanceRequestCard";
import MaintenanceEditDialog from "@/components/MaintenanceEditDialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Container, PageHeader, PageStack, Section } from "@/components/layout/page";
import { StatGrid, StatTile } from "@/components/stat-tile";
import { EmptyState } from "@/components/states";
import { formatDate, formatValue } from "@/lib/format";
import type {
  Asset,
  Invoice,
  MaintenanceRequest,
  Property,
  WalkthroughPhoto,
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
  const photosQuery = useQuery<WalkthroughPhoto[]>({ queryKey: ["/api/walkthrough-photos"] });

  const requests = requestsQuery.data ?? [];
  const invoices = invoicesQuery.data ?? [];

  const activeRequests = requests.filter(
    (r) => r.status === "pending" || r.status === "in_progress",
  );
  const openInvoices = invoices.filter((i) => i.status === "pending" || i.status === "overdue");

  const recentRequests = [...requests]
    .sort((a, b) => time(b.submittedDate) - time(a.submittedDate))
    .slice(0, 3);

  const recentPhotos = [...(photosQuery.data ?? [])]
    .sort((a, b) => time(b.uploadedDate) - time(a.uploadedDate))
    .slice(0, 4);

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
              value={propertiesQuery.data?.length ?? 0}
              hint="Properties on file"
              icon={Building2}
              isLoading={propertiesQuery.isLoading}
            />
            <StatTile
              label="Active requests"
              value={activeRequests.length}
              hint="Reported and not yet finished"
              icon={Wrench}
              isLoading={requestsQuery.isLoading}
            />
            <StatTile
              label="Open invoices"
              value={openInvoices.length}
              hint="Awaiting payment"
              icon={DollarSign}
              isLoading={invoicesQuery.isLoading}
            />
            <StatTile
              label="Tracked assets"
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
                <h2 className="text-xl font-semibold tracking-tight">Recent walkthrough photos</h2>
                <Button variant="secondary" size="sm" asChild data-testid="button-view-walkthroughs">
                  <Link href="/walkthroughs">View all</Link>
                </Button>
              </div>
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Camera className="h-4 w-4" />
                    Latest uploads
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {recentPhotos.length === 0 ? (
                    <EmptyState
                      title="No walkthrough photos yet"
                      description="Photos uploaded during a walkthrough show up here."
                      className="py-4"
                    />
                  ) : (
                    recentPhotos.map((photo) => (
                      <div
                        key={photo.id}
                        className="flex items-start justify-between gap-3 rounded-md bg-muted p-3"
                        data-testid={`walkthrough-photo-${photo.id}`}
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">
                            {formatValue(photo.location)}
                          </p>
                          <p className="mt-1 truncate text-xs text-muted-foreground">
                            {formatValue(photo.buildingAddress)}
                          </p>
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-1">
                          <Badge
                            variant={
                              photo.condition === "additional_damage" ? "warning" : "success"
                            }
                          >
                            {photo.condition === "additional_damage"
                              ? "New damage"
                              : "No change"}
                          </Badge>
                          <span className="text-xs text-muted-foreground">
                            {formatDate(photo.uploadedDate)}
                          </span>
                        </div>
                      </div>
                    ))
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
