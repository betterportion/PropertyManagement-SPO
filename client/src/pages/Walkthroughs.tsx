import { useState } from "react";
import WalkthroughGallery from "@/components/WalkthroughGallery";
import RegionSelector from "@/components/RegionSelector";
import BuildingSelector from "@/components/BuildingSelector";

export default function Walkthroughs() {
  //todo: remove mock functionality
  const [selectedRegion, setSelectedRegion] = useState("all");
  const [selectedBuilding, setSelectedBuilding] = useState("all");

  const buildings = [
    { id: "1", address: "123 Main St, Austin, TX" },
    { id: "2", address: "456 Oak Ave, Austin, TX" },
    { id: "3", address: "789 River Rd, Austin, TX" },
    { id: "4", address: "321 Park Blvd, Austin, TX" },
    { id: "5", address: "654 Elm St, Austin, TX" },
  ];

  const allImages = [
    {
      id: "1",
      url: "https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?w=400&h=400&fit=crop",
      caption: "Living Room - Unit 204",
      uploadedDate: new Date(2025, 10, 1),
      propertyName: "West Central Property",
      location: "Unit 204 - Living Room",
      region: "west-central" as const,
      buildingId: "1",
    },
    {
      id: "2",
      url: "https://images.unsplash.com/photo-1556912173-46c336c7fd55?w=400&h=400&fit=crop",
      caption: "Kitchen - Unit 305",
      uploadedDate: new Date(2025, 10, 1),
      propertyName: "East Central Property",
      location: "Unit 305 - Kitchen",
      region: "east-central" as const,
      buildingId: "2",
    },
    {
      id: "3",
      url: "https://images.unsplash.com/photo-1552321554-5fefe8c9ef14?w=400&h=400&fit=crop",
      caption: "Bathroom - Unit 101",
      uploadedDate: new Date(2025, 10, 1),
      propertyName: "North West Property",
      location: "Unit 101 - Bathroom",
      region: "north-west" as const,
      buildingId: "3",
    },
    {
      id: "4",
      url: "https://images.unsplash.com/photo-1616486338812-3dadae4b4ace?w=400&h=400&fit=crop",
      caption: "Bedroom - Unit 402",
      uploadedDate: new Date(2025, 10, 1),
      propertyName: "South West Property",
      location: "Unit 402 - Bedroom",
      region: "south-west" as const,
      buildingId: "4",
    },
    {
      id: "5",
      url: "https://images.unsplash.com/photo-1582268611958-ebfd161ef9cf?w=400&h=400&fit=crop",
      caption: "Common Area - Lobby",
      uploadedDate: new Date(2025, 10, 2),
      propertyName: "North East Property",
      location: "Building A - Lobby",
      region: "north-east" as const,
      buildingId: "5",
    },
    {
      id: "6",
      url: "https://images.unsplash.com/photo-1574643156929-51fa098b0394?w=400&h=400&fit=crop",
      caption: "Fitness Center",
      uploadedDate: new Date(2025, 10, 2),
      propertyName: "South East Property",
      location: "Building A - Gym",
      region: "south-east" as const,
      buildingId: "1",
    },
  ];

  const images = allImages.filter((img) => {
    const matchesRegion = selectedRegion === "all" || img.region === selectedRegion;
    const matchesBuilding = selectedBuilding === "all" || img.buildingId === selectedBuilding;
    return matchesRegion && matchesBuilding;
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold">Walkthrough Images</h1>
        <p className="text-muted-foreground mt-1">Property inspection and walkthrough documentation</p>
      </div>

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

      <WalkthroughGallery
        images={images}
        onUpload={() => console.log("Upload images")}
        onDelete={(id) => console.log("Delete image:", id)}
      />
    </div>
  );
}
