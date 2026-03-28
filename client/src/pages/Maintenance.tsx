import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import MaintenanceRequestCard from "@/components/MaintenanceRequestCard";
import RegionSelector from "@/components/RegionSelector";
import BuildingSelector from "@/components/BuildingSelector";
import MaintenanceEditDialog from "@/components/MaintenanceEditDialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Search, Plus } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { insertMaintenanceRequestSchema, type MaintenanceRequest, type Property } from "@shared/schema";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { z } from "zod";

const CATEGORIES = [
  "Plumbing",
  "Electrical",
  "HVAC",
  "Appliance",
  "General Maintenance",
  "Structural",
];

const REGIONS = [
  "East Central",
  "National",
  "North East",
  "North West",
  "South East",
  "South West",
  "West Central",
];

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
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);

  const { user } = useAuth();
  const typedUser = user as User | null;
  const { toast } = useToast();

  const { data: requests = [], isLoading } = useQuery<MaintenanceRequest[]>({
    queryKey: ['/api/maintenance-requests'],
  });

  const { data: properties = [] } = useQuery<Property[]>({
    queryKey: ['/api/properties'],
  });

  const uniqueBuildings = properties.map(p => ({ id: p.address!, address: p.address! }));

  const handleLocationChange = (propertyAddress: string, field: { onChange: (val: string) => void }) => {
    field.onChange(propertyAddress);
    const property = properties.find(p => p.address === propertyAddress);
    if (property) {
      createForm.setValue("region", property.region);
      createForm.setValue("buildingAddress", property.address!);
    }
  };

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

  const createForm = useForm<z.infer<typeof insertMaintenanceRequestSchema>>({
    resolver: zodResolver(insertMaintenanceRequestSchema),
    defaultValues: {
      title: "",
      description: "",
      category: "",
      priority: "medium",
      status: "pending",
      location: "",
      region: "",
      buildingAddress: "",
      submittedBy: typedUser?.email || "",
    },
  });

  const createMutation = useMutation({
    mutationFn: async (data: z.infer<typeof insertMaintenanceRequestSchema>) => {
      return apiRequest('POST', '/api/maintenance-requests', data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/maintenance-requests'] });
      toast({
        title: "Success",
        description: "Maintenance request created successfully",
      });
      createForm.reset();
      setIsCreateDialogOpen(false);
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to create maintenance request",
        variant: "destructive",
      });
    },
  });

  const onSubmitCreate = (data: z.infer<typeof insertMaintenanceRequestSchema>) => {
    createMutation.mutate(data);
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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-semibold">Maintenance Requests</h1>
          <p className="text-muted-foreground mt-1">Manage all property maintenance requests</p>
        </div>
        <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
          <DialogTrigger asChild>
            <Button data-testid="button-create-maintenance-request">
              <Plus className="h-4 w-4 mr-2" />
              Create Request
            </Button>
          </DialogTrigger>
          <DialogContent className="max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Create Maintenance Request</DialogTitle>
            </DialogHeader>
            <Form {...createForm}>
              <form onSubmit={createForm.handleSubmit(onSubmitCreate)} className="space-y-4">
                <FormField
                  control={createForm.control}
                  name="title"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Title</FormLabel>
                      <FormControl>
                        <Input placeholder="Brief description of the issue" {...field} data-testid="input-title" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={createForm.control}
                  name="description"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Description</FormLabel>
                      <FormControl>
                        <Textarea placeholder="Detailed description" {...field} data-testid="input-description" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={createForm.control}
                  name="category"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Category</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger data-testid="select-category">
                            <SelectValue placeholder="Select category" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {CATEGORIES.map(cat => (
                            <SelectItem key={cat} value={cat}>{cat}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={createForm.control}
                  name="priority"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Priority</FormLabel>
                      <Select onValueChange={field.onChange} defaultValue={field.value}>
                        <FormControl>
                          <SelectTrigger data-testid="select-priority">
                            <SelectValue placeholder="Select priority" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="low">Low</SelectItem>
                          <SelectItem value="medium">Medium</SelectItem>
                          <SelectItem value="high">High</SelectItem>
                          <SelectItem value="urgent">Urgent</SelectItem>
                          <SelectItem value="wishlist">Wishlist</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={createForm.control}
                  name="location"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Location (Property)</FormLabel>
                      <Select onValueChange={(val) => handleLocationChange(val, field)} value={field.value}>
                        <FormControl>
                          <SelectTrigger data-testid="select-location">
                            <SelectValue placeholder="Select property" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {properties.filter(p => p.address).map((property) => (
                            <SelectItem key={property.id} value={property.address!}>
                              {property.address}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={createForm.control}
                  name="region"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Region</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger data-testid="select-region">
                            <SelectValue placeholder="Select region" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {REGIONS.map(r => (
                            <SelectItem key={r} value={r}>{r}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="flex gap-2 justify-end pt-4">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setIsCreateDialogOpen(false)}
                    data-testid="button-cancel-create"
                  >
                    Cancel
                  </Button>
                  <Button type="submit" disabled={createMutation.isPending} data-testid="button-submit-create">
                    {createMutation.isPending ? "Creating..." : "Create Request"}
                  </Button>
                </div>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
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
