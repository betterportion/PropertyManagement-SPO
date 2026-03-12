import { useQuery } from "@tanstack/react-query";
import MaintenanceRequestCard from "@/components/MaintenanceRequestCard";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { MaintenanceRequest } from "@shared/schema";

export default function MyRequests() {
  const { data: requests = [], isLoading } = useQuery<MaintenanceRequest[]>({
    queryKey: ["/api/maintenance-requests"],
  });

  const activeRequests = requests.filter((r) => r.status !== "completed" && r.status !== "cancelled");
  const completedRequests = requests.filter((r) => r.status === "completed" || r.status === "cancelled");

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-semibold">My Requests</h1>
          <p className="text-muted-foreground mt-1">Track your maintenance requests</p>
        </div>
        <div className="text-center py-8 text-muted-foreground">Loading requests...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold">My Requests</h1>
        <p className="text-muted-foreground mt-1">Track your maintenance requests</p>
      </div>

      <Tabs defaultValue="active" data-testid="tabs-my-requests">
        <TabsList>
          <TabsTrigger value="active" data-testid="tab-active-requests">
            Active ({activeRequests.length})
          </TabsTrigger>
          <TabsTrigger value="completed" data-testid="tab-completed-requests">
            Completed ({completedRequests.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="active" className="space-y-4 mt-6">
          {activeRequests.length === 0 ? (
            <p className="text-center py-8 text-muted-foreground">No active requests.</p>
          ) : (
            activeRequests.map((request) => (
              <MaintenanceRequestCard key={request.id} request={request} isAdmin={false} />
            ))
          )}
        </TabsContent>

        <TabsContent value="completed" className="space-y-4 mt-6">
          {completedRequests.length === 0 ? (
            <p className="text-center py-8 text-muted-foreground">No completed requests.</p>
          ) : (
            completedRequests.map((request) => (
              <MaintenanceRequestCard key={request.id} request={request} isAdmin={false} />
            ))
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
