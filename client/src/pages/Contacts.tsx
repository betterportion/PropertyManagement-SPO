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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Plus, Upload, FileText, X, Loader2 } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { insertMaintenanceContactSchema, type MaintenanceContact, type Property, type BillingRecord } from "@shared/schema";
import { REGIONS } from "@shared/regions";
import { z } from "zod";
import { Section, Container, PageHeader, PageStack } from "@/components/layout/page";
import { LoadingState } from "@/components/states";


const invoiceFormSchema = z.object({
  companyName: z.string().min(1, "Company name is required"),
  email: z.string().min(1, "Email is required").email("Valid email required"),
  phone: z.string().min(1, "Phone is required"),
  invoiceCost: z.string().min(1, "Invoice cost is required"),
  // Billing records are scoped by region on the server. Without a region a
  // record would be saved but then hidden from everyone except an admin, so
  // the field is required here rather than left to a silent default.
  region: z.string().min(1, "Region is required"),
});

export default function Contacts() {
  const [selectedRegion, setSelectedRegion] = useState("all");
  const [selectedBuilding, setSelectedBuilding] = useState("all");
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [isAddInvoiceDialogOpen, setIsAddInvoiceDialogOpen] = useState(false);
  const [editingContact, setEditingContact] = useState<MaintenanceContact | null>(null);
  const [contactSource, setContactSource] = useState<"existing" | "new">("existing");
  const [selectedContactId, setSelectedContactId] = useState<string>("");
  const [contractInvoiceUrl, setContractInvoiceUrl] = useState<string | null>(null);
  const [contractInvoiceName, setContractInvoiceName] = useState<string | null>(null);
  const [coiUrl, setCoiUrl] = useState<string | null>(null);
  const [coiName, setCoiName] = useState<string | null>(null);
  const [w9Url, setW9Url] = useState<string | null>(null);
  const [w9Name, setW9Name] = useState<string | null>(null);
  const [uploadingContract, setUploadingContract] = useState(false);
  const [uploadingCoi, setUploadingCoi] = useState(false);
  const [uploadingW9, setUploadingW9] = useState(false);
  const { toast } = useToast();
  const { user } = useAuth();

  const { data: contactsData, isLoading } = useQuery<MaintenanceContact[]>({
    queryKey: ["/api/contacts"],
  });

  const { data: properties = [] } = useQuery<Property[]>({
    queryKey: ["/api/properties"],
  });

  const { data: billingRecords = [] } = useQuery<BillingRecord[]>({
    queryKey: ["/api/billing"],
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

  const userRole = (user as any)?.role;
  const canManage = userRole === "admin" || userRole === "regional_administrator" || permissionsData?.canManageContacts || false;

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

  const editForm = useForm<z.infer<typeof insertMaintenanceContactSchema>>({
    resolver: zodResolver(insertMaintenanceContactSchema),
  });

  const updateContactMutation = useMutation({
    mutationFn: async (data: z.infer<typeof insertMaintenanceContactSchema> & { id: string }) => {
      const { id, ...rest } = data;
      return await apiRequest("PATCH", `/api/contacts/${id}`, rest);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/contacts"] });
      setIsEditDialogOpen(false);
      setEditingContact(null);
      toast({
        title: "Success",
        description: "Contact updated successfully",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to update contact",
        variant: "destructive",
      });
    },
  });

  const onSubmit = (data: z.infer<typeof insertMaintenanceContactSchema>) => {
    createContactMutation.mutate(data);
  };

  const onEditSubmit = (data: z.infer<typeof insertMaintenanceContactSchema>) => {
    if (editingContact) {
      updateContactMutation.mutate({ ...data, id: editingContact.id });
    }
  };

  const handleEditPropertyChange = (propertyId: string) => {
    const property = properties.find(p => p.id === propertyId);
    if (property) {
      editForm.setValue("buildingAddress", property.address!);
      editForm.setValue("region", property.region);
    }
  };

  const handleEditContact = (id: string) => {
    const contact = contactsData?.find((c) => c.id === id);
    if (contact) {
      setEditingContact(contact);
      editForm.reset({
        name: contact.name,
        company: contact.company,
        service: contact.service,
        phone: contact.phone,
        email: contact.email,
        region: contact.region,
        buildingAddress: contact.buildingAddress,
      });
      setIsEditDialogOpen(true);
    }
  };

  const invoiceForm = useForm<z.infer<typeof invoiceFormSchema>>({
    resolver: zodResolver(invoiceFormSchema),
    defaultValues: { companyName: "", email: "", phone: "", invoiceCost: "", region: "" },
  });

  const createBillingMutation = useMutation({
    mutationFn: async (payload: Record<string, unknown>) => {
      return await apiRequest("POST", "/api/billing", payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/billing"] });
      queryClient.invalidateQueries({ queryKey: ["/api/contacts"] });
      setIsAddInvoiceDialogOpen(false);
      invoiceForm.reset();
      setSelectedContactId("");
      setContactSource("existing");
      setContractInvoiceUrl(null); setContractInvoiceName(null);
      setCoiUrl(null); setCoiName(null);
      setW9Url(null); setW9Name(null);
      toast({ title: "Success", description: "Invoice record created successfully" });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to create invoice record", variant: "destructive" });
    },
  });

  const uploadDoc = async (
    file: File,
    setUrl: (u: string) => void,
    setName: (n: string) => void,
    setUploading: (b: boolean) => void
  ) => {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/upload-doc", { method: "POST", body: fd, credentials: "include" });
      if (!res.ok) throw new Error("Upload failed");
      const data = await res.json();
      setUrl(data.url);
      setName(file.name);
    } catch {
      toast({ title: "Error", description: "Failed to upload document", variant: "destructive" });
    } finally {
      setUploading(false);
    }
  };

  const onInvoiceSubmit = (data: z.infer<typeof invoiceFormSchema>) => {
    const payload: Record<string, unknown> = {
      companyName: data.companyName,
      email: data.email,
      phone: data.phone,
      invoiceCost: data.invoiceCost,
      region: data.region,
      contractInvoiceUrl: contractInvoiceUrl ?? undefined,
      coiUrl: coiUrl ?? undefined,
      w9Url: w9Url ?? undefined,
    };

    if (contactSource === "existing" && selectedContactId) {
      payload.contactId = selectedContactId;
    } else if (contactSource === "new") {
      payload.createContact = true;
    }

    createBillingMutation.mutate(payload);
  };

  const handleContactSelect = (contactId: string) => {
    setSelectedContactId(contactId);
    const contact = contactsData?.find(c => c.id === contactId);
    if (contact) {
      invoiceForm.setValue("companyName", contact.company || contact.name);
      invoiceForm.setValue("email", contact.email);
      invoiceForm.setValue("phone", contact.phone);
    }
  };

  const contacts = (contactsData || []).filter((contact) => {
    const matchesRegion = selectedRegion === "all" || contact.region === selectedRegion;
    const matchesBuilding = selectedBuilding === "all" || contact.buildingAddress === selectedBuilding;
    return matchesRegion && matchesBuilding;
  });

  const buildings = properties.map(p => ({ id: p.address!, address: p.address! }));


  return (
    <Section size="compact">
      <Container>
      <PageStack>
      <PageHeader title="Maint Contacts & Invoices" description="Keep vendor relationships and invoice records ready for the next repair." />

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

        <div className="flex flex-wrap gap-2">
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
                        <Select onValueChange={field.onChange} value={field.value}>
                          <FormControl>
                            <SelectTrigger data-testid="select-contact-region">
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
                        <FormLabel>Household Address</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value}>
                          <FormControl>
                            <SelectTrigger data-testid="select-contact-building">
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
                  <Button type="button" variant="secondary" onClick={() => setIsAddDialogOpen(false)}>
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

        <Dialog open={isAddInvoiceDialogOpen} onOpenChange={setIsAddInvoiceDialogOpen}>
          <DialogTrigger asChild>
            <Button data-testid="button-add-invoice" disabled={!canManage}>
              <Plus className="h-4 w-4 mr-2" />
              Add Invoice Record
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Add Invoice Record</DialogTitle>
            </DialogHeader>
            <Form {...invoiceForm}>
              <form onSubmit={invoiceForm.handleSubmit(onInvoiceSubmit)} className="space-y-5">
                {/* Contact source toggle */}
                <div>
                  <p className="text-sm font-medium mb-2">Contact</p>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant={contactSource === "existing" ? "default" : "outline"}
                      size="sm"
                      onClick={() => { setContactSource("existing"); setSelectedContactId(""); invoiceForm.reset(); }}
                      data-testid="button-contact-existing"
                    >
                      Select Existing
                    </Button>
                    <Button
                      type="button"
                      variant={contactSource === "new" ? "default" : "outline"}
                      size="sm"
                      onClick={() => { setContactSource("new"); setSelectedContactId(""); invoiceForm.reset(); }}
                      data-testid="button-contact-new"
                    >
                      New Contact
                    </Button>
                  </div>
                </div>

                {contactSource === "existing" && (
                  <FormItem>
                    <FormLabel>Select Contact</FormLabel>
                    <Select onValueChange={handleContactSelect} value={selectedContactId}>
                      <SelectTrigger data-testid="select-invoice-contact">
                        <SelectValue placeholder="Select a contact" />
                      </SelectTrigger>
                      <SelectContent>
                        {(contactsData || []).map(c => (
                          <SelectItem key={c.id} value={c.id}>
                            {c.company || c.name} — {c.email}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormItem>
                )}

                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={invoiceForm.control}
                    name="companyName"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Company Name</FormLabel>
                        <FormControl>
                          <Input {...field} data-testid="input-invoice-company" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={invoiceForm.control}
                    name="invoiceCost"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Invoice Cost ($)</FormLabel>
                        <FormControl>
                          <Input {...field} type="number" step="0.01" placeholder="0.00" data-testid="input-invoice-cost" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={invoiceForm.control}
                    name="email"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Email</FormLabel>
                        <FormControl>
                          <Input {...field} type="email" data-testid="input-invoice-email" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={invoiceForm.control}
                    name="phone"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Phone</FormLabel>
                        <FormControl>
                          <Input {...field} placeholder="(512) 555-0123" data-testid="input-invoice-phone" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <FormField
                  control={invoiceForm.control}
                  name="region"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Region</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger data-testid="select-invoice-region">
                            <SelectValue placeholder="Select region" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {REGIONS.map((region) => (
                            <SelectItem key={region} value={region}>
                              {region}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {/* Document Uploads */}
                <div className="space-y-3">
                  <p className="text-sm font-medium">Documents</p>

                  {/* Contract/Invoice */}
                  <div className="flex items-center justify-between p-3 border rounded-md">
                    <div className="flex items-center gap-3">
                      <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                      <div>
                        <p className="text-sm font-medium">Contract / Invoice</p>
                        {contractInvoiceName && <p className="text-xs text-muted-foreground truncate max-w-[180px]">{contractInvoiceName}</p>}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {contractInvoiceUrl && (
                        <Button type="button" size="icon" variant="ghost" onClick={() => { setContractInvoiceUrl(null); setContractInvoiceName(null); }}>
                          <X className="h-4 w-4" />
                        </Button>
                      )}
                      <label className="cursor-pointer">
                        <input
                          type="file"
                          accept=".pdf,.doc,.docx,.jpg,.jpeg,.png"
                          className="hidden"
                          data-testid="input-contract-file"
                          onChange={e => { const f = e.target.files?.[0]; if (f) uploadDoc(f, setContractInvoiceUrl, setContractInvoiceName, setUploadingContract); }}
                        />
                        {uploadingContract ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Button type="button" size="sm" variant="secondary" asChild>
                            <span><Upload className="h-3 w-3 mr-1" />{contractInvoiceUrl ? "Replace" : "Upload"}</span>
                          </Button>
                        )}
                      </label>
                    </div>
                  </div>

                  {/* COI */}
                  <div className="flex items-center justify-between p-3 border rounded-md">
                    <div className="flex items-center gap-3">
                      <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                      <div>
                        <p className="text-sm font-medium">COI</p>
                        {coiName && <p className="text-xs text-muted-foreground truncate max-w-[180px]">{coiName}</p>}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {coiUrl && (
                        <Button type="button" size="icon" variant="ghost" onClick={() => { setCoiUrl(null); setCoiName(null); }}>
                          <X className="h-4 w-4" />
                        </Button>
                      )}
                      <label className="cursor-pointer">
                        <input
                          type="file"
                          accept=".pdf,.doc,.docx,.jpg,.jpeg,.png"
                          className="hidden"
                          data-testid="input-coi-file"
                          onChange={e => { const f = e.target.files?.[0]; if (f) uploadDoc(f, setCoiUrl, setCoiName, setUploadingCoi); }}
                        />
                        {uploadingCoi ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                            <Button type="button" size="sm" variant="secondary" asChild>
                            <span><Upload className="h-3 w-3 mr-1" />{coiUrl ? "Replace" : "Upload"}</span>
                          </Button>
                        )}
                      </label>
                    </div>
                  </div>

                  {/* W-9 */}
                  <div className="flex items-center justify-between p-3 border rounded-md">
                    <div className="flex items-center gap-3">
                      <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                      <div>
                        <p className="text-sm font-medium">W-9</p>
                        {w9Name && <p className="text-xs text-muted-foreground truncate max-w-[180px]">{w9Name}</p>}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {w9Url && (
                        <Button type="button" size="icon" variant="ghost" onClick={() => { setW9Url(null); setW9Name(null); }}>
                          <X className="h-4 w-4" />
                        </Button>
                      )}
                      <label className="cursor-pointer">
                        <input
                          type="file"
                          accept=".pdf,.doc,.docx,.jpg,.jpeg,.png"
                          className="hidden"
                          data-testid="input-w9-file"
                          onChange={e => { const f = e.target.files?.[0]; if (f) uploadDoc(f, setW9Url, setW9Name, setUploadingW9); }}
                        />
                        {uploadingW9 ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Button type="button" size="sm" variant="secondary" asChild>
                            <span><Upload className="h-3 w-3 mr-1" />{w9Url ? "Replace" : "Upload"}</span>
                          </Button>
                        )}
                      </label>
                    </div>
                  </div>
                </div>

                <DialogFooter>
                  <Button type="button" variant="secondary" onClick={() => setIsAddInvoiceDialogOpen(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={createBillingMutation.isPending || uploadingContract || uploadingCoi || uploadingW9} data-testid="button-submit-invoice">
                    {createBillingMutation.isPending ? "Creating..." : "Create Record"}
                  </Button>
                </DialogFooter>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
        </div>
      </div>

      {isLoading ? (
        <LoadingState message="Loading contacts..." />
      ) : (
        <ContactsInvoices
          contacts={contacts}
          invoices={billingRecords}
          onAddContact={() => setIsAddDialogOpen(true)}
          onEditContact={handleEditContact}
          onAddInvoice={() => console.log("Add invoice")}
          onViewInvoice={(id) => console.log("View invoice:", id)}
        />
      )}

      {/* Edit Contact Dialog */}
      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit Contact</DialogTitle>
          </DialogHeader>
          <Form {...editForm}>
            <form onSubmit={editForm.handleSubmit(onEditSubmit)} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={editForm.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Contact Name</FormLabel>
                      <FormControl>
                        <Input {...field} data-testid="input-edit-contact-name" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={editForm.control}
                  name="company"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Company</FormLabel>
                      <FormControl>
                        <Input {...field} data-testid="input-edit-contact-company" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={editForm.control}
                name="service"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Service/Specialty</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder="Plumbing, HVAC, Electrical, etc." data-testid="input-edit-contact-service" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={editForm.control}
                  name="phone"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Phone</FormLabel>
                      <FormControl>
                        <Input {...field} placeholder="(512) 555-0123" data-testid="input-edit-contact-phone" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={editForm.control}
                  name="email"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Email</FormLabel>
                      <FormControl>
                        <Input {...field} type="email" data-testid="input-edit-contact-email" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormItem>
                <FormLabel>Property</FormLabel>
                <Select
                  onValueChange={handleEditPropertyChange}
                  defaultValue={
                    properties.find(p => p.address === editingContact?.buildingAddress)?.id
                  }
                >
                  <SelectTrigger data-testid="select-edit-contact-property">
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
                  control={editForm.control}
                  name="region"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Region</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger data-testid="select-edit-contact-region">
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
                  control={editForm.control}
                  name="buildingAddress"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Household Address</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger data-testid="select-edit-contact-building">
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
                <Button type="button" variant="secondary" onClick={() => setIsEditDialogOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={updateContactMutation.isPending} data-testid="button-update-contact">
                  {updateContactMutation.isPending ? "Updating..." : "Update Contact"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
      </PageStack>
      </Container>
    </Section>
  );
}
