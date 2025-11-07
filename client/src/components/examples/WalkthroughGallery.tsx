import WalkthroughGallery from "../WalkthroughGallery";

export default function WalkthroughGalleryExample() {
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
  ];

  return (
    <WalkthroughGallery 
      images={images}
      onUpload={() => console.log("Upload clicked")}
      onDelete={(id) => console.log("Delete image:", id)}
    />
  );
}
