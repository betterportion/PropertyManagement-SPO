import { useState } from "react";
import { Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Building2, MapPin, MoreVertical } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { type Property } from "@shared/schema";
import { REGIONS, chaptersForRegion, ALL_CHAPTERS } from "@shared/regions";
import PropertyLeaseFields, { propertyFormSchema, type PropertyForm } from "@/components/PropertyLeaseFields";
import { Section, Container, PageHeader, PageStack } from "@/components/layout/page";
import { LoadingState, EmptyState } from "@/components/states";
import { formatDate } from "@/lib/format";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";


export default function Properties() {
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [editingProperty, setEditingProperty] = useState<Property | null>(null);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [deletingPropertyId, setDeletingPropertyId] = useState<string | null>(null);
  const [regionFilter, setRegionFilter] = useState("all");
  const [chapterFilter, setChapterFilter] = useState("all");
  const { toast } = useToast();

  const { data: properties, isLoading } = useQuery<Property[]>({
    queryKey: ["/api/properties"],
  });

  // The chapter filter offers the official chapters (every one when no region is
  // picked, or just the chosen region's), so the full catalogue is visible even
  // for chapters no property uses yet.
  const chapters = regionFilter === "all" ? ALL_CHAPTERS : chaptersForRegion(regionFilter);

  const visibleProperties = (properties || []).filter(
    (p) =>
      (regionFilter === "all" || p.region === regionFilter) &&
      (chapterFilter === "all" || p.chapter === chapterFilter),
  );

  // Empty date inputs come through as "" — send null so the server's date
  // coercion treats them as unset rather than an invalid date.
  const normalizeLease = (data: PropertyForm) => ({
    ...data,
    leaseStartDate: data.leaseStartDate || null,
    leaseEndDate: data.leaseEndDate || null,
    leaseRenewalDate: data.leaseRenewalDate || null,
  });

  const createPropertyMutation = useMutation({
    mutationFn: async (data: PropertyForm) => {
      return await apiRequest("POST", "/api/properties", normalizeLease(data));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/properties"] });
      setIsAddDialogOpen(false);
      addForm.reset();
      toast({
        title: "Success",
        description: "Property created successfully",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to create property",
        variant: "destructive",
      });
    },
  });

  const updatePropertyMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: PropertyForm }) => {
      return await apiRequest("PATCH", `/api/properties/${id}`, normalizeLease(data));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/properties"] });
      setIsEditDialogOpen(false);
      setEditingProperty(null);
      toast({
        title: "Success",
        description: "Property updated successfully",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to update property",
        variant: "destructive",
      });
    },
  });

  const deletePropertyMutation = useMutation({
    mutationFn: async (id: string) => {
      return await apiRequest("DELETE", `/api/properties/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/properties"] });
      setDeletingPropertyId(null);
      toast({
        title: "Success",
        description: "Property deleted successfully",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to delete property",
        variant: "destructive",
      });
    },
  });

  const addForm = useForm<PropertyForm>({
    resolver: zodResolver(propertyFormSchema),
    defaultValues: {
      name: "",
      streetAddress: "",
      city: "",
      state: "",
      zipCode: "",
      region: "",
      chapter: "",
      propertyManager: "",
      bedrooms: undefined,
      bathrooms: undefined,
      squareFootage: undefined,
      ownership: "owned",
      leaseStartDate: "",
      leaseEndDate: "",
      leaseRenewalDate: "",
      renewalDecision: "undecided",
    },
  });

  const editForm = useForm<PropertyForm>({
    resolver: zodResolver(propertyFormSchema),
  });

  // A stored timestamp for a date input needs to be "YYYY-MM-DD".
  const asDateInput = (value: Date | string | null | undefined) =>
    value ? new Date(value).toISOString().slice(0, 10) : "";

  const handleEdit = (property: Property) => {
    setEditingProperty(property);
    editForm.reset({
      name: property.name,
      streetAddress: property.streetAddress,
      city: property.city,
      state: property.state,
      zipCode: property.zipCode,
      region: property.region,
      chapter: property.chapter || "",
      propertyManager: property.propertyManager || "",
      bedrooms: property.bedrooms || undefined,
      bathrooms: property.bathrooms || undefined,
      squareFootage: property.squareFootage || undefined,
      ownership: property.ownership,
      leaseStartDate: asDateInput(property.leaseStartDate),
      leaseEndDate: asDateInput(property.leaseEndDate),
      leaseRenewalDate: asDateInput(property.leaseRenewalDate),
      renewalDecision: property.renewalDecision,
    });
    setIsEditDialogOpen(true);
  };

  const onSubmitAdd = (data: PropertyForm) => {
    createPropertyMutation.mutate(data);
  };

  const onSubmitEdit = (data: PropertyForm) => {
    if (editingProperty) {
      updatePropertyMutation.mutate({ id: editingProperty.id, data });
    }
  };

  return (
    <Section size="compact">
      <Container>
      <PageStack>
      <PageHeader title="Properties" description="Maintain the homes and locations that anchor your operations." />

      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <Select value={regionFilter} onValueChange={(v) => { setRegionFilter(v); setChapterFilter("all"); }}>
            <SelectTrigger className="w-44" data-testid="select-filter-region" aria-label="Filter by region">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All regions</SelectItem>
              {REGIONS.map((region) => (
                <SelectItem key={region} value={region}>{region}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={chapterFilter} onValueChange={setChapterFilter}>
            <SelectTrigger className="w-44" data-testid="select-filter-chapter" aria-label="Filter by chapter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All chapters</SelectItem>
              {chapters.map((chapter) => (
                <SelectItem key={chapter} value={chapter}>{chapter}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
          <DialogTrigger asChild>
            <Button data-testid="button-add-property">
              <Plus className="h-4 w-4 mr-2" />
              Add Property
            </Button>
          </DialogTrigger>
          <DialogContent className="max-h-[85vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Add New Property</DialogTitle>
            </DialogHeader>
            <Form {...addForm}>
              <form onSubmit={addForm.handleSubmit(onSubmitAdd)} className="space-y-4">
                <FormField
                  control={addForm.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Property Name</FormLabel>
                      <FormControl>
                        <Input {...field} placeholder="Building A, Riverside Apartments, etc." data-testid="input-property-name" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={addForm.control}
                  name="streetAddress"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Street Address</FormLabel>
                      <FormControl>
                        <Input {...field} placeholder="123 Main St" data-testid="input-property-street-address" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <div className="grid grid-cols-3 gap-4">
                  <FormField
                    control={addForm.control}
                    name="city"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>City</FormLabel>
                        <FormControl>
                          <Input {...field} placeholder="Austin" data-testid="input-property-city" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={addForm.control}
                    name="state"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>State</FormLabel>
                        <FormControl>
                          <Input {...field} placeholder="TX" data-testid="input-property-state" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={addForm.control}
                    name="zipCode"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Zip Code</FormLabel>
                        <FormControl>
                          <Input {...field} placeholder="78701" data-testid="input-property-zip" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <FormField
                  control={addForm.control}
                  name="region"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Region</FormLabel>
                      <Select onValueChange={(v) => { field.onChange(v); addForm.setValue("chapter", ""); }} value={field.value}>
                        <FormControl>
                          <SelectTrigger data-testid="select-property-region">
                            <SelectValue placeholder="Select a region" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {REGIONS.map((region) => (
                            <SelectItem key={region} value={region}>{region}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={addForm.control}
                  name="chapter"
                  render={({ field }) => {
                    const regionChapters = chaptersForRegion(addForm.watch("region"));
                    return (
                      <FormItem>
                        <FormLabel>Chapter (Optional)</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value || ""} disabled={regionChapters.length === 0}>
                          <FormControl>
                            <SelectTrigger data-testid="select-property-chapter">
                              <SelectValue placeholder={regionChapters.length === 0 ? "Pick a region first" : "Select a chapter"} />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {regionChapters.map((c) => (
                              <SelectItem key={c} value={c}>{c}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    );
                  }}
                />

                <FormField
                  control={addForm.control}
                  name="propertyManager"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Property Manager (Optional)</FormLabel>
                      <FormControl>
                        <Input {...field} value={field.value || ""} data-testid="input-property-manager" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={addForm.control}
                    name="bedrooms"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Bedrooms (Optional)</FormLabel>
                        <FormControl>
                          <Input type="number" {...field} value={field.value ?? ""} onChange={e => field.onChange(e.target.value ? parseInt(e.target.value) : undefined)} data-testid="input-property-bedrooms" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={addForm.control}
                    name="bathrooms"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Bathrooms (Optional)</FormLabel>
                        <FormControl>
                          <Input type="number" step="0.5" {...field} value={field.value ?? ""} onChange={e => field.onChange(e.target.value || undefined)} data-testid="input-property-bathrooms" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <FormField
                  control={addForm.control}
                  name="squareFootage"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Square Footage (Optional)</FormLabel>
                      <FormControl>
                        <Input type="number" {...field} value={field.value ?? ""} onChange={e => field.onChange(e.target.value ? parseInt(e.target.value) : undefined)} placeholder="e.g. 1200" data-testid="input-property-sqft" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <PropertyLeaseFields form={addForm} />

                <DialogFooter>
                  <Button type="button" variant="secondary" onClick={() => setIsAddDialogOpen(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={createPropertyMutation.isPending} data-testid="button-submit-property">
                    {createPropertyMutation.isPending ? "Creating..." : "Create Property"}
                  </Button>
                </DialogFooter>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      </div>

      {isLoading ? (
        <LoadingState message="Loading properties..." />
      ) : properties && properties.length === 0 ? (
        <EmptyState title="Your property directory is ready for its first home" description="Add a property to start connecting rooms, assets, contacts, and walkthroughs." />
      ) : visibleProperties.length === 0 ? (
        <EmptyState title="No properties in that region or chapter" description="Every property is filtered out right now — pick a different region or chapter, or set both back to All." />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {visibleProperties.map((property) => (
            <Card key={property.id} className="hover-elevate" data-testid={`card-property-${property.id}`}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-start gap-3 flex-1">
                    <div className="p-2 bg-muted rounded-md">
                      <Building2 className="h-5 w-5" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <h4 className="font-medium text-sm">
                        {/* The name is the link, not the whole card -- the card
                            already holds an actions menu, and nesting a button
                            inside a link is neither valid nor keyboard-sane. */}
                        <Link
                          href={`/properties/${property.id}`}
                          className="rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          data-testid={`text-property-name-${property.id}`}
                        >
                          {property.name}
                        </Link>
                      </h4>
                      <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
                        <MapPin className="h-3 w-3" />
                        {property.address}
                      </p>
                      <div className="flex items-center gap-2 mt-2 flex-wrap">
                        <Badge variant="secondary">{property.region}</Badge>
                        {property.chapter && (
                          <Badge variant="secondary" data-testid={`badge-property-chapter-${property.id}`}>{property.chapter}</Badge>
                        )}
                        {(property.bedrooms || property.bathrooms) && (
                          <Badge variant="secondary">
                            {property.bedrooms ? `${property.bedrooms} bed` : ''}{property.bedrooms && property.bathrooms ? ', ' : ''}{property.bathrooms ? `${property.bathrooms} bath` : ''}
                          </Badge>
                        )}
                        {property.squareFootage && (
                          <Badge variant="secondary">{property.squareFootage.toLocaleString()} sq ft</Badge>
                        )}
                        {property.ownership === "rented" && (
                          <Badge variant="warning" data-testid={`badge-property-rented-${property.id}`}>Rented</Badge>
                        )}
                      </div>
                      {property.propertyManager && (
                        <p className="text-xs text-muted-foreground mt-2">
                          Manager: {property.propertyManager}
                        </p>
                      )}
                      {property.ownership === "rented" && property.leaseRenewalDate && (
                        <p className="text-xs text-muted-foreground mt-2" data-testid={`text-property-renewal-${property.id}`}>
                          Lease renewal: {formatDate(property.leaseRenewalDate)}
                          {property.renewalDecision !== "undecided" &&
                            ` · ${property.renewalDecision === "renewing" ? "Renewing" : "Not renewing"}`}
                        </p>
                      )}
                    </div>
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="icon" variant="ghost" data-testid={`button-menu-${property.id}`} aria-label={`Actions for ${property.name}`}>
                        <MoreVertical className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => handleEdit(property)}>
                        Edit
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setDeletingPropertyId(property.id)} className="text-destructive">
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Property</DialogTitle>
          </DialogHeader>
          <Form {...editForm}>
            <form onSubmit={editForm.handleSubmit(onSubmitEdit)} className="space-y-4">
              <FormField
                control={editForm.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Property Name</FormLabel>
                    <FormControl>
                      <Input {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={editForm.control}
                name="streetAddress"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Street Address</FormLabel>
                    <FormControl>
                      <Input {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="grid grid-cols-3 gap-4">
                <FormField
                  control={editForm.control}
                  name="city"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>City</FormLabel>
                      <FormControl>
                        <Input {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={editForm.control}
                  name="state"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>State</FormLabel>
                      <FormControl>
                        <Input {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={editForm.control}
                  name="zipCode"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Zip Code</FormLabel>
                      <FormControl>
                        <Input {...field} />
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
                    <Select onValueChange={(v) => { field.onChange(v); editForm.setValue("chapter", ""); }} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select a region" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {REGIONS.map((region) => (
                          <SelectItem key={region} value={region}>{region}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={editForm.control}
                name="chapter"
                render={({ field }) => {
                  const regionChapters = chaptersForRegion(editForm.watch("region"));
                  return (
                    <FormItem>
                      <FormLabel>Chapter (Optional)</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value || ""} disabled={regionChapters.length === 0}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder={regionChapters.length === 0 ? "Pick a region first" : "Select a chapter"} />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {regionChapters.map((c) => (
                            <SelectItem key={c} value={c}>{c}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  );
                }}
              />

              <FormField
                control={editForm.control}
                name="propertyManager"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Property Manager (Optional)</FormLabel>
                    <FormControl>
                      <Input {...field} value={field.value || ""} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={editForm.control}
                  name="bedrooms"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Bedrooms (Optional)</FormLabel>
                      <FormControl>
                        <Input type="number" {...field} value={field.value ?? ""} onChange={e => field.onChange(e.target.value ? parseInt(e.target.value) : undefined)} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={editForm.control}
                  name="bathrooms"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Bathrooms (Optional)</FormLabel>
                      <FormControl>
                        <Input type="number" step="0.5" {...field} value={field.value ?? ""} onChange={e => field.onChange(e.target.value || undefined)} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={editForm.control}
                name="squareFootage"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Square Footage (Optional)</FormLabel>
                    <FormControl>
                      <Input type="number" {...field} value={field.value ?? ""} onChange={e => field.onChange(e.target.value ? parseInt(e.target.value) : undefined)} placeholder="e.g. 1200" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <PropertyLeaseFields form={editForm} />

              <DialogFooter>
                <Button type="button" variant="secondary" onClick={() => setIsEditDialogOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={updatePropertyMutation.isPending}>
                  {updatePropertyMutation.isPending ? "Updating..." : "Update Property"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deletingPropertyId} onOpenChange={() => setDeletingPropertyId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Property</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this property? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deletingPropertyId && deletePropertyMutation.mutate(deletingPropertyId)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      </PageStack>
      </Container>
    </Section>
  );
}
