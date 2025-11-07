import MaintenanceRequestCard from "@/components/MaintenanceRequestCard";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export default function MyRequests() {
  //todo: remove mock functionality
  const requests = [
    {
      id: "1",
      title: "Leaking kitchen faucet",
      description: "The kitchen faucet has been dripping constantly for the past week.",
      category: "Plumbing",
      priority: "high" as const,
      status: "in_progress" as const,
      submittedBy: "Sarah Johnson",
      submittedDate: new Date(2025, 10, 5),
      location: "Unit 204",
    },
    {
      id: "2",
      title: "Bedroom window won't close",
      description: "The window mechanism seems jammed.",
      category: "Structural",
      priority: "medium" as const,
      status: "pending" as const,
      submittedBy: "Sarah Johnson",
      submittedDate: new Date(2025, 10, 7),
      location: "Unit 204",
    },
    {
      id: "3",
      title: "Light bulb replacement",
      description: "Hallway light needs new bulb.",
      category: "Electrical",
      priority: "low" as const,
      status: "completed" as const,
      submittedBy: "Sarah Johnson",
      submittedDate: new Date(2025, 9, 28),
      location: "Unit 204",
    },
  ];

  const activeRequests = requests.filter((r) => r.status !== "completed");
  const completedRequests = requests.filter((r) => r.status === "completed");

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
          {activeRequests.map((request) => (
            <MaintenanceRequestCard key={request.id} request={request} isAdmin={false} />
          ))}
        </TabsContent>

        <TabsContent value="completed" className="space-y-4 mt-6">
          {completedRequests.map((request) => (
            <MaintenanceRequestCard key={request.id} request={request} isAdmin={false} />
          ))}
        </TabsContent>
      </Tabs>
    </div>
  );
}
