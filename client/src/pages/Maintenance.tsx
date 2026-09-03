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
import { PhotoUpload } from "@/components/PhotoUpload";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { insertMaintenanceRequestSchema, type MaintenanceRequest, type Property } from "@shared/schema";
import { REGIONS } from "@shared/regions";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { z } from "zod";
import { Section, Container, PageHeader, PageStack } from "@/components/layout/page";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { useUrlState } from "@/hooks/use-url-state";
import { CLOSED_RANGES, closedWithinRange, locationOptions, type ClosedRange } from "@/lib/maintenanceFilters";
import MaintenanceAggregates from "@/components/MaintenanceAggregates";
import { ClipboardList, SlidersHorizontal } from "lucide-react";

const createRequestSchema = insertMaintenanceRequestSchema.extend({
  title: z.string().min(1, "Title is required"),
  description: z.string().min(1, "Description is required"),
  category: z.string().min(1, "Category is required"),
  location: z.string().min(1, "Location is required"),
  priority: z.enum(["low", "medium", "high", "urgent", "wishlist"], {
    errorMap: () => ({ message: "Priority is required" }),
  }),
});

const CATEGORIES = [
  "Plumbing",
  "Electrical",
  "HVAC",
  "Appliance",
  "General Maintenance",
  "Structural",
];


interface User {
  id: string;
  email: string;
  role: string;
}

