import { useState } from "react";
import AssetTracker from "@/components/AssetTracker";
import PropertySelector from "@/components/PropertySelector";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";

export default function Assets() {
  //todo: remove mock functionality
  const [selectedProperty, setSelectedProperty] = useState("1");

  const properties = [
    { id: "1", name: "Sunset Apartments", address: "123 Main St, Austin, TX" },
    { id: "2", name: "Oak Ridge Complex", address: "456 Oak Ave, Austin, TX" },
    { id: "3", name: "River View Condos", address: "789 River Rd, Austin, TX" },
  ];

  const assets = [
    {
      id: "1",
      name: "Central HVAC System",
      category: "HVAC",
      type: "fixed" as const,
      condition: "good" as const,
      lastServiced: new Date(2025, 9, 15),
      serialNumber: "HVAC-2024-001",
      location: "Building A - Roof",
    },
    {
      id: "2",
      name: "Washing Machine - Unit 204",
      category: "Appliance",
      type: "fixed" as const,
      condition: "fair" as const,
      lastServiced: new Date(2025, 8, 20),
      serialNumber: "WM-204-2020",
      location: "Unit 204 - Laundry",
    },
    {
      id: "3",
      name: "Water Heater - Building A",
      category: "Plumbing",
      type: "fixed" as const,
      condition: "excellent" as const,
      lastServiced: new Date(2025, 10, 1),
      serialNumber: "WH-A-2023",
      location: "Building A - Utility Room",
    },
    {
      id: "4",
      name: "Oven - Unit 305",
      category: "Appliance",
      type: "fixed" as const,
      condition: "good" as const,
      lastServiced: new Date(2025, 7, 10),
      serialNumber: "OV-305-2021",
      location: "Unit 305 - Kitchen",
    },
    {
      id: "5",
      name: "Living Room Sofa Set",
      category: "Furniture",
      type: "movable" as const,
      condition: "excellent" as const,
      location: "Unit 101 - Living Room",
    },
    {
      id: "6",
      name: "55'' Smart TV",
      category: "Electronics",
      type: "movable" as const,
      condition: "good" as const,
      serialNumber: "TV-2023-042",
      location: "Unit 305 - Living Room",
    },
    {
      id: "7",
      name: "Dining Table & Chairs",
      category: "Furniture",
      type: "movable" as const,
      condition: "good" as const,
      location: "Unit 204 - Dining Room",
    },
    {
      id: "8",
      name: "Sound System",
      category: "Electronics",
      type: "movable" as const,
      condition: "excellent" as const,
      serialNumber: "SS-2024-015",
      location: "Common Area - Entertainment Room",
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold">Asset Tracking</h1>
        <p className="text-muted-foreground mt-1">Manage fixed and movable assets across properties</p>
      </div>

      <div className="flex items-center justify-between gap-4">
        <PropertySelector
          selectedProperty={selectedProperty}
          onPropertyChange={setSelectedProperty}
          properties={properties}
        />
        <Button data-testid="button-add-asset">
          <Plus className="h-4 w-4 mr-2" />
          Add Asset
        </Button>
      </div>

      <AssetTracker
        assets={assets}
        onEdit={(id) => console.log("Edit asset:", id)}
        onDelete={(id) => console.log("Delete asset:", id)}
      />
    </div>
  );
}
