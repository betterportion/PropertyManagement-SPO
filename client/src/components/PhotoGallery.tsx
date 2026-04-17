import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Upload, X, Save, Calendar } from "lucide-react";
import { format } from "date-fns";
import type { WalkthroughPhoto } from "@shared/schema";

function formatUploadDate(date: Date | string | null | undefined): string | null {
  if (!date) return null;
  try {
    return format(new Date(date), "MMM d, yyyy");
  } catch {
    return null;
  }
}

interface PhotoGalleryProps {
  photos: WalkthroughPhoto[];
  canManage: boolean;
  onUpload?: () => void;
  onDelete?: (id: string) => void;
  onUpdateCaption?: (id: string, caption: string) => void;
}

export default function PhotoGallery({ 
  photos, 
  canManage,
  onUpload, 
  onDelete,
  onUpdateCaption
}: PhotoGalleryProps) {
  const [selectedPhoto, setSelectedPhoto] = useState<WalkthroughPhoto | null>(null);
  const [editingCaption, setEditingCaption] = useState("");
  const [isEditingCaption, setIsEditingCaption] = useState(false);

  const handleOpenPhoto = (photo: WalkthroughPhoto) => {
    setSelectedPhoto(photo);
    setEditingCaption(photo.notes || "");
    setIsEditingCaption(false);
  };

  const handleSaveCaption = () => {
    if (selectedPhoto && onUpdateCaption) {
      onUpdateCaption(selectedPhoto.id, editingCaption);
      setIsEditingCaption(false);
    }
  };

  if (photos.length === 0) {
    return (
      <Card className="border-dashed">
        <div className="flex flex-col items-center justify-center py-12 px-6">
          <Upload className="h-12 w-12 text-muted-foreground mb-4" />
          <h3 className="text-lg font-medium mb-2">No photos yet</h3>
          <p className="text-sm text-muted-foreground mb-4">Upload photos to document this room</p>
          {canManage && onUpload && (
            <Button onClick={onUpload} data-testid="button-upload-photos">
              <Upload className="h-4 w-4 mr-2" />
              Upload Photos
            </Button>
          )}
        </div>
      </Card>
    );
  }

  return (
    <>
      <div className="mb-4 flex justify-between items-center">
        <p className="text-sm text-muted-foreground">{photos.length} photo{photos.length !== 1 ? 's' : ''}</p>
        {canManage && onUpload && (
          <Button onClick={onUpload} variant="outline" size="sm" data-testid="button-add-photos">
            <Upload className="h-4 w-4 mr-2" />
            Add Photos
          </Button>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
        {photos.map((photo) => {
          const dateLabel = formatUploadDate(photo.uploadedDate);
          return (
            <Card
              key={photo.id}
              className="overflow-hidden cursor-pointer group"
              onClick={() => handleOpenPhoto(photo)}
              data-testid={`card-photo-${photo.id}`}
            >
              <div className="aspect-square bg-muted relative">
                <img
                  src={photo.imageUrl}
                  alt={photo.notes || "Room photo"}
                  className="w-full h-full object-cover"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/70 to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
                  <div className="absolute bottom-0 left-0 right-0 p-3 space-y-0.5">
                    {photo.notes && (
                      <p className="text-white text-xs font-medium truncate">{photo.notes}</p>
                    )}
                    {dateLabel && (
                      <p className="text-white/80 text-xs">{dateLabel}</p>
                    )}
                  </div>
                </div>
                {canManage && onDelete && (
                  <button
                    className="absolute top-1.5 right-1.5 h-6 w-6 rounded-md bg-black/60 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-destructive"
                    onClick={(e) => { e.stopPropagation(); onDelete(photo.id); }}
                    data-testid={`button-delete-photo-${photo.id}`}
                    aria-label="Delete photo"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              {dateLabel && (
                <div className="px-2 py-1.5 flex items-center gap-1 text-xs text-muted-foreground border-t">
                  <Calendar className="h-3 w-3 flex-shrink-0" />
                  <span data-testid={`text-photo-date-${photo.id}`}>{dateLabel}</span>
                </div>
              )}
            </Card>
          );
        })}
      </div>

      <Dialog open={!!selectedPhoto} onOpenChange={() => setSelectedPhoto(null)}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>Photo Details</DialogTitle>
          </DialogHeader>
          {selectedPhoto && (
            <div className="space-y-4">
              <div className="bg-muted rounded-md overflow-hidden">
                <img 
                  src={selectedPhoto.imageUrl} 
                  alt={selectedPhoto.notes || "Room photo"} 
                  className="w-full h-auto max-h-[60vh] object-contain"
                />
              </div>
              
              <div className="space-y-3">
                {selectedPhoto.uploadedDate && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Calendar className="h-4 w-4" />
                    <span>Uploaded {formatUploadDate(selectedPhoto.uploadedDate)}</span>
                  </div>
                )}
                <div>
                  <p className="text-sm text-muted-foreground mb-2">Notes</p>
                  {isEditingCaption && canManage ? (
                    <div className="space-y-2">
                      <Textarea 
                        value={editingCaption}
                        onChange={(e) => setEditingCaption(e.target.value)}
                        placeholder="Add notes about this photo..."
                        className="min-h-24"
                        data-testid="textarea-photo-notes"
                      />
                      <div className="flex gap-2">
                        <Button size="sm" onClick={handleSaveCaption} data-testid="button-save-notes">
                          <Save className="h-3 w-3 mr-1" />
                          Save
                        </Button>
                        <Button 
                          size="sm" 
                          variant="outline" 
                          onClick={() => {
                            setIsEditingCaption(false);
                            setEditingCaption(selectedPhoto.notes || "");
                          }}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div>
                      <p className="text-sm">{selectedPhoto.notes || "No notes"}</p>
                      {canManage && onUpdateCaption && (
                        <Button 
                          size="sm" 
                          variant="ghost" 
                          className="mt-2"
                          onClick={() => setIsEditingCaption(true)}
                          data-testid="button-edit-notes"
                        >
                          Edit Notes
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-4 border-t">
                <Button variant="outline" onClick={() => setSelectedPhoto(null)}>
                  Close
                </Button>
                {canManage && onDelete && (
                  <Button 
                    variant="destructive" 
                    onClick={() => {
                      onDelete(selectedPhoto.id);
                      setSelectedPhoto(null);
                    }}
                    data-testid="button-delete-photo"
                  >
                    <X className="h-4 w-4 mr-2" />
                    Delete
                  </Button>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
