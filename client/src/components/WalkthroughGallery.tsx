import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Upload, Calendar, X } from "lucide-react";
import { format } from "date-fns";
import { EmptyState } from "@/components/states";

interface WalkthroughImage {
  id: string;
  url: string;
  caption: string;
  uploadedDate: Date;
  propertyName: string;
  location: string;
}

interface WalkthroughGalleryProps {
  images: WalkthroughImage[];
  onUpload?: () => void;
  onDelete?: (id: string) => void;
}

export default function WalkthroughGallery({ images, onUpload, onDelete }: WalkthroughGalleryProps) {
  const [selectedImage, setSelectedImage] = useState<WalkthroughImage | null>(null);

  if (images.length === 0) {
    return (
      <Card className="border-dashed">
        <CardContent className="flex flex-col items-center justify-center py-12">
          <Upload className="h-12 w-12 text-muted-foreground mb-4" />
          <EmptyState title="Walkthrough documentation starts here" description="Upload images to preserve the condition and context of each visit." />
          <Button onClick={onUpload} data-testid="button-upload-images">
            <Upload className="h-4 w-4 mr-2" />
            Upload Images
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <div className="mb-4 flex justify-between items-center">
        <p className="text-sm text-muted-foreground">{images.length} images</p>
        <Button onClick={onUpload} variant="secondary" data-testid="button-add-images">
          <Upload className="h-4 w-4 mr-2" />
          Add Images
        </Button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
        {images.map((image) => (
          <Card 
            key={image.id} 
            className="overflow-hidden hover-elevate cursor-pointer group"
            onClick={() => setSelectedImage(image)}
            data-testid={`card-image-${image.id}`}
          >
            <div className="aspect-square bg-muted relative">
              <img 
                src={image.url} 
                alt={image.caption} 
                className="w-full h-full object-cover"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
                <div className="absolute bottom-0 left-0 right-0 p-3">
                  <p className="text-white text-xs font-medium truncate">{image.location}</p>
                </div>
              </div>
            </div>
          </Card>
        ))}
      </div>

      <Dialog open={!!selectedImage} onOpenChange={() => setSelectedImage(null)}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>{selectedImage?.caption}</DialogTitle>
          </DialogHeader>
          {selectedImage && (
            <div className="space-y-4">
              <div className="bg-muted rounded-md overflow-hidden">
                <img 
                  src={selectedImage.url} 
                  alt={selectedImage.caption} 
                  className="w-full h-auto max-h-[60vh] object-contain"
                />
              </div>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-muted-foreground">Property</p>
                  <p className="font-medium">{selectedImage.propertyName}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Location</p>
                  <p className="font-medium">{selectedImage.location}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Uploaded</p>
                  <p className="font-medium flex items-center gap-1">
                    <Calendar className="h-3 w-3" />
                    {format(selectedImage.uploadedDate, "MMM d, yyyy")}
                  </p>
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="secondary" onClick={() => setSelectedImage(null)}>
                  Close
                </Button>
                <Button 
                  variant="destructive" 
                  onClick={() => {
                    onDelete?.(selectedImage.id);
                    setSelectedImage(null);
                  }}
                  data-testid="button-delete-image"
                >
                  <X className="h-4 w-4 mr-2" />
                  Delete
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