export default function Maintenance() {
  const [filters, setFilters, resetFilters] = useUrlState({
    q: "",
    region: "all",
    building: "all",
    room: "all",
    // 90 days by default rather than "all": an RA opening this page wants
    // what is happening, not four years of finished work. "All closed
    // requests" is one click away.
    closed: "90",
  });
  const searchQuery = filters.q;
  const selectedRegion = filters.region;
  const selectedBuilding = filters.building;
  const selectedRoom = filters.room;
  const closedRange = filters.closed as ClosedRange;
  const [selectedRequest, setSelectedRequest] = useState<MaintenanceRequest | null>(null);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);

  const { user } = useAuth();
  const typedUser = user as User | null;
  const { toast } = useToast();

  const { data: requests = [], isLoading, isError, refetch } = useQuery<MaintenanceRequest[]>({
    queryKey: ['/api/maintenance-requests'],
  });

  const { data: properties = [] } = useQuery<Property[]>({
    queryKey: ['/api/properties'],
  });

  const uniqueBuildings = properties.map(p => ({ id: p.address!, address: p.address! }));

  /**
   * Picking the house.
   *
   * This used to write the address into `location`, which meant `location`
   * held a room for a resident-filed request and an address for a staff-filed
   * one -- and grouping "these blinds have broken every year" cannot work
   * across two different meanings of one column. The house now lands in
   * `buildingAddress` where it belongs, and `location` is the room below.
   */
  const handlePropertyChange = (propertyAddress: string, field: { onChange: (val: string) => void }) => {
    field.onChange(propertyAddress);
    const property = properties.find(p => p.address === propertyAddress);
    if (property) {
      createForm.setValue("region", property.region);
      // A room name carried over from the last house means nothing in this one.
      createForm.setValue("location", "");
    }
  };

  // The room options come from the house in view, not from the whole
  // portfolio -- offering every room name SPO has ever recorded would make the
  // filter useless the moment there is more than one house.
  const requestsInScope = requests.filter(
    (r) =>
      (selectedRegion === "all" || r.region === selectedRegion) &&
      (selectedBuilding === "all" || r.buildingAddress === selectedBuilding),
  );
  const roomOptions = locationOptions(requestsInScope);

  const filteredRequests = requestsInScope.filter((r) => {
    const matchesSearch = r.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      r.location.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesRoom = selectedRoom === "all" || r.location === selectedRoom;
    // Open work always survives the range; the range is about history.
    const matchesRange = closedWithinRange(r, closedRange);
    return matchesSearch && matchesRoom && matchesRange;
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

  const createForm = useForm<z.infer<typeof createRequestSchema>>({
    resolver: zodResolver(createRequestSchema),
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
      photoUrl: null,
    },
  });

  // The rooms of the house picked in the create dialog. Keyed on the address
  // so switching house re-reads; disabled until one is chosen, because there
  // is no house to ask about yet.
  const creatingForAddress = createForm.watch("buildingAddress");
  const creatingForProperty = properties.find((p) => p.address === creatingForAddress);
  const { data: staffLocationSuggestions = [] } = useQuery<string[]>({
    queryKey: ["/api/maintenance-locations", creatingForProperty?.id],
    queryFn: async () => {
      const response = await fetch(`/api/maintenance-locations?propertyId=${creatingForProperty!.id}`, {
        credentials: "include",
      });
      if (!response.ok) return [];
      return await response.json();
    },
    enabled: !!creatingForProperty,
  });

  const createMutation = useMutation({
    mutationFn: async (data: z.infer<typeof createRequestSchema>) => {
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

  const onSubmitCreate = (data: z.infer<typeof createRequestSchema>) => {
    createMutation.mutate(data);
  };

  if (isLoading) return <Section><Container><LoadingState message="Loading maintenance requests..." /></Container></Section>;
  if (isError) return <Section><Container><ErrorState message="Maintenance requests could not be loaded." onRetry={() => refetch()} /></Container></Section>;

  return (
    <Section>
      <Container>
      <PageStack>
      <PageHeader title="Maintenance requests" description="Keep property issues moving from report to resolution."
        actions={<div className="flex flex-wrap items-center gap-2">
          <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
          <DialogTrigger asChild>
            <Button variant="primary" data-testid="button-create-maintenance-request">
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
                  name="buildingAddress"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Property</FormLabel>
                      <Select onValueChange={(val) => handlePropertyChange(val, field)} value={field.value}>
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
                  name="location"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Where in the house</FormLabel>
                      <FormControl>
                        {/* Suggests from the house's own walkthrough rooms
                            without restricting: free text alone will not group
                            "living room" and "Living Rm", and grouping is the
                            point -- it is what lets somebody notice that these
                            blinds have broken every year. */}
                        <Input
                          list="staff-request-location-suggestions"
                          placeholder="e.g. Kitchen, Upstairs bathroom"
                          {...field}
                          value={field.value ?? ""}
                          data-testid="input-staff-request-location"
                        />
                      </FormControl>
                      <datalist id="staff-request-location-suggestions">
                        {staffLocationSuggestions.map((name) => <option key={name} value={name} />)}
                      </datalist>
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
                <FormItem>
                  <FormLabel>Photo (optional)</FormLabel>
                  <PhotoUpload
                    onUpload={(url) => createForm.setValue("photoUrl", url)}
                    onError={(err) => toast({ title: "Upload failed", description: err, variant: "destructive" })}
                  />
                </FormItem>

                <div className="flex gap-2 justify-end pt-4">
                  <Button
                    type="button"
                    variant="secondary"
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
        </div>} />

      <div className="flex flex-col gap-3 rounded-lg border border-border/80 bg-muted/30 p-4 md:flex-row md:items-center">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground md:mr-1">
          <SlidersHorizontal className="h-4 w-4 text-primary-strong" /> Filter requests
        </div>
        <RegionSelector 
          selectedRegion={selectedRegion}
          onRegionChange={(value) => setFilters({ region: value })}
        />
        <BuildingSelector
          selectedBuilding={selectedBuilding}
          onBuildingChange={(value) => setFilters({ building: value })}
          buildings={uniqueBuildings}
        />
        {roomOptions.length > 0 && (
          <Select value={selectedRoom} onValueChange={(value) => setFilters({ room: value })}>
            <SelectTrigger className="w-44" data-testid="select-filter-room" aria-label="Filter by room">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Every room</SelectItem>
              {roomOptions.map((room) => (
                <SelectItem key={room} value={room}>{room}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <Select value={closedRange} onValueChange={(value) => setFilters({ closed: value })}>
          <SelectTrigger className="w-56" data-testid="select-filter-closed-range" aria-label="How far back to show closed requests">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CLOSED_RANGES.map((range) => (
              <SelectItem key={range.value} value={range.value}>{range.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="relative flex-1 min-w-0 md:min-w-64">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by title or location..."
            value={searchQuery}
            onChange={(e) => setFilters({ q: e.target.value })}
            className="pl-10"
            data-testid="input-search-requests"
          />
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={resetFilters}>Clear filters</Button>
      </div>

      <Tabs defaultValue="all" data-testid="tabs-request-status">
        <div className="overflow-x-auto [&::-webkit-scrollbar]:hidden" style={{ scrollbarWidth: "none" }}>
          <TabsList className="w-max">
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
            <TabsTrigger value="patterns" data-testid="tab-patterns">
              Patterns
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="all" className="space-y-4 mt-6">
          {filteredRequests.map((request) => (
            <MaintenanceRequestCard
              key={request.id}
              request={request}
              isAdmin={typedUser?.role === 'admin'}
              onEdit={() => handleEditRequest(request)}
            />
          ))}
          {filteredRequests.length === 0 && <EmptyState icon={ClipboardList} title="Your request queue is clear" description="Try another filter, or create a request when a property issue needs attention." />}
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
          {pendingRequests.length === 0 && <EmptyState icon={ClipboardList} title="Nothing is waiting for review" description="New maintenance reports will appear here as they arrive." />}
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
          {inProgressRequests.length === 0 && <EmptyState icon={ClipboardList} title="No active repairs right now" description="Requests move here once work has started." />}
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
          {completedRequests.length === 0 && <EmptyState icon={ClipboardList} title="Completed work will collect here" description="Resolved requests remain available for your records." />}
        </TabsContent>
        <TabsContent value="patterns" className="mt-6">
          {/* Aggregates rather than filters: what KEEPS happening, which is
              the question that settles an argument about whether to keep
              renting a house or keep using a contractor. */}
          <MaintenanceAggregates />
        </TabsContent>

      </Tabs>

      {selectedRequest && (
        <MaintenanceEditDialog
          request={selectedRequest}
          open={isEditDialogOpen}
          onClose={handleCloseDialog}
        />
      )}
      </PageStack>
      </Container>
    </Section>
  );
}
