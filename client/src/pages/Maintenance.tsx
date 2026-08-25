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
import { Search, Plus, Link2, Copy, Check, ChevronRight } from "lucide-react";
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
  const [filters, setFilters, resetFilters] = useUrlState({ q: "", region: "all", building: "all" });
  const searchQuery = filters.q;
  const selectedRegion = filters.region;
  const selectedBuilding = filters.building;
  const [selectedRequest, setSelectedRequest] = useState<MaintenanceRequest | null>(null);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [isJotFormDialogOpen, setIsJotFormDialogOpen] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);

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

  const isAdmin = typedUser?.role === "admin";
  const canManageJotForm = isAdmin || typedUser?.role === "regional_administrator";

  const { data: webhookConfig } = useQuery<{ webhookUrl: string; fields: Record<string, string | null> }>({
    queryKey: ['/api/webhooks/jotform/config'],
    enabled: canManageJotForm && isJotFormDialogOpen,
  });

  const copyWebhookUrl = () => {
    if (webhookConfig?.webhookUrl) {
      navigator.clipboard.writeText(webhookConfig.webhookUrl);
      setCopiedUrl(true);
      setTimeout(() => setCopiedUrl(false), 2000);
    }
  };

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
    const matchesRegion = selectedRegion === "all" || r.region === selectedRegion;
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
          {canManageJotForm && (
            <Button variant="secondary" onClick={() => setIsJotFormDialogOpen(true)} data-testid="button-jotform-setup">
              <Link2 className="h-4 w-4 mr-2" />
              JotForm Setup
            </Button>
          )}
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
      </Tabs>

      {selectedRequest && (
        <MaintenanceEditDialog
          request={selectedRequest}
          open={isEditDialogOpen}
          onClose={handleCloseDialog}
        />
      )}

      <Dialog open={isJotFormDialogOpen} onOpenChange={setIsJotFormDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto" data-testid="dialog-jotform-setup">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Link2 className="h-5 w-5" />
              JotForm Webhook Setup
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-5 py-1">
            <p className="text-muted-foreground text-sm">
              Connect a JotForm form so that submissions automatically create maintenance requests in this system.
            </p>

            <div className="space-y-2">
              <h3 className="font-medium text-sm">Step 1 — Copy the Webhook URL</h3>
              <div className="flex items-center gap-2">
                <code className="flex-1 bg-muted text-muted-foreground text-xs px-3 py-2 rounded-md truncate" data-testid="text-webhook-url">
                  {webhookConfig?.webhookUrl ?? "Loading…"}
                </code>
                <Button size="icon" variant="ghost" onClick={copyWebhookUrl} disabled={!webhookConfig?.webhookUrl} data-testid="button-copy-webhook-url">
                  {copiedUrl ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
            </div>

            <div className="space-y-2">
              <h3 className="font-medium text-sm">Step 2 — Add the Webhook in JotForm</h3>
              <ol className="text-sm text-muted-foreground space-y-1.5 list-none">
                {[
                  "Open your JotForm form and click Settings.",
                  'Navigate to the Integrations tab and search for "Webhook".',
                  "Paste the URL above into the Webhook URL field.",
                  'Click "Complete Integration" to save.',
                ].map((step, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <ChevronRight className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
                    <span>{step}</span>
                  </li>
                ))}
              </ol>
            </div>

            <div className="space-y-2">
              <h3 className="font-medium text-sm">Step 3 — Field Mapping (optional)</h3>
              <p className="text-xs text-muted-foreground">
                Set the following environment variables on the server to map your JotForm question labels to the corresponding fields. If not set, the system will attempt to auto-detect them by matching question labels.
              </p>
              <div className="rounded-md border overflow-hidden">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-muted">
                      <th className="text-left px-3 py-2 font-medium text-muted-foreground">Environment Variable</th>
                      <th className="text-left px-3 py-2 font-medium text-muted-foreground">Maps To</th>
                      <th className="text-left px-3 py-2 font-medium text-muted-foreground">Current Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      { env: "JOTFORM_FIELD_TITLE", label: "Request Title" },
                      { env: "JOTFORM_FIELD_DESCRIPTION", label: "Description" },
                      { env: "JOTFORM_FIELD_CATEGORY", label: "Category" },
                      { env: "JOTFORM_FIELD_PRIORITY", label: "Priority" },
                      { env: "JOTFORM_FIELD_LOCATION", label: "Location" },
                      { env: "JOTFORM_FIELD_EMAIL", label: "Submitter Email" },
                      { env: "JOTFORM_FIELD_REGION", label: "Region" },
                      { env: "JOTFORM_FIELD_BUILDING", label: "Building Address" },
                      { env: "JOTFORM_DEFAULT_REGION", label: "Default Region" },
                      { env: "JOTFORM_DEFAULT_BUILDING", label: "Default Building" },
                      { env: "JOTFORM_DEFAULT_LOCATION", label: "Default Location" },
                      { env: "JOTFORM_WEBHOOK_SECRET", label: "Webhook Secret (optional)" },
                    ].map((row) => (
                      <tr key={row.env} className="border-t">
                        <td className="px-3 py-2 font-mono text-muted-foreground">{row.env}</td>
                        <td className="px-3 py-2 text-muted-foreground">{row.label}</td>
                        <td className="px-3 py-2">
                          {webhookConfig?.fields?.[row.env] != null ? (
                            <span className="text-foreground">{webhookConfig.fields[row.env]}</span>
                          ) : (
                            <span className="text-muted-foreground italic">not set</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      </PageStack>
      </Container>
    </Section>
  );
}
