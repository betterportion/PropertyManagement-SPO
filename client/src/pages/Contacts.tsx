import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { serverMessage } from "@/lib/serverMessage";
import ContactsInvoices from "@/components/ContactsInvoices";
import RegionSelector from "@/components/RegionSelector";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Plus, Upload, FileText, X, Loader2, MapPin } from "lucide-react";
import { useForm, useWatch, type UseFormReturn } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { insertMaintenanceContactSchema, type MaintenanceContact, type Property, type BillingRecord } from "@shared/schema";
import { REGIONS } from "@shared/regions";
import { z } from "zod";
import { Section, Container, PageHeader, PageStack } from "@/components/layout/page";
import { LoadingState } from "@/components/states";
import { cityLabel, citiesWithHouses } from "@/lib/contactCities";


const invoiceFormSchema = z.object({
  companyName: z.string().min(1, "Company name is required"),
  email: z.string().min(1, "Email is required").email("Valid email required"),
  phone: z.string().min(1, "Phone is required"),
  invoiceCost: z.string().min(1, "Invoice cost is required"),
  // Billing records are scoped by region on the server. Without a region a
  // record would be saved but then hidden from everyone except an admin, so
  // the field is required here rather than left to a silent default.
  region: z.string().min(1, "Region is required"),
  // The house the invoice is for, from the chosen region's houses. The server
  // takes the record's region from it.
  buildingAddress: z.string().min(1, "Which house is this invoice for?"),
});

// The form asks for at least one city; the API accepts a contact without, as
// one made from an invoice record is.
const contactFormSchema = insertMaintenanceContactSchema.extend({
  serviceCities: z.array(z.string()).min(1, "Pick at least one city this contact serves."),
});
type ContactForm = z.infer<typeof contactFormSchema>;

/**
 * "City servicing": a checkbox per city SPO has houses in for the contact's
 * region. A city the contact already holds stays listed even if no house is
 * there any more, so an edit never drops it silently.
 */
