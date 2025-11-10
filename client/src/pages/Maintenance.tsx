import { useState } from "react";
import MaintenanceRequestCard from "@/components/MaintenanceRequestCard";
import RegionSelector from "@/components/RegionSelector";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Search } from "lucide-react";

export default function Maintenance() {
  //todo: remove mock functionality
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedRegion, setSelectedRegion] = useState("all");
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
      region: "west-central" as const,
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
      region: "east-central" as const,
    },
    {
      id: "3",
      title: "Broken light fixture",
      description: "Living room ceiling light fixture is not working.",
      category: "Electrical",
      priority: "medium" as const,
      status: "completed" as const,
      submittedBy: "Emma Wilson",
      submittedDate: new Date(2025, 10, 1),
      location: "Unit 101",
      region: "north-west" as const,
    },
    {
      id: "4",
      title: "Dishwasher not draining",
      description: "Water remains at the bottom after cycle completes.",
      category: "Appliance",
      priority: "medium" as const,
      status: "pending" as const,
      submittedBy: "David Brown",
      submittedDate: new Date(2025, 10, 7),
      location: "Unit 402",
      region: "south-west" as const,
    },
    {
      id: "5",
      title: "Water heater issue",
      description: "Hot water not staying hot for very long.",
      category: "Plumbing",
      priority: "high" as const,
      status: "pending" as const,
      submittedBy: "Lisa Martinez",
      submittedDate: new Date(2025, 10, 8),
      location: "Unit 501",
      region: "north-east" as const,
    },
    {
      id: "6",
      title: "Balcony door stuck",
      description: "The sliding door to the balcony is difficult to open and close.",
      category: "Structural",
      priority: "low" as const,
      status: "pending" as const,
      submittedBy: "Tom Anderson",
      submittedDate: new Date(2025, 10, 9),
      location: "Unit 603",
      region: "south-east" as const,
    },
  ]);

  const handleStatusChange = (id: string, status: string) => {
    setRequests(requests.map((r) => (r.id === id ? { ...r, status: status as any } : r)));
    console.log(`Updated request ${id} to ${status}`);
  };

  const filteredRequests = requests.filter((r) => {
    const matchesSearch = r.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      r.location.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesRegion = selectedRegion === "all" || r.region === selectedRegion;
    return matchesSearch && matchesRegion;
  });

  const pendingRequests = filteredRequests.filter((r) => r.status === "pending");
  const inProgressRequests = filteredRequests.filter((r) => r.status === "in_progress");
  const completedRequests = filteredRequests.filter((r) => r.status === "completed");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold">Maintenance Requests</h1>
        <p className="text-muted-foreground mt-1">Manage all property maintenance requests</p>
      </div>

      <div className="flex gap-4">
        <RegionSelector 
          selectedRegion={selectedRegion}
          onRegionChange={setSelectedRegion}
        />
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by title or location..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10"
            data-testid="input-search-requests"
          />
        </div>
      </div>

      <Tabs defaultValue="all" data-testid="tabs-request-status">
        <TabsList>
          <TabsTrigger value="all" data-testid="tab-all-requests">
            All ({filteredRequests.length})
          </TabsTrigger>
          <TabsTrigger value="pending" data-testid="tab-pending-requests">
            Pending ({pendingRequests.length})
          </TabsTrigger>
          <TabsTrigger value="in_progress" data-testid="tab-inprogress-requests">
            In Progress ({inProgressRequests.length})
          </TabsTrigger>
          <TabsTrigger value="completed" data-testid="tab-completed-requests">
            Completed ({completedRequests.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="all" className="space-y-4 mt-6">
          {filteredRequests.map((request) => (
            <MaintenanceRequestCard
              key={request.id}
              request={request}
              isAdmin={true}
              onStatusChange={handleStatusChange}
            />
          ))}
        </TabsContent>

        <TabsContent value="pending" className="space-y-4 mt-6">
          {pendingRequests.map((request) => (
            <MaintenanceRequestCard
              key={request.id}
              request={request}
              isAdmin={true}
              onStatusChange={handleStatusChange}
            />
          ))}
        </TabsContent>

        <TabsContent value="in_progress" className="space-y-4 mt-6">
          {inProgressRequests.map((request) => (
            <MaintenanceRequestCard
              key={request.id}
              request={request}
              isAdmin={true}
              onStatusChange={handleStatusChange}
            />
          ))}
        </TabsContent>

        <TabsContent value="completed" className="space-y-4 mt-6">
          {completedRequests.map((request) => (
            <MaintenanceRequestCard
              key={request.id}
              request={request}
              isAdmin={true}
              onStatusChange={handleStatusChange}
            />
          ))}
        </TabsContent>
      </Tabs>
    </div>
  );
}
