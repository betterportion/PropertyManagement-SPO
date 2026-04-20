import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import AssetTracker from "@/components/AssetTracker";
import RegionSelector from "@/components/RegionSelector";
import BuildingSelector from "@/components/BuildingSelector";
import { PhotoUpload } from "@/components/PhotoUpload";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Plus, Trash2, Image } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { insertAssetSchema, type Asset, type Property, type AssetPhoto } from "@shared/schema";
import { z } from "zod";

const ASSET_CATEGORIES = [
  "Appliances - Large",
  "Appliances - Small",
  "Artwork",
  "A/V Equipment",
  "Computer - Accessories",
  "Computer - Desktop",
  "Computer - Laptop",
  "Computer - Monitor",
  "Furniture - Household",
  "Furniture - Office",
  "HVAC",
  "Internet Equipment",
  "Musical Instruments",
  "Office Equipment",
  "Office Supplies",
  "Outdoor Equipment",
  "Printers",
  "Roof",
  "Tablets",
  "Tools",
  "Water Heater",
];

const assetFormSchema = insertAssetSchema.extend({
  ageInYears: z.coerce.number().min(0, "Age must be 0 or greater"),
  purchasePrice: z.coerce.number({ required_error: "Purchase price is required", invalid_type_error: "Enter a valid amount" }).min(0, "Must be 0 or greater"),
  assetTagId: z.string().optional(),
});