function CityServicingField({ form, houses, testId }: { form: UseFormReturn<ContactForm>; houses: Property[]; testId: string }) {
  const region = useWatch({ control: form.control, name: "region" });
  const chosen = useWatch({ control: form.control, name: "serviceCities" }) ?? [];
  const offered = Array.from(new Set([...(region ? citiesWithHouses(houses, region) : []), ...chosen]));
  return (
    <FormField
      control={form.control}
      name="serviceCities"
      render={({ field }) => (
        <FormItem>
          <FormLabel>City servicing</FormLabel>
          {!region ? (
            <p className="text-sm text-muted-foreground">Pick a region first.</p>
          ) : offered.length === 0 ? (
            <p className="text-sm text-muted-foreground">SPO has no houses in this region yet.</p>
          ) : (
            <div className="grid gap-2 rounded-md border p-3 sm:grid-cols-2" data-testid={testId}>
              {offered.map((city) => (
                <label key={city} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={field.value?.includes(city) ?? false}
                    onCheckedChange={(checked) =>
                      field.onChange(checked ? [...(field.value ?? []), city] : (field.value ?? []).filter((c) => c !== city))
                    }
                    data-testid={`${testId}-${city}`}
                  />
                  {city}
                </label>
              ))}
            </div>
          )}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

export default function Contacts() {
  const [selectedRegion, setSelectedRegion] = useState("all");
  const [selectedCity, setSelectedCity] = useState("all");
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [isAddInvoiceDialogOpen, setIsAddInvoiceDialogOpen] = useState(false);
  const [editingContact, setEditingContact] = useState<MaintenanceContact | null>(null);
  const [editingInvoice, setEditingInvoice] = useState<BillingRecord | null>(null);
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
    mutationFn: async (data: ContactForm) => {
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
    onError: (error) => {
      toast({
        title: "Error",
        description: serverMessage(error) ?? "Failed to create contact",
        variant: "destructive",
      });
    },
  });

  const form = useForm<ContactForm>({
    resolver: zodResolver(contactFormSchema),
    defaultValues: {
      name: "",
      company: "",
      service: "",
      phone: "",
      email: "",
      region: "",
      buildingAddress: "",
      serviceCities: [],
    },
  });

  const editForm = useForm<ContactForm>({
    resolver: zodResolver(contactFormSchema),
  });

  const updateContactMutation = useMutation({
    mutationFn: async (data: ContactForm & { id: string }) => {
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
    onError: (error) => {
      toast({
        title: "Error",
        description: serverMessage(error) ?? "Failed to update contact",
        variant: "destructive",
      });
    },
  });

  const onSubmit = (data: ContactForm) => {
    createContactMutation.mutate(data);
  };

  const onEditSubmit = (data: ContactForm) => {
    if (editingContact) {
      updateContactMutation.mutate({ ...data, id: editingContact.id });
    }
  };

  // A new region offers other cities, so the ones picked for the old region go.
  const changeContactRegion = (target: UseFormReturn<ContactForm>, region: string) => {
    target.setValue("region", region);
    const offered = citiesWithHouses(properties, region);
    target.setValue("serviceCities", (target.getValues("serviceCities") ?? []).filter((city) => offered.includes(city)));
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
        serviceCities: contact.serviceCities ?? [],
      });
      setIsEditDialogOpen(true);
    }
  };

  const invoiceForm = useForm<z.infer<typeof invoiceFormSchema>>({
    resolver: zodResolver(invoiceFormSchema),
    defaultValues: { companyName: "", email: "", phone: "", invoiceCost: "", region: "", buildingAddress: "" },
  });
  const invoiceRegion = useWatch({ control: invoiceForm.control, name: "region" });
  const invoiceHouses = properties.filter((p) => p.region === invoiceRegion);

  const clearInvoiceDocuments = () => {
    setContractInvoiceUrl(null); setContractInvoiceName(null);
    setCoiUrl(null); setCoiName(null);
    setW9Url(null); setW9Name(null);
  };

  // Closing an edit clears it, so Add Invoice Record opens blank. Closing an
  // unsaved new record keeps what was typed, as it always has.
  const setInvoiceDialogOpen = (open: boolean) => {
    setIsAddInvoiceDialogOpen(open);
    if (!open && editingInvoice) {
      setEditingInvoice(null);
      invoiceForm.reset({ companyName: "", email: "", phone: "", invoiceCost: "", region: "", buildingAddress: "" });
      clearInvoiceDocuments();
    }
  };

  const handleEditInvoice = (id: string) => {
    const record = billingRecords.find((r) => r.id === id);
    if (!record) return;
    setEditingInvoice(record);
    invoiceForm.reset({
      companyName: record.companyName,
      email: record.email,
      phone: record.phone,
      invoiceCost: String(record.invoiceCost),
      region: record.region,
      buildingAddress: record.buildingAddress ?? "",
    });
    setContractInvoiceUrl(record.contractInvoiceUrl); setContractInvoiceName(record.contractInvoiceUrl ? "On file" : null);
    setCoiUrl(record.coiUrl); setCoiName(record.coiUrl ? "On file" : null);
    setW9Url(record.w9Url); setW9Name(record.w9Url ? "On file" : null);
    setIsAddInvoiceDialogOpen(true);
  };

  const updateBillingMutation = useMutation({
    mutationFn: async ({ id, ...payload }: Record<string, unknown> & { id: string }) => {
      return await apiRequest("PATCH", `/api/billing/${id}`, payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/billing"] });
      setInvoiceDialogOpen(false);
      toast({ title: "Success", description: "Invoice record updated" });
    },
    onError: (error) => {
      toast({ title: "Error", description: serverMessage(error) ?? "Failed to update invoice record", variant: "destructive" });
    },
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
      clearInvoiceDocuments();
      toast({ title: "Success", description: "Invoice record created successfully" });
    },
    onError: (error) => {
      toast({ title: "Error", description: serverMessage(error) ?? "Failed to create invoice record", variant: "destructive" });
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
      // The "<status>: <body>" shape apiRequest throws, so serverMessage can
      // read the route's reason (the size limit, a refused file type).
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      const data = await res.json();
      setUrl(data.url);
      setName(file.name);
    } catch (error) {
      toast({ title: "Error", description: serverMessage(error) ?? "Failed to upload document", variant: "destructive" });
    } finally {
      setUploading(false);
    }
  };

  const onInvoiceSubmit = (data: z.infer<typeof invoiceFormSchema>) => {
    if (editingInvoice) {
      // null clears a document; the server then removes the file.
      updateBillingMutation.mutate({
        id: editingInvoice.id,
        ...data,
        contractInvoiceUrl,
        coiUrl,
        w9Url,
      });
      return;
    }
    const payload: Record<string, unknown> = {
      companyName: data.companyName,
      email: data.email,
      phone: data.phone,
      invoiceCost: data.invoiceCost,
      region: data.region,
      buildingAddress: data.buildingAddress,
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
      // A default, not a lock: a vendor can bill for work in another region.
      changeInvoiceRegion(contact.region);
    }
  };

  // The house list follows the region, so a house from the old one is cleared.
  const changeInvoiceRegion = (region: string) => {
    if (region !== invoiceForm.getValues("region")) invoiceForm.setValue("buildingAddress", "");
    invoiceForm.setValue("region", region);
  };

  // Both filters apply to both tabs. An invoice's city is its house's; one
  // with no house yet drops out once a city is chosen.
  const contacts = (contactsData || []).filter((contact) => {
    const matchesRegion = selectedRegion === "all" || contact.region === selectedRegion;
    const matchesCity = selectedCity === "all" || (contact.serviceCities ?? []).includes(selectedCity);
    return matchesRegion && matchesCity;
  });
  const invoices = billingRecords.filter((record) => {
    const matchesRegion = selectedRegion === "all" || record.region === selectedRegion;
    const house = properties.find((p) => p.address === record.buildingAddress);
    const matchesCity = selectedCity === "all" || (!!house && cityLabel(house) === selectedCity);
    return matchesRegion && matchesCity;
  });
  const filterCities = citiesWithHouses(properties, selectedRegion);


  return (
    <Section size="compact">
      <Container>
      <PageStack>
      <PageHeader title="Maintenance Contacts & Invoices" description="Keep vendor relationships and invoice records ready for the next repair." />

      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap gap-4">
          <RegionSelector
            selectedRegion={selectedRegion}
            onRegionChange={(region) => { setSelectedRegion(region); setSelectedCity("all"); }}
          />
          <Select value={selectedCity} onValueChange={setSelectedCity}>
            <SelectTrigger className="w-full min-w-56 sm:w-64" data-testid="select-filter-city" aria-label="Filter by city">
              <div className="flex items-center gap-2">
                <MapPin className="h-4 w-4" />
                <SelectValue />
              </div>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All cities</SelectItem>
              {filterCities.map((city) => (
                <SelectItem key={city} value={city}>{city}</SelectItem>
              ))}
            </SelectContent>
          </Select>
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

                <FormField
                    control={form.control}
                    name="region"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Region</FormLabel>
                        <Select onValueChange={(region) => changeContactRegion(form, region)} value={field.value}>
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
                <CityServicingField form={form} houses={properties} testId="checkboxes-contact-cities" />

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

        <Dialog open={isAddInvoiceDialogOpen} onOpenChange={setInvoiceDialogOpen}>
          {/* Maintenance staff never enter invoices: an admin does. */}
          <DialogTrigger asChild className={userRole === "maintenance" ? "hidden" : undefined}>
            <Button data-testid="button-add-invoice" disabled={!canManage}>
              <Plus className="h-4 w-4 mr-2" />
              Add Invoice Record
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{editingInvoice ? "Edit Invoice Record" : "Add Invoice Record"}</DialogTitle>
            </DialogHeader>
            <Form {...invoiceForm}>
              <form onSubmit={invoiceForm.handleSubmit(onInvoiceSubmit)} className="space-y-5">
                {/* Contact source toggle */}
                {!editingInvoice && (<>
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
                </>)}

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

                <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={invoiceForm.control}
                  name="region"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Region</FormLabel>
                      <Select onValueChange={changeInvoiceRegion} value={field.value}>
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
                <FormField
                  control={invoiceForm.control}
                  name="buildingAddress"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>House</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value} disabled={!invoiceRegion}>
                        <FormControl>
                          <SelectTrigger data-testid="select-invoice-house">
                            <SelectValue placeholder={invoiceRegion ? "Select a house" : "Pick a region first"} />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {invoiceHouses.map((house) => (
                            <SelectItem key={house.id} value={house.address!}>
                              {house.name} · {house.address}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                </div>

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
                  <Button type="button" variant="secondary" onClick={() => setInvoiceDialogOpen(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={createBillingMutation.isPending || updateBillingMutation.isPending || uploadingContract || uploadingCoi || uploadingW9} data-testid="button-submit-invoice">
                    {editingInvoice
                      ? (updateBillingMutation.isPending ? "Saving..." : "Save Changes")
                      : (createBillingMutation.isPending ? "Creating..." : "Create Record")}
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
          invoices={invoices}
          houses={properties}
          onEditContact={handleEditContact}
          onEditInvoice={handleEditInvoice}
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

              <FormField
                control={editForm.control}
                name="region"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Region</FormLabel>
                    <Select onValueChange={(region) => changeContactRegion(editForm, region)} value={field.value}>
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

              <CityServicingField form={editForm} houses={properties} testId="checkboxes-edit-contact-cities" />

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
