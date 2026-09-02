import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { X } from "lucide-react";
import { PhotoUpload } from "@/components/PhotoUpload";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { formatDate } from "@/lib/format";
import type { Walkthrough, WalkthroughPhoto, WalkthroughRoom } from "@shared/schema";

/**
 * The photos filed against the room currently on screen.
 *
 * Photos are per room rather than per item on purpose: an RA taking a picture
 * of a damaged wall is documenting the room, and asking them to pick which
 * checklist line it belongs to first is how photos stop being taken.
 *
 * The delete control is always visible. The existing gallery reveals it on
 * hover, which on a phone means never.
 */

interface RoomPhotosProps {
  walkthrough: Walkthrough;
  room: WalkthroughRoom;
  canManage: boolean;
  uploaderEmail: string;
}

export default function RoomPhotos({ walkthrough, room, canManage, uploaderEmail }: RoomPhotosProps) {
  const { toast } = useToast();
  // Bumped after each upload so the picker clears its preview and is ready for
  // the next photo, rather than sitting on the one just sent.
  const [uploadKey, setUploadKey] = useState(0);

  const photosKey = ["/api/walkthrough-photos/room", room.id] as const;

  const { data: photos = [] } = useQuery<WalkthroughPhoto[]>({ queryKey: photosKey });

  const createPhoto = useMutation({
    mutationFn: async (imageUrl: string) => {
      // The legacy `condition` column on a photo records *change* since the
      // last visit, not state, so a new photo deliberately leaves it unset.
      await apiRequest("POST", "/api/walkthrough-photos", {
        roomId: room.id,
        imageUrl,
        region: walkthrough.region,
        buildingAddress: walkthrough.buildingAddress,
        location: room.name,
        uploadedBy: uploaderEmail,
      });
    },
    onSuccess: () => {
      setUploadKey((key) => key + 1);
      queryClient.invalidateQueries({ queryKey: photosKey });
    },
    onError: () => {
      toast({ variant: "destructive", title: "Not saved", description: "The photo uploaded but could not be filed against this room." });
    },
  });

  const deletePhoto = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/walkthrough-photos/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: photosKey });
    },
    onError: () => {
      toast({ variant: "destructive", title: "Not removed", description: "That photo could not be removed." });
    },
  });

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-muted-foreground">
        Photos of {room.name}
        {photos.length > 0 && ` (${photos.length})`}
      </h3>

      {photos.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {photos.map((photo) => (
            <figure key={photo.id} className="relative overflow-hidden rounded-md border border-border" data-testid={`photo-${photo.id}`}>
              <img
                src={photo.imageUrl}
                alt={photo.notes || `${room.name} photo`}
                className="aspect-square w-full object-cover"
                loading="lazy"
              />
              {canManage && (
                <Button
                  type="button"
                  variant="destructive"
                  size="icon"
                  className="absolute right-1 top-1 h-8 w-8"
                  aria-label="Remove this photo"
                  onClick={() => deletePhoto.mutate(photo.id)}
                  data-testid={`button-delete-photo-${photo.id}`}
                >
                  <X className="h-4 w-4" />
                </Button>
              )}
              <figcaption className="border-t border-border bg-background px-2 py-1 text-xs text-muted-foreground">
                {formatDate(photo.uploadedDate)}
              </figcaption>
            </figure>
          ))}
        </div>
      )}

      {canManage && (
        <PhotoUpload
          key={uploadKey}
          onUpload={(url) => createPhoto.mutate(url)}
          onError={(message) => toast({ variant: "destructive", title: "Upload failed", description: message })}
          disabled={createPhoto.isPending}
        />
      )}
    </div>
  );
}
