import { useState } from "react";
import DashboardStats from "@/components/DashboardStats";
import MaintenanceRequestCard from "@/components/MaintenanceRequestCard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Calendar } from "lucide-react";

export default function AdminDashboard() {
  //todo: remove mock functionality
  const [requests, setRequests] = useState([
    {
      id: "1",
      title: "Leaking kitchen faucet",
      description: "The kitchen faucet has been dripping constantly for the past week.",
      category: "Plumbing",
      priority: "high" as const,
      status: "pending" as const,
      submittedBy: "Sarah Johnson",
      submittedDate: new Date(2025, 10, 5),
      location: "Unit 204",
    },
    {
      id: "2",
      title: "AC not cooling properly",
      description: "The air conditioning system is running but not cooling effectively.",
      category: "HVAC",
      priority: "urgent" as const,
      status: "in_progress" as const,
      submittedBy: "Michael Chen",
      submittedDate: new Date(2025, 10, 6),
      location: "Unit 305",
    },
    {
      id: "3",
      title: "Broken light fixture",
      description: "Living room ceiling light fixture is not working.",
      category: "Electrical",
      priority: "medium" as const,
      status: "pending" as const,
      submittedBy: "Emma Wilson",
      submittedDate: new Date(2025, 10, 7),
      location: "Unit 101",
    },
  ]);

  const stats = {
    totalProperties: 3,
    activeRequests: requests.filter((r) => r.status === "pending" || r.status === "in_progress").length,
    pendingInvoices: 5,
    totalAssets: 48,
  };

  const handleStatusChange = (id: string, status: string) => {
    setRequests(requests.map((r) => (r.id === id ? { ...r, status: status as any } : r)));
    console.log(`Updated request ${id} to ${status}`);
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
                onStatusChange={handleStatusChange}
              />
            ))}
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
    </div>
  );
}
