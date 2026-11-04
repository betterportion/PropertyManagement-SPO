import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { PhotoUpload } from "@/components/PhotoUpload";
import { buttonVariants } from "@/components/ui/button";
import PhotoThumbnail from "@/components/walkthrough/PhotoThumbnail";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { serverMessage } from "@/lib/serverMessage";
import type { Walkthrough, WalkthroughPhoto, WalkthroughRoom } from "@shared/schema";

/**
 * The photos filed against the room currently on screen.
 *
 * Photos are per room rather than per item on purpose: an RA taking a picture
 * of a damaged wall is documenting the room, and asking them to pick which
 * checklist line it belongs to first is how photos stop being taken.
 *
 * Up to five can be picked at once, and staff can remove one added by
 * mistake. The server keeps the file while a repair still references it.
 */

const MAX_PHOTOS_AT_ONCE = 5;

interface RoomPhotosProps {
  walkthrough: Walkthrough;
  room: WalkthroughRoom;
  canManage: boolean;
  uploaderEmail: string;
}

export default function RoomPhotos({ walkthrough, room, canManage, uploaderEmail }: RoomPhotosProps) {
  const { toast } = useToast();
  const [removing, setRemoving] = useState<WalkthroughPhoto | null>(null);

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
      queryClient.invalidateQueries({ queryKey: photosKey });
      queryClient.invalidateQueries({ queryKey: ["/api/walkthrough-photos"] });
    },
    onError: (error) => {
      toast({ variant: "destructive", title: "Not saved", description: serverMessage(error) ?? "The photo uploaded but could not be filed against this room." });
    },
  });

  const removePhoto = useMutation({
    mutationFn: async (photoId: string) => {
      await apiRequest("DELETE", `/api/walkthrough-photos/${photoId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: photosKey });
      queryClient.invalidateQueries({ queryKey: ["/api/walkthrough-photos"] });
      toast({ title: "Photo removed" });
    },
    onError: (error) => {
      toast({ variant: "destructive", title: "Not removed", description: serverMessage(error) ?? "The photo could not be removed." });
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
            <PhotoThumbnail
              key={photo.id}
              photo={photo}
              alt={`${room.name} photo`}
              testId={`photo-${photo.id}`}
              onRemove={canManage ? () => setRemoving(photo) : undefined}
            />
          ))}
        </div>
      )}

      {canManage && (
        <PhotoUpload
          maxFiles={MAX_PHOTOS_AT_ONCE}
          onUpload={(url) => createPhoto.mutate(url)}
          onError={(message) => toast({ variant: "destructive", title: "Upload failed", description: message })}
        />
      )}

      <AlertDialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this photo?</AlertDialogTitle>
            <AlertDialogDescription>
              It comes off this walkthrough for good. A repair it was already sent with keeps it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-remove-photo">Keep it</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => removing && removePhoto.mutate(removing.id)}
              className={buttonVariants({ variant: "destructive" })}
              data-testid="button-confirm-remove-photo"
            >
              Remove photo
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
