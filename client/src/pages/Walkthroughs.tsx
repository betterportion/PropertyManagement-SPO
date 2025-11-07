import { useState } from "react";
import WalkthroughGallery from "@/components/WalkthroughGallery";
import PropertySelector from "@/components/PropertySelector";

export default function Walkthroughs() {
  //todo: remove mock functionality
  const [selectedProperty, setSelectedProperty] = useState("1");

  const properties = [
    { id: "1", name: "Sunset Apartments", address: "123 Main St, Austin, TX" },
    { id: "2", name: "Oak Ridge Complex", address: "456 Oak Ave, Austin, TX" },
    { id: "3", name: "River View Condos", address: "789 River Rd, Austin, TX" },
  ];

  const images = [
    {
      id: "1",
      url: "https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?w=400&h=400&fit=crop",
      caption: "Living Room - Unit 204",
      uploadedDate: new Date(2025, 10, 1),
      propertyName: "Sunset Apartments",
      location: "Unit 204 - Living Room",
    },
    {
      id: "2",
      url: "https://images.unsplash.com/photo-1556912173-46c336c7fd55?w=400&h=400&fit=crop",
      caption: "Kitchen - Unit 204",
      uploadedDate: new Date(2025, 10, 1),
      propertyName: "Sunset Apartments",
      location: "Unit 204 - Kitchen",
    },
    {
      id: "3",
      url: "https://images.unsplash.com/photo-1552321554-5fefe8c9ef14?w=400&h=400&fit=crop",
      caption: "Bathroom - Unit 204",
      uploadedDate: new Date(2025, 10, 1),
      propertyName: "Sunset Apartments",
      location: "Unit 204 - Bathroom",
    },
    {
      id: "4",
      url: "https://images.unsplash.com/photo-1616486338812-3dadae4b4ace?w=400&h=400&fit=crop",
      caption: "Bedroom - Unit 204",
      uploadedDate: new Date(2025, 10, 1),
      propertyName: "Sunset Apartments",
      location: "Unit 204 - Bedroom",
    },
    {
      id: "5",
      url: "https://images.unsplash.com/photo-1582268611958-ebfd161ef9cf?w=400&h=400&fit=crop",
      caption: "Common Area - Lobby",
      uploadedDate: new Date(2025, 10, 2),
      propertyName: "Sunset Apartments",
      location: "Building A - Lobby",
    },
    {
      id: "6",
      url: "https://images.unsplash.com/photo-1574643156929-51fa098b0394?w=400&h=400&fit=crop",
      caption: "Fitness Center",
      uploadedDate: new Date(2025, 10, 2),
      propertyName: "Sunset Apartments",
      location: "Building A - Gym",
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold">Walkthrough Images</h1>
        <p className="text-muted-foreground mt-1">Property inspection and walkthrough documentation</p>
      </div>

      <PropertySelector
        selectedProperty={selectedProperty}
        onPropertyChange={setSelectedProperty}
        properties={properties}
      />

      <WalkthroughGallery
        images={images}
        onUpload={() => console.log("Upload images")}
        onDelete={(id) => console.log("Delete image:", id)}
      />
    </div>
  );
}
