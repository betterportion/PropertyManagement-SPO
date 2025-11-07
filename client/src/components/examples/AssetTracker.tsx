import AssetTracker from "../AssetTracker";

export default function AssetTrackerExample() {
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
      name: "Living Room Sofa Set",
      category: "Furniture",
      type: "movable" as const,
      condition: "excellent" as const,
      location: "Unit 101 - Living Room",
    },
    {
      id: "4",
      name: "55'' Smart TV",
      category: "Electronics",
      type: "movable" as const,
      condition: "good" as const,
      serialNumber: "TV-2023-042",
      location: "Unit 305 - Living Room",
    },
  ];

  return (
    <AssetTracker 
      assets={assets}
      onEdit={(id) => console.log("Edit asset:", id)}
      onDelete={(id) => console.log("Delete asset:", id)}
    />
  );
}
