import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import ContactsInvoices from "@/components/ContactsInvoices";
import RegionSelector from "@/components/RegionSelector";
import BuildingSelector from "@/components/BuildingSelector";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { insertMaintenanceContactSchema, type MaintenanceContact } from "@shared/schema";
import type { z } from "zod";

export default function Contacts() {
  const [selectedRegion, setSelectedRegion] = useState("all");
  const [selectedBuilding, setSelectedBuilding] = useState("all");
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const { toast } = useToast();
  const { user } = useAuth();

  const { data: contactsData, isLoading } = useQuery<MaintenanceContact[]>({
    queryKey: ["/api/contacts"],
  });

  const { data: permissionsData } = useQuery<{canManageContacts?: boolean} | null>({
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

  const canManage = permissionsData?.canManageContacts || false;

  const createContactMutation = useMutation({
    mutationFn: async (data: z.infer<typeof insertMaintenanceContactSchema>) => {
      return await apiRequest("POST", "/api/contacts", data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/contacts"] });
      setIsAddDialogOpen(false);
      form.reset();
      toast({
        title: "Success",
        description: "Contact created successfully",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to create contact",
        variant: "destructive",
      });
    },
  });

  const form = useForm<z.infer<typeof insertMaintenanceContactSchema>>({
    resolver: zodResolver(insertMaintenanceContactSchema),
    defaultValues: {
      name: "",
      company: "",
      service: "",
      phone: "",
      email: "",
      region: "",
      buildingAddress: "",
    },
  });

  const onSubmit = (data: z.infer<typeof insertMaintenanceContactSchema>) => {
    createContactMutation.mutate(data);
  };

  const contacts = (contactsData || []).filter((contact) => {
    const matchesRegion = selectedRegion === "all" || contact.region === selectedRegion;
    const matchesBuilding = selectedBuilding === "all" || contact.buildingAddress === selectedBuilding;
    return matchesRegion && matchesBuilding;
  });

  const buildings = Array.from(new Set((contactsData || []).map(c => c.buildingAddress))).map(addr => ({
    id: addr,
    address: addr,
  }));

  const allInvoices: any[] = [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold">Contacts & Invoices</h1>
        <p className="text-muted-foreground mt-1">Manage maintenance contacts and track invoices</p>
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
            <Button data-testid="button-add-contact" disabled={!canManage}>
              <Plus className="h-4 w-4 mr-2" />
              Add Contact
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Add New Contact</DialogTitle>
            </DialogHeader>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="name"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Contact Name</FormLabel>
                        <FormControl>
                          <Input {...field} data-testid="input-contact-name" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="company"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Company</FormLabel>
                        <FormControl>
                          <Input {...field} data-testid="input-contact-company" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <FormField
                  control={form.control}
                  name="service"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Service/Specialty</FormLabel>
                      <FormControl>
                        <Input {...field} placeholder="Plumbing, HVAC, Electrical, etc." data-testid="input-contact-service" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="phone"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Phone</FormLabel>
                        <FormControl>
                          <Input {...field} placeholder="(512) 555-0123" data-testid="input-contact-phone" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="email"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Email</FormLabel>
                        <FormControl>
                          <Input {...field} type="email" data-testid="input-contact-email" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="region"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Region</FormLabel>
                        <FormControl>
                          <Input {...field} placeholder="west-central, north-east, etc." data-testid="input-contact-region" />
                        </FormControl>
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
                        <FormControl>
                          <Input {...field} placeholder="123 Main St, Austin, TX" data-testid="input-contact-building" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setIsAddDialogOpen(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={createContactMutation.isPending} data-testid="button-submit-contact">
                    {createContactMutation.isPending ? "Creating..." : "Create Contact"}
                  </Button>
                </DialogFooter>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      </div>

      {isLoading ? (
        <div className="text-center py-8">Loading contacts...</div>
      ) : (
        <ContactsInvoices
          contacts={contacts}
          invoices={allInvoices}
          onAddContact={() => setIsAddDialogOpen(true)}
          onAddInvoice={() => console.log("Add invoice")}
          onViewInvoice={(id) => console.log("View invoice:", id)}
        />
      )}
    </div>
  );
}
