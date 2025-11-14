import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import RegionSelector from "@/components/RegionSelector";
import BuildingSelector from "@/components/BuildingSelector";
import RoomCard from "@/components/RoomCard";
import RoomDetailDrawer from "@/components/RoomDetailDrawer";
import { useAuth } from "@/hooks/useAuth";
import type { WalkthroughRoom, WalkthroughPhoto, UserPermissions } from "@shared/schema";

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

  const { user, isAuthenticated } = useAuth();
  
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

  const handleAddRoom = () => {
    console.log("Add new room - will implement form");
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
    </div>
  );
}
