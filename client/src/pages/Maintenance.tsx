import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import MaintenanceRequestCard from "@/components/MaintenanceRequestCard";
import RegionSelector from "@/components/RegionSelector";
import BuildingSelector from "@/components/BuildingSelector";
import MaintenanceEditDialog from "@/components/MaintenanceEditDialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Search } from "lucide-react";
import type { MaintenanceRequest } from "@shared/schema";
import { useAuth } from "@/hooks/useAuth";

interface User {
  id: string;
  email: string;
  role: string;
}

export default function Maintenance() {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedRegion, setSelectedRegion] = useState("all");
  const [selectedBuilding, setSelectedBuilding] = useState("all");
  const [selectedRequest, setSelectedRequest] = useState<MaintenanceRequest | null>(null);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);

  const { user } = useAuth();
  const typedUser = user as User | null;

  const { data: requests = [], isLoading } = useQuery<MaintenanceRequest[]>({
    queryKey: ['/api/maintenance-requests'],
  });

  const uniqueBuildings = requests
    .filter(req => req.buildingAddress)
    .map(req => req.buildingAddress)
    .filter((address, index, arr) => arr.indexOf(address) === index)
    .map(address => ({
      id: address,
      address,
    }));

  const filteredRequests = requests.filter((r) => {
    const matchesSearch = r.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      r.location.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesRegion = selectedRegion === "all" || r.region.toLowerCase().replace(/\s+/g, '-') === selectedRegion;
    const matchesBuilding = selectedBuilding === "all" || r.buildingAddress === selectedBuilding;
    return matchesSearch && matchesRegion && matchesBuilding;
  });

  const pendingRequests = filteredRequests.filter((r) => r.status === "pending");
  const inProgressRequests = filteredRequests.filter((r) => r.status === "in_progress");
  const completedRequests = filteredRequests.filter((r) => r.status === "completed");

  const handleEditRequest = (request: MaintenanceRequest) => {
    setSelectedRequest(request);
    setIsEditDialogOpen(true);
  };

  const handleCloseDialog = () => {
    setIsEditDialogOpen(false);
    setSelectedRequest(null);
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-semibold">Maintenance Requests</h1>
          <p className="text-muted-foreground mt-1">Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold">Maintenance Requests</h1>
        <p className="text-muted-foreground mt-1">Manage all property maintenance requests</p>
      </div>

      <div className="flex flex-wrap gap-4">
        <RegionSelector 
          selectedRegion={selectedRegion}
          onRegionChange={setSelectedRegion}
        />
        <BuildingSelector
          selectedBuilding={selectedBuilding}
          onBuildingChange={setSelectedBuilding}
          buildings={uniqueBuildings}
        />
        <div className="relative flex-1 min-w-64">
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
              isAdmin={typedUser?.role === 'admin'}
              onEdit={() => handleEditRequest(request)}
            />
          ))}
          {filteredRequests.length === 0 && (
            <p className="text-center text-muted-foreground py-8">No maintenance requests found</p>
          )}
        </TabsContent>

        <TabsContent value="pending" className="space-y-4 mt-6">
          {pendingRequests.map((request) => (
            <MaintenanceRequestCard
              key={request.id}
              request={request}
              isAdmin={typedUser?.role === 'admin'}
              onEdit={() => handleEditRequest(request)}
            />
          ))}
          {pendingRequests.length === 0 && (
            <p className="text-center text-muted-foreground py-8">No pending requests</p>
          )}
        </TabsContent>

        <TabsContent value="in_progress" className="space-y-4 mt-6">
          {inProgressRequests.map((request) => (
            <MaintenanceRequestCard
              key={request.id}
              request={request}
              isAdmin={typedUser?.role === 'admin'}
              onEdit={() => handleEditRequest(request)}
            />
          ))}
          {inProgressRequests.length === 0 && (
            <p className="text-center text-muted-foreground py-8">No requests in progress</p>
          )}
        </TabsContent>

        <TabsContent value="completed" className="space-y-4 mt-6">
          {completedRequests.map((request) => (
            <MaintenanceRequestCard
              key={request.id}
              request={request}
              isAdmin={typedUser?.role === 'admin'}
              onEdit={() => handleEditRequest(request)}
            />
          ))}
          {completedRequests.length === 0 && (
            <p className="text-center text-muted-foreground py-8">No completed requests</p>
          )}
        </TabsContent>
      </Tabs>

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
