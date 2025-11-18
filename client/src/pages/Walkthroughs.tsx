import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import RegionSelector from "@/components/RegionSelector";
import BuildingSelector from "@/components/BuildingSelector";
import RoomCard from "@/components/RoomCard";
import RoomDetailDrawer from "@/components/RoomDetailDrawer";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { insertWalkthroughRoomSchema, type WalkthroughRoom, type WalkthroughPhoto, type UserPermissions } from "@shared/schema";
import { z } from "zod";

interface User {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  role: string;
}

export default function Walkthroughs() {
  const [selectedRegion, setSelectedRegion] = useState("all");
  const [selectedBuilding, setSelectedBuilding] = useState("all");
  const [selectedRoom, setSelectedRoom] = useState<WalkthroughRoom | null>(null);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [isAddRoomDialogOpen, setIsAddRoomDialogOpen] = useState(false);

  const { user, isAuthenticated } = useAuth();
  const { toast } = useToast();
  
  const typedUser = user as User | null;
  
  const { data: permissions } = useQuery<UserPermissions>({
    queryKey: [`/api/users/${typedUser?.id}/permissions`],
    enabled: !!typedUser?.id,
  });
  
  const canManage = permissions?.canManageWalkthroughs || false;

  const { data: allRooms = [], isLoading } = useQuery<WalkthroughRoom[]>({
    queryKey: ['/api/walkthrough-rooms'],
  });

  const { data: allPhotos = [] } = useQuery<WalkthroughPhoto[]>({
    queryKey: ['/api/walkthrough-photos'],
    enabled: selectedRegion !== "all",
  });

  const uniqueBuildings = allRooms
    .filter(room => room.buildingAddress)
    .map(room => room.buildingAddress)
    .filter((address, index, arr) => arr.indexOf(address) === index)
    .map(address => ({
      id: address,
      address,
    }));

  const rooms = allRooms.filter((room) => {
    if (!room.buildingAddress) return false;
    
    const matchesBuilding = selectedBuilding === "all" || room.buildingAddress === selectedBuilding;
    
    if (selectedRegion === "all") {
      return matchesBuilding;
    }
    
    const roomPhotos = allPhotos.filter(photo => photo.roomId === room.id);
    if (roomPhotos.length === 0) return false;
    
    const hasRegionMatch = roomPhotos.some(photo => {
      if (!photo.region) return false;
      const photoRegion = photo.region.toLowerCase().replace(/\s+/g, '-');
      return photoRegion === selectedRegion;
    });
    
    return matchesBuilding && hasRegionMatch;
  });

  const handleOpenRoom = (room: WalkthroughRoom) => {
    setSelectedRoom(room);
    setIsDrawerOpen(true);
  };

  const createRoomMutation = useMutation({
    mutationFn: async (data: z.infer<typeof insertWalkthroughRoomSchema>) => {
      return await apiRequest("POST", "/api/walkthrough-rooms", data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/walkthrough-rooms"] });
      setIsAddRoomDialogOpen(false);
      addRoomForm.reset();
      toast({
        title: "Success",
        description: "Room created successfully",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to create room",
        variant: "destructive",
      });
    },
  });

  const addRoomForm = useForm<z.infer<typeof insertWalkthroughRoomSchema>>({
    resolver: zodResolver(insertWalkthroughRoomSchema),
    defaultValues: {
      name: "",
      buildingAddress: "",
      displayOrder: 0,
    },
  });

  const handleAddRoom = () => {
    setIsAddRoomDialogOpen(true);
  };

  const onSubmitRoom = (data: z.infer<typeof insertWalkthroughRoomSchema>) => {
    createRoomMutation.mutate(data);
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-start">
        <div>
          <h1 className="text-3xl font-semibold">Walkthroughs</h1>
          <p className="text-muted-foreground mt-1">Property inspection and walkthrough documentation</p>
        </div>
        {canManage && (
          <Button onClick={handleAddRoom} data-testid="button-add-room">
            <Plus className="h-4 w-4 mr-2" />
            Add Room
          </Button>
        )}
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
      </div>

      {isLoading ? (
        <p className="text-muted-foreground">Loading rooms...</p>
      ) : rooms.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-muted-foreground mb-4">No walkthrough rooms found</p>
          {canManage && (
            <Button onClick={handleAddRoom} data-testid="button-add-room-empty">
              <Plus className="h-4 w-4 mr-2" />
              Add Room
            </Button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {rooms.map((room) => (
            <RoomCard
              key={room.id}
              room={room}
              onClick={() => handleOpenRoom(room)}
            />
          ))}
        </div>
      )}

      <RoomDetailDrawer
        room={selectedRoom}
        open={isDrawerOpen}
        onOpenChange={setIsDrawerOpen}
        canManage={canManage}
      />

      <Dialog open={isAddRoomDialogOpen} onOpenChange={setIsAddRoomDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add New Room</DialogTitle>
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
                      <Input {...field} placeholder="Living Room, Bedroom, etc." data-testid="input-room-name" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={addRoomForm.control}
                name="buildingAddress"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Building Address</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder="123 Main St, Austin, TX" data-testid="input-room-building" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={addRoomForm.control}
                name="displayOrder"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Display Order</FormLabel>
                    <FormControl>
                      <Input type="number" {...field} value={field.value ?? 0} onChange={e => field.onChange(parseInt(e.target.value))} data-testid="input-room-order" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setIsAddRoomDialogOpen(false)}>
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
    </div>
  );
}
