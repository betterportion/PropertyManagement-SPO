import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import DashboardStats from "@/components/DashboardStats";
import MaintenanceRequestCard from "@/components/MaintenanceRequestCard";
import MaintenanceEditDialog from "@/components/MaintenanceEditDialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Calendar } from "lucide-react";
import type { MaintenanceRequest } from "@shared/schema";

export default function AdminDashboard() {
  const [selectedRequest, setSelectedRequest] = useState<MaintenanceRequest | null>(null);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);

  const { data: requests = [] } = useQuery<MaintenanceRequest[]>({
    queryKey: ['/api/maintenance-requests'],
  });

  const stats = {
    totalProperties: 3,
    activeRequests: requests.filter((r) => r.status === "pending" || r.status === "in_progress").length,
    pendingInvoices: 5,
    totalAssets: 48,
  };

  const handleEditRequest = (request: MaintenanceRequest) => {
    setSelectedRequest(request);
    setIsEditDialogOpen(true);
  };

  const handleCloseDialog = () => {
    setIsEditDialogOpen(false);
    setSelectedRequest(null);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold">Dashboard</h1>
        <p className="text-muted-foreground mt-1">Welcome back! Here's what's happening.</p>
      </div>

      <DashboardStats stats={stats} />

      <div className="grid gap-6 md:grid-cols-2">
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-semibold">Recent Maintenance Requests</h2>
            <Button variant="outline" size="sm" data-testid="button-view-all-requests">
              View All
            </Button>
          </div>
          <div className="space-y-4">
            {requests.slice(0, 3).map((request) => (
              <MaintenanceRequestCard
                key={request.id}
                request={request}
                isAdmin={true}
                onEdit={() => handleEditRequest(request)}
              />
            ))}
            {requests.length === 0 && (
              <p className="text-center text-muted-foreground py-4">No recent requests</p>
            )}
          </div>
        </div>

        <div className="space-y-4">
          <h2 className="text-xl font-semibold">Upcoming Walkthroughs</h2>
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Calendar className="h-4 w-4" />
                This Week
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-start justify-between p-3 bg-muted rounded-md">
                <div>
                  <p className="font-medium text-sm">Unit 204 Move-Out Inspection</p>
                  <p className="text-xs text-muted-foreground mt-1">Sunset Apartments</p>
                </div>
                <p className="text-xs text-muted-foreground">Nov 10</p>
              </div>
              <div className="flex items-start justify-between p-3 bg-muted rounded-md">
                <div>
                  <p className="font-medium text-sm">Unit 305 Quarterly Inspection</p>
                  <p className="text-xs text-muted-foreground mt-1">Sunset Apartments</p>
                </div>
                <p className="text-xs text-muted-foreground">Nov 12</p>
              </div>
              <div className="flex items-start justify-between p-3 bg-muted rounded-md">
                <div>
                  <p className="font-medium text-sm">Common Areas Check</p>
                  <p className="text-xs text-muted-foreground mt-1">Oak Ridge Complex</p>
                </div>
                <p className="text-xs text-muted-foreground">Nov 14</p>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {selectedRequest && (
        <MaintenanceEditDialog
          request={selectedRequest}
          open={isEditDialogOpen}
          onClose={handleCloseDialog}
        />
      )}
    </div>
  );
}
