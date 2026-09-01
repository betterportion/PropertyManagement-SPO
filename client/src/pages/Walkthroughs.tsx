import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Plus, ArrowLeft, Building2, MapPin, DoorOpen } from "lucide-react";
import RoomCard from "@/components/RoomCard";
import RoomDetailDrawer from "@/components/RoomDetailDrawer";
import { PhotoUpload } from "@/components/PhotoUpload";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { insertWalkthroughRoomSchema, insertWalkthroughPhotoSchema, type WalkthroughRoom, type WalkthroughPhoto, type UserPermissions, type Property } from "@shared/schema";
import { z } from "zod";
import { Section, Container, PageHeader, PageStack } from "@/components/layout/page";
import { LoadingState, EmptyState } from "@/components/states";

interface User {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  role: string;
}

export default function Walkthroughs() {
  const [selectedProperty, setSelectedProperty] = useState<Property | null>(null);
  const [selectedRoom, setSelectedRoom] = useState<WalkthroughRoom | null>(null);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [isAddRoomDialogOpen, setIsAddRoomDialogOpen] = useState(false);
  const [createdRoom, setCreatedRoom] = useState<WalkthroughRoom | null>(null);
  const [isPhotoUploadDialogOpen, setIsPhotoUploadDialogOpen] = useState(false);

  const { user } = useAuth();
  const { toast } = useToast();

  const typedUser = user as User | null;

  const { data: permissions } = useQuery<UserPermissions>({
    queryKey: [`/api/users/${typedUser?.id}/permissions`],
    enabled: !!typedUser?.id,
  });

  const canManage = permissions?.canManageWalkthroughs || typedUser?.role === "admin" || typedUser?.role === "regional_administrator";

  const { data: allRooms = [], isLoading: roomsLoading } = useQuery<WalkthroughRoom[]>({
    queryKey: ['/api/walkthrough-rooms'],
  });

  const { data: allPhotos = [] } = useQuery<WalkthroughPhoto[]>({
    queryKey: ['/api/walkthrough-photos'],
  });

  const { data: properties = [], isLoading: propertiesLoading } = useQuery<Property[]>({
    queryKey: ['/api/properties'],
  });

  const getFirstPhotoForRoom = (roomId: string) => {
    return allPhotos.find(photo => photo.roomId === roomId) || null;
  };

  const getPropertyForRoom = (room: WalkthroughRoom) => {
    if (room.propertyId) return properties.find(p => p.id === room.propertyId) || null;
    return properties.find(p => p.address === room.buildingAddress) || null;
  };

  const getRoomCountForProperty = (property: Property) => {
    return allRooms.filter(r => r.propertyId === property.id || r.buildingAddress === property.address).length;
  };

  const roomsForSelectedProperty = selectedProperty
    ? allRooms.filter(r => r.propertyId === selectedProperty.id || r.buildingAddress === selectedProperty.address)
    : [];

  const handleOpenRoom = (room: WalkthroughRoom) => {
    setSelectedRoom(room);
    setIsDrawerOpen(true);
  };

  const addRoomForm = useForm<z.infer<typeof insertWalkthroughRoomSchema>>({
    resolver: zodResolver(insertWalkthroughRoomSchema),
    defaultValues: {
      name: "",
      propertyId: "",
      buildingAddress: "",
      displayOrder: 0,
    },
  });

  const photoForm = useForm<z.infer<typeof insertWalkthroughPhotoSchema>>({
    resolver: zodResolver(insertWalkthroughPhotoSchema),
    defaultValues: {
      roomId: "",
      imageUrl: "",
      condition: "same_as_last_walkthrough",
      notes: "",
      region: "",
      buildingAddress: "",
      location: "",
      uploadedBy: typedUser?.email || "",
    },
  });

  const createRoomMutation = useMutation<WalkthroughRoom, Error, z.infer<typeof insertWalkthroughRoomSchema>>({
    mutationFn: async (data) => {
      const response = await apiRequest("POST", "/api/walkthrough-rooms", data);
      return response.json() as Promise<WalkthroughRoom>;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/walkthrough-rooms"] });
      setIsAddRoomDialogOpen(false);
      addRoomForm.reset();
      setCreatedRoom(data);
      photoForm.setValue("roomId", data.id);
      photoForm.setValue("region", selectedProperty?.region || "");
      photoForm.setValue("buildingAddress", selectedProperty?.address || "");
      photoForm.setValue("location", data.name);
      photoForm.setValue("uploadedBy", typedUser?.email || "");
      setIsPhotoUploadDialogOpen(true);
      toast({ title: "Room created", description: "Add a photo to document this room." });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to create room", variant: "destructive" });
    },
  });

  const createPhotoMutation = useMutation({
    mutationFn: async (data: z.infer<typeof insertWalkthroughPhotoSchema>) => {
      return await apiRequest("POST", "/api/walkthrough-photos", data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/walkthrough-photos"] });
      setIsPhotoUploadDialogOpen(false);
      setCreatedRoom(null);
      photoForm.reset();
      toast({ title: "Photo uploaded", description: "Room documentation saved." });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to upload photo", variant: "destructive" });
    },
  });

  const handleOpenAddRoom = () => {
    if (!selectedProperty) return;
    addRoomForm.setValue("propertyId", selectedProperty.id);
    addRoomForm.setValue("buildingAddress", selectedProperty.address);
    addRoomForm.setValue("displayOrder", 0);
    setIsAddRoomDialogOpen(true);
  };

  const onSubmitRoom = (data: z.infer<typeof insertWalkthroughRoomSchema>) => {
    createRoomMutation.mutate(data);
  };

  const onSubmitPhoto = (data: z.infer<typeof insertWalkthroughPhotoSchema>) => {
    if (!createdRoom) return;
    createPhotoMutation.mutate({ ...data, roomId: createdRoom.id });
  };

  const isLoading = propertiesLoading || roomsLoading;

  return (
    <Section size="compact">
      <Container>
      <PageStack>
      <PageHeader
        title={selectedProperty ? selectedProperty.name : "Walkthroughs"}
        description={selectedProperty ? selectedProperty.address : "Select a property to view and document its rooms."}
        actions={
          <>
            {selectedProperty && (
              <Button variant="ghost" size="icon" onClick={() => setSelectedProperty(null)} data-testid="button-back-to-properties" aria-label="Back to properties">
                <ArrowLeft className="h-4 w-4" />
              </Button>
            )}
            {selectedProperty && canManage && (
              <Button variant="primary" onClick={handleOpenAddRoom} data-testid="button-add-room">
                <Plus className="h-4 w-4" />
                Add room
              </Button>
            )}
          </>
        }
      />

      {isLoading ? (
        <LoadingState message="Loading walkthroughs..." />
      ) : !selectedProperty ? (
        /* Property selection grid */
        properties.length === 0 ? (
          <div className="text-center py-16">
            <Building2 className="h-12 w-12 text-muted-foreground/40 mx-auto mb-3" />
            <EmptyState title="No properties are ready for walkthroughs" description="Add a property first, then document each room from this workspace." />
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {properties.map((property) => {
              const roomCount = getRoomCountForProperty(property);
              return (
                <Card
                  key={property.id}
                  className="hover-elevate active-elevate-2 cursor-pointer"
                  onClick={() => setSelectedProperty(property)}
                  data-testid={`card-property-${property.id}`}
                >
                  <CardContent className="p-5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="rounded-md bg-muted p-2 flex-shrink-0">
                        <Building2 className="h-5 w-5 text-muted-foreground" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <h3 className="font-semibold text-base truncate" data-testid={`text-property-name-${property.id}`}>
                          {property.name}
                        </h3>
                        <div className="flex items-center gap-1 mt-1 text-sm text-muted-foreground">
                          <MapPin className="h-3 w-3 flex-shrink-0" />
                          <span className="truncate">{property.address}</span>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 mt-4">
                      {property.region && (
                        <Badge variant="secondary" className="text-xs">
                          {property.region}
                        </Badge>
                      )}
                      <div className="flex items-center gap-1 text-xs text-muted-foreground ml-auto">
                        <DoorOpen className="h-3.5 w-3.5" />
                        <span>{roomCount} {roomCount === 1 ? "room" : "rooms"}</span>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )
      ) : (
        /* Rooms for selected property */
        roomsForSelectedProperty.length === 0 ? (
          <EmptyState
            icon={DoorOpen}
            title="This property has no rooms yet"
            description="Add the first room to begin documenting its condition."
            action={canManage ? <Button variant="primary" onClick={handleOpenAddRoom} data-testid="button-add-room-empty"><Plus className="h-4 w-4" />Add first room</Button> : undefined}
          />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {roomsForSelectedProperty.map((room) => (
              <RoomCard
                key={room.id}
                room={room}
                photo={getFirstPhotoForRoom(room.id)}
                property={getPropertyForRoom(room)}
                onClick={() => handleOpenRoom(room)}
              />
            ))}
          </div>
        )
      )}

      <RoomDetailDrawer
        room={selectedRoom}
        open={isDrawerOpen}
        onOpenChange={setIsDrawerOpen}
        canManage={canManage}
      />

      {/* Add Room Dialog */}
      <Dialog open={isAddRoomDialogOpen} onOpenChange={setIsAddRoomDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add New Room</DialogTitle>
            <DialogDescription>
              {selectedProperty?.name} — {selectedProperty?.address}
            </DialogDescription>
          </DialogHeader>
          <Form {...addRoomForm}>
            <form onSubmit={addRoomForm.handleSubmit(onSubmitRoom)} className="space-y-4">
              <FormField
                control={addRoomForm.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Room Name</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder="Living Room, Bedroom, Kitchen, etc." data-testid="input-room-name" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button type="button" variant="secondary" onClick={() => setIsAddRoomDialogOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={createRoomMutation.isPending} data-testid="button-submit-room">
                  {createRoomMutation.isPending ? "Creating..." : "Create Room"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* Photo Upload Dialog */}
      <Dialog open={isPhotoUploadDialogOpen} onOpenChange={setIsPhotoUploadDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Add Photo — {createdRoom?.name}</DialogTitle>
            <DialogDescription>Upload a photo and add notes for this room</DialogDescription>
          </DialogHeader>
          <Form {...photoForm}>
            <form onSubmit={photoForm.handleSubmit(onSubmitPhoto)} className="space-y-4">
              <FormField
                control={photoForm.control}
                name="imageUrl"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Photo</FormLabel>
                    <FormControl>
                      <PhotoUpload
                        onUpload={(url) => field.onChange(url)}
                        onError={(error) => toast({ title: "Upload failed", description: error, variant: "destructive" })}
                        disabled={createPhotoMutation.isPending}
                      />
                    </FormControl>
                    {field.value && (
                      <p className="text-xs text-muted-foreground">Photo uploaded successfully</p>
                    )}
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={photoForm.control}
                name="condition"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Condition</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value ?? undefined}>
                      <FormControl>
                        <SelectTrigger data-testid="select-condition">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="same_as_last_walkthrough">Same as Last Walkthrough</SelectItem>
                        <SelectItem value="additional_damage">Additional Damage</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={photoForm.control}
                name="notes"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Notes (Optional)</FormLabel>
                    <FormControl>
                      <Textarea
                        {...field}
                        value={field.value || ""}
                        placeholder="Describe the room condition, any issues, or observations..."
                        data-testid="input-photo-notes"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <DialogFooter>
                <Button type="submit" disabled={createPhotoMutation.isPending} data-testid="button-submit-photo">
                  {createPhotoMutation.isPending ? "Uploading..." : "Add Room"}
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
