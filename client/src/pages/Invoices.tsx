import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import ResidentBilling from "@/components/ResidentBilling";
import RegionSelector from "@/components/RegionSelector";
import BuildingSelector from "@/components/BuildingSelector";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { insertBillingRecordSchema, type BillingRecord, type Property } from "@shared/schema";
import { z } from "zod";

const REGIONS = [
  "East Central",
  "National",
  "North East",
  "North West",
  "South East",
  "South West",
  "West Central",
];

const billingFormSchema = insertBillingRecordSchema.extend({
  rentAmount: z.coerce.string(),
});

export default function Invoices() {
  const [selectedRegion, setSelectedRegion] = useState("all");
  const [selectedBuilding, setSelectedBuilding] = useState("all");
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const { toast } = useToast();
  const { user } = useAuth();

  const { data: billingData = [], isLoading } = useQuery<BillingRecord[]>({
    queryKey: ["/api/billing"],
  });

  const { data: properties = [] } = useQuery<Property[]>({
    queryKey: ["/api/properties"],
  });

  const { data: permissionsData } = useQuery<{ canManageBilling?: boolean } | null>({
    queryKey: ["/api/users", (user as any)?.id, "/permissions"],
    queryFn: async () => {
      const userId = (user as any)?.id;
      if (!userId) return null;
      const response = await fetch(`/api/users/${userId}/permissions`);
      if (!response.ok) return null;
      return response.json();
    },
    enabled: !!(user as any)?.id,
  });

  const userRole = (user as any)?.role;
  const canManage = userRole === "admin" || userRole === "regional_administrator" || permissionsData?.canManageBilling || false;

  const form = useForm<z.infer<typeof billingFormSchema>>({
    resolver: zodResolver(billingFormSchema),
    defaultValues: {
      residentName: "",
      unit: "",
      email: "",
      phone: "",
      moveInDate: new Date(),
      rentAmount: "",
      region: "",
      buildingAddress: "",
    },
  });

  const createMutation = useMutation({
    mutationFn: async (data: z.infer<typeof billingFormSchema>) => {
      return await apiRequest("POST", "/api/billing", data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/billing"] });
      setIsAddDialogOpen(false);
      form.reset();
      toast({ title: "Success", description: "Billing record created successfully" });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to create billing record", variant: "destructive" });
    },
  });

  const handlePropertyChange = (propertyId: string) => {
    const property = properties.find(p => p.id === propertyId);
    if (property) {
      form.setValue("buildingAddress", property.address!);
      form.setValue("region", property.region);
    }
  };

  const onSubmit = (data: z.infer<typeof billingFormSchema>) => {
    createMutation.mutate(data);
  };

  const filteredRecords = billingData.filter(r => {
    const matchesRegion = selectedRegion === "all" || r.region.toLowerCase().replace(/\s+/g, '-') === selectedRegion;
    const matchesBuilding = selectedBuilding === "all" || r.buildingAddress === selectedBuilding;
    return matchesRegion && matchesBuilding;
  });

  const residents = filteredRecords.map(r => ({
    id: r.id,
    name: r.residentName,
    unit: r.unit,
    email: r.email,
    phone: r.phone,
    moveInDate: r.moveInDate ? new Date(r.moveInDate) : new Date(),
    rentAmount: parseFloat(r.rentAmount as string || "0"),
  }));

  const buildings = properties.map(p => ({ id: p.address!, address: p.address! }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold">Invoices</h1>
        <p className="text-muted-foreground mt-1">Manage invoices and billing records</p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap gap-4">
          <RegionSelector
            selectedRegion={selectedRegion}
            onRegionChange={setSelectedRegion}
          />
          <BuildingSelector
            selectedBuilding={selectedBuilding}
            onBuildingChange={setSelectedBuilding}
            buildings={buildings}
          />
        </div>

        <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
          <DialogTrigger asChild>
            <Button data-testid="button-add-billing" disabled={!canManage}>
              <Plus className="h-4 w-4 mr-2" />
              Add Billing Record
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Add Billing Record</DialogTitle>
            </DialogHeader>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="residentName"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Resident Name</FormLabel>
                        <FormControl>
                          <Input {...field} data-testid="input-resident-name" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="unit"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Unit</FormLabel>
                        <FormControl>
                          <Input {...field} placeholder="Unit 204" data-testid="input-resident-unit" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="email"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Email</FormLabel>
                        <FormControl>
                          <Input {...field} type="email" data-testid="input-resident-email" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="phone"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Phone</FormLabel>
                        <FormControl>
                          <Input {...field} placeholder="(512) 555-0123" data-testid="input-resident-phone" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="moveInDate"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Move-In Date</FormLabel>
                        <FormControl>
                          <Input
                            type="date"
                            data-testid="input-resident-movein"
                            value={field.value ? new Date(field.value).toISOString().split('T')[0] : ""}
                            onChange={e => field.onChange(new Date(e.target.value))}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="rentAmount"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Monthly Rent ($)</FormLabel>
                        <FormControl>
                          <Input {...field} type="number" step="0.01" placeholder="1500.00" data-testid="input-resident-rent" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <FormItem>
                  <FormLabel>Property</FormLabel>
                  <Select onValueChange={handlePropertyChange}>
                    <SelectTrigger data-testid="select-billing-property">
                      <SelectValue placeholder="Select a property" />
                    </SelectTrigger>
                    <SelectContent>
                      {properties.map(property => (
                        <SelectItem key={property.id} value={property.id}>
                          {property.address}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FormItem>

                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="region"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Region</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value}>
                          <FormControl>
                            <SelectTrigger data-testid="select-billing-region">
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
                  <FormField
                    control={form.control}
                    name="buildingAddress"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Building Address</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value}>
                          <FormControl>
                            <SelectTrigger data-testid="select-billing-building">
                              <SelectValue placeholder="Select property" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {properties.map(property => (
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
                </div>

                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setIsAddDialogOpen(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={createMutation.isPending} data-testid="button-submit-billing">
                    {createMutation.isPending ? "Creating..." : "Create Record"}
                  </Button>
                </DialogFooter>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      </div>

      {isLoading ? (
        <div className="text-center py-8">Loading billing records...</div>
      ) : residents.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          No billing records found. Add one to get started.
        </div>
      ) : (
        <ResidentBilling
          residents={residents}
          billingRecords={[]}
          onAddBilling={(id) => console.log("Add billing for:", id)}
          onViewResident={(id) => console.log("View resident:", id)}
        />
      )}
    </div>
  );
}