export default function Assets() {
  const [selectedRegion, setSelectedRegion] = useState("all");
  const [selectedBuilding, setSelectedBuilding] = useState("all");
  const [editingAsset, setEditingAsset] = useState<Asset | null>(null);
  const [deletingAssetId, setDeletingAssetId] = useState<string | null>(null);
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [isPhotosDialogOpen, setIsPhotosDialogOpen] = useState(false);
  const [selectedAssetForPhotos, setSelectedAssetForPhotos] = useState<Asset | null>(null);
  const [addPhotoUrl, setAddPhotoUrl] = useState<string | null>(null);
  const { toast } = useToast();
  const { user } = useAuth();
  const typedUser = user as { id?: string; email?: string; role?: string } | null;

  const { data: assetsData, isLoading } = useQuery<Asset[]>({
    queryKey: ["/api/assets"],
  });

  const { data: properties = [] } = useQuery<Property[]>({
    queryKey: ["/api/properties"],
  });

  const { data: permissionsData } = useQuery<{ canManageAssets?: boolean } | null>({
    queryKey: ["/api/users", typedUser?.id, "/permissions"],
    queryFn: async () => {
      if (!typedUser?.id) return null;
      const response = await fetch(`/api/users/${typedUser.id}/permissions`);
      if (!response.ok) return null;
      return response.json();
    },
    enabled: !!typedUser?.id,
  });

  const canManage =
    typedUser?.role === "admin" ||
    typedUser?.role === "regional_administrator" ||
    permissionsData?.canManageAssets ||
    false;

  const createAssetMutation = useMutation({
    mutationFn: async (data: z.infer<typeof assetFormSchema>) => {
      const response = await apiRequest("POST", "/api/assets", data);
      return response.json() as Promise<Asset>;
    },
  });

  const createAssetPhotoMutation = useMutation({
    mutationFn: async (data: { assetId: string; imageUrl: string; uploadedBy: string }) => {
      return await apiRequest("POST", "/api/asset-photos", data);
    },
  });

  const updateAssetMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<z.infer<typeof assetFormSchema>> }) => {
      return await apiRequest("PATCH", `/api/assets/${id}`, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/assets"] });
      setIsEditDialogOpen(false);
      setEditingAsset(null);
      toast({ title: "Asset updated successfully" });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to update asset", variant: "destructive" });
    },
  });

  const deleteAssetMutation = useMutation({
    mutationFn: async (id: string) => {
      return await apiRequest("DELETE", `/api/assets/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/assets"] });
      setDeletingAssetId(null);
      toast({ title: "Asset deleted successfully" });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to delete asset", variant: "destructive" });
    },
  });

  const { data: assetPhotos = [], refetch: refetchPhotos } = useQuery<AssetPhoto[]>({
    queryKey: ["/api/asset-photos/asset", selectedAssetForPhotos?.id],
    queryFn: async () => {
      if (!selectedAssetForPhotos?.id) return [];
      const response = await fetch(`/api/asset-photos/asset/${selectedAssetForPhotos.id}`, { credentials: "include" });
      if (!response.ok) return [];
      return response.json();
    },
    enabled: !!selectedAssetForPhotos?.id,
  });

  const addPhotoToAssetMutation = useMutation({
    mutationFn: async (data: { assetId: string; imageUrl: string; caption?: string; uploadedBy: string }) => {
      return await apiRequest("POST", "/api/asset-photos", data);
    },
    onSuccess: () => {
      refetchPhotos();
      toast({ title: "Photo uploaded successfully" });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to upload photo", variant: "destructive" });
    },
  });

  const deleteAssetPhotoMutation = useMutation({
    mutationFn: async (id: string) => {
      return await apiRequest("DELETE", `/api/asset-photos/${id}`);
    },
    onSuccess: () => {
      refetchPhotos();
      toast({ title: "Photo deleted successfully" });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to delete photo", variant: "destructive" });
    },
  });

  const addForm = useForm<z.infer<typeof assetFormSchema>>({
    resolver: zodResolver(assetFormSchema),
    defaultValues: {
      name: "",
      category: "",
      type: "fixed",
      ageInYears: 0,
      propertyId: "",
      region: "",
      buildingAddress: "",
      location: "",
      serialNumber: "",
      purchasePrice: undefined,
      assetTagId: "",
    },
  });

  const editForm = useForm<z.infer<typeof assetFormSchema>>({
    resolver: zodResolver(assetFormSchema),
  });

  const addAssetType = addForm.watch("type");
  const editAssetType = editForm.watch("type");

  const handleAddPropertyChange = (propertyId: string) => {
    const property = properties.find(p => p.id === propertyId);
    if (property) {
      addForm.setValue("propertyId", propertyId);
      addForm.setValue("region", property.region);
      addForm.setValue("buildingAddress", property.address);
    }
  };

  const handleEditPropertyChange = (propertyId: string) => {
    const property = properties.find(p => p.id === propertyId);
    if (property) {
      editForm.setValue("propertyId", propertyId);
      editForm.setValue("region", property.region);
      editForm.setValue("buildingAddress", property.address);
    }
  };

  const getPropertyForAsset = (asset: Asset) => {
    if (asset.propertyId) return properties.find(p => p.id === asset.propertyId) || null;
    return properties.find(p => p.address === asset.buildingAddress) || null;
  };

  const handleEdit = (id: string) => {
    const asset = assetsData?.find((a) => a.id === id);
    if (asset) {
      setEditingAsset(asset);
      const property = getPropertyForAsset(asset);
      editForm.reset({
        name: asset.name,
        category: asset.category,
        type: asset.type,
        ageInYears: asset.ageInYears,
        propertyId: asset.propertyId || property?.id || "",
        region: asset.region,
        buildingAddress: asset.buildingAddress,
        location: asset.location || "",
        serialNumber: asset.serialNumber || "",
        lastServiced: asset.lastServiced ? asset.lastServiced : undefined,
        purchasePrice: asset.purchasePrice ? Number(asset.purchasePrice) : undefined,
        assetTagId: asset.assetTagId || "",
      });
      setIsEditDialogOpen(true);
    }
  };

  const onSubmitAdd = async (data: z.infer<typeof assetFormSchema>) => {
    if (!addPhotoUrl) {
      toast({ title: "Photo required", description: "Please upload a photo of the asset before saving.", variant: "destructive" });
      return;
    }
    try {
      const asset = await createAssetMutation.mutateAsync(data);
      await createAssetPhotoMutation.mutateAsync({
        assetId: asset.id,
        imageUrl: addPhotoUrl,
        uploadedBy: typedUser?.email || "Unknown",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/assets"] });
      setIsAddDialogOpen(false);
      addForm.reset();
      setAddPhotoUrl(null);
      toast({ title: "Asset created", description: "Asset and photo saved successfully." });
    } catch {
      toast({ title: "Error", description: "Failed to create asset", variant: "destructive" });
    }
  };

  const onSubmitEdit = (data: z.infer<typeof assetFormSchema>) => {
    if (editingAsset) {
      updateAssetMutation.mutate({ id: editingAsset.id, data });
    }
  };

  const assets = (assetsData || []).filter((asset) => {
    const matchesRegion = selectedRegion === "all" || asset.region === selectedRegion;
    const matchesBuilding = selectedBuilding === "all" || asset.buildingAddress === selectedBuilding;
    return matchesRegion && matchesBuilding;
  });

  const buildings = Array.from(
    new Set((assetsData || []).map(a => a.buildingAddress).filter(addr => addr && addr.trim() !== ""))
  ).map(addr => ({ id: addr, address: addr }));

  const isAddSubmitting = createAssetMutation.isPending || createAssetPhotoMutation.isPending;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold">Asset Tracking</h1>
        <p className="text-muted-foreground mt-1">Manage fixed and movable assets across properties</p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap gap-4">
          <RegionSelector selectedRegion={selectedRegion} onRegionChange={setSelectedRegion} />
          <BuildingSelector selectedBuilding={selectedBuilding} onBuildingChange={setSelectedBuilding} buildings={buildings} />
        </div>

        <Dialog open={isAddDialogOpen} onOpenChange={(open) => { setIsAddDialogOpen(open); if (!open) { addForm.reset(); setAddPhotoUrl(null); } }}>
          <DialogTrigger asChild>
            <Button data-testid="button-add-asset" disabled={!canManage}>
              <Plus className="h-4 w-4 mr-2" />
              Add Asset
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Add New Asset</DialogTitle>
            </DialogHeader>
            <Form {...addForm}>
              <form onSubmit={addForm.handleSubmit(onSubmitAdd)} className="space-y-4">

                {/* Row 1: Name + Category */}
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={addForm.control}
                    name="name"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Asset Name</FormLabel>
                        <FormControl>
                          <Input {...field} data-testid="input-asset-name" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={addForm.control}
                    name="category"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Category</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value}>
                          <FormControl>
                            <SelectTrigger data-testid="select-asset-category">
                              <SelectValue placeholder="Select category" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {ASSET_CATEGORIES.map((cat) => (
                              <SelectItem key={cat} value={cat}>{cat}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                {/* Row 2: Type + Age (age only for fixed) */}
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={addForm.control}
                    name="type"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Type</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value}>
                          <FormControl>
                            <SelectTrigger data-testid="select-asset-type">
                              <SelectValue />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="fixed">Fixed</SelectItem>
                            <SelectItem value="movable">Movable</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  {addAssetType === "fixed" && (
                    <FormField
                      control={addForm.control}
                      name="ageInYears"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Age (Years)</FormLabel>
                          <FormControl>
                            <Input type="number" {...field} data-testid="input-asset-age" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  )}
                </div>

                {/* Row 3: Asset Tag ID + Purchase Price */}
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={addForm.control}
                    name="assetTagId"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Asset Tag ID <span className="text-muted-foreground font-normal">(Optional)</span></FormLabel>
                        <FormControl>
                          <Input {...field} placeholder="e.g., SPO-2024-001" data-testid="input-asset-tag-id" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={addForm.control}
                    name="purchasePrice"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Purchase Price</FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            step="0.01"
                            placeholder="0.00"
                            value={field.value ?? ""}
                            onChange={(e) => field.onChange(e.target.value === "" ? undefined : e.target.value)}
                            data-testid="input-asset-price"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                {/* Row 4: Serial Number + Last Serviced (last serviced only for fixed) */}
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={addForm.control}
                    name="serialNumber"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Serial Number <span className="text-muted-foreground text-xs">(optional)</span></FormLabel>
                        <FormControl>
                          <Input {...field} value={field.value || ""} data-testid="input-asset-serial" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  {addAssetType === "fixed" && (
                    <FormField
                      control={addForm.control}
                      name="lastServiced"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Last Serviced <span className="text-muted-foreground text-xs">(optional)</span></FormLabel>
                          <FormControl>
                            <Input
                              type="date"
                              value={field.value ? String(field.value).split('T')[0] : ""}
                              onChange={(e) => field.onChange(e.target.value || undefined)}
                              data-testid="input-asset-serviced"
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  )}
                </div>

                {/* Property */}
                <FormField
                  control={addForm.control}
                  name="propertyId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Property</FormLabel>
                      <Select onValueChange={handleAddPropertyChange} value={field.value || ""}>
                        <FormControl>
                          <SelectTrigger data-testid="select-asset-property">
                            <SelectValue placeholder="Select property" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {properties.map((property) => (
                            <SelectItem key={property.id} value={property.id}>
                              <div className="flex flex-col">
                                <span>{property.name}</span>
                                <span className="text-xs text-muted-foreground">{property.address} ({property.region})</span>
                              </div>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {/* Location */}
                <FormField
                  control={addForm.control}
                  name="location"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Location in Property</FormLabel>
                      <FormControl>
                        <Input {...field} placeholder="e.g., Kitchen, Basement, Unit 2A" data-testid="input-asset-location" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {/* Photo (required) */}
                <FormItem>
                  <FormLabel>
                    Photo
                    {!addPhotoUrl && (
                      <span className="text-destructive ml-1 text-xs">* required</span>
                    )}
                    {addPhotoUrl && (
                      <span className="text-green-600 dark:text-green-400 ml-1 text-xs">✓ uploaded</span>
                    )}
                  </FormLabel>
                  <PhotoUpload
                    onUpload={(url) => setAddPhotoUrl(url)}
                    onError={(err) => toast({ title: "Upload failed", description: err, variant: "destructive" })}
                    disabled={isAddSubmitting}
                  />
                </FormItem>

                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setIsAddDialogOpen(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={isAddSubmitting} data-testid="button-submit-asset">
                    {isAddSubmitting ? "Saving..." : "Create Asset"}
                  </Button>
                </DialogFooter>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      </div>

      {isLoading ? (
        <div className="text-center py-8">Loading assets...</div>
      ) : (
        <AssetTracker
          assets={assets}
          properties={properties}
          onEdit={canManage ? handleEdit : undefined}
          onDelete={canManage ? (id) => setDeletingAssetId(id) : undefined}
          onPhotos={(id) => {
            const asset = assetsData?.find(a => a.id === id);
            if (asset) { setSelectedAssetForPhotos(asset); setIsPhotosDialogOpen(true); }
          }}
        />
      )}

      {/* Edit Dialog */}
      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Asset</DialogTitle>
          </DialogHeader>
          <Form {...editForm}>
            <form onSubmit={editForm.handleSubmit(onSubmitEdit)} className="space-y-4">

              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={editForm.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Asset Name</FormLabel>
                      <FormControl><Input {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={editForm.control}
                  name="category"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Category</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger><SelectValue placeholder="Select category" /></SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {ASSET_CATEGORIES.map((cat) => (
                            <SelectItem key={cat} value={cat}>{cat}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={editForm.control}
                  name="type"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Type</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="fixed">Fixed</SelectItem>
                          <SelectItem value="movable">Movable</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                {editAssetType === "fixed" && (
                  <FormField
                    control={editForm.control}
                    name="ageInYears"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Age (Years)</FormLabel>
                        <FormControl><Input type="number" {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}
              </div>

              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={editForm.control}
                  name="assetTagId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Asset Tag ID <span className="text-muted-foreground font-normal">(Optional)</span></FormLabel>
                      <FormControl>
                        <Input {...field} value={field.value || ""} placeholder="e.g., SPO-2024-001" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={editForm.control}
                  name="purchasePrice"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Purchase Price</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          step="0.01"
                          placeholder="0.00"
                          value={field.value ?? ""}
                          onChange={(e) => field.onChange(e.target.value === "" ? undefined : e.target.value)}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={editForm.control}
                  name="serialNumber"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Serial Number <span className="text-muted-foreground text-xs">(optional)</span></FormLabel>
                      <FormControl><Input {...field} value={field.value || ""} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                {editAssetType === "fixed" && (
                  <FormField
                    control={editForm.control}
                    name="lastServiced"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Last Serviced <span className="text-muted-foreground text-xs">(optional)</span></FormLabel>
                        <FormControl>
                          <Input
                            type="date"
                            value={field.value ? String(field.value).split('T')[0] : ""}
                            onChange={(e) => field.onChange(e.target.value || undefined)}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}
              </div>

              <FormField
                control={editForm.control}
                name="propertyId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Property</FormLabel>
                    <Select onValueChange={handleEditPropertyChange} value={field.value || ""}>
                      <FormControl>
                        <SelectTrigger><SelectValue placeholder="Select property" /></SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {properties.map((property) => (
                          <SelectItem key={property.id} value={property.id}>
                            <div className="flex flex-col">
                              <span>{property.name}</span>
                              <span className="text-xs text-muted-foreground">{property.address} ({property.region})</span>
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={editForm.control}
                name="location"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Location in Property</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder="e.g., Kitchen, Basement, Unit 2A" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setIsEditDialogOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={updateAssetMutation.isPending}>
                  {updateAssetMutation.isPending ? "Updating..." : "Update Asset"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deletingAssetId} onOpenChange={() => setDeletingAssetId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Asset</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this asset? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deletingAssetId && deleteAssetMutation.mutate(deletingAssetId)}
              className="bg-destructive text-destructive-foreground"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Photos Dialog */}
      <Dialog open={isPhotosDialogOpen} onOpenChange={(open) => { setIsPhotosDialogOpen(open); if (!open) setSelectedAssetForPhotos(null); }}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Photos — {selectedAssetForPhotos?.name}</DialogTitle>
            <DialogDescription>Upload and manage photos for this asset</DialogDescription>
          </DialogHeader>

          {canManage && (
            <div className="space-y-2">
              <h4 className="font-medium text-sm">Upload New Photo</h4>
              <PhotoUpload
                onUpload={(url) => {
                  if (selectedAssetForPhotos) {
                    addPhotoToAssetMutation.mutate({
                      assetId: selectedAssetForPhotos.id,
                      imageUrl: url,
                      uploadedBy: typedUser?.email || "Unknown",
                    });
                  }
                }}
                onError={(error) => toast({ title: "Error", description: error, variant: "destructive" })}
                disabled={addPhotoToAssetMutation.isPending}
              />
            </div>
          )}

          <div className="space-y-3">
            <h4 className="font-medium text-sm">Existing Photos ({assetPhotos.length})</h4>
            {assetPhotos.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <Image className="h-12 w-12 mx-auto mb-2 opacity-50" />
                <p>No photos yet</p>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-4">
                {assetPhotos.map((photo) => (
                  <div key={photo.id} className="relative group rounded-md overflow-hidden border" data-testid={`photo-${photo.id}`}>
                    <img src={photo.imageUrl} alt={photo.caption || "Asset photo"} className="w-full h-40 object-cover" />
                    {canManage && (
                      <Button
                        type="button"
                        size="icon"
                        variant="destructive"
                        className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={() => deleteAssetPhotoMutation.mutate(photo.id)}
                        disabled={deleteAssetPhotoMutation.isPending}
                        data-testid={`button-delete-photo-${photo.id}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                    {photo.caption && (
                      <div className="absolute bottom-0 left-0 right-0 bg-black/50 text-white text-xs p-2">
                        {photo.caption}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setIsPhotosDialogOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
