import { useQuery } from "@tanstack/react-query";
import { History } from "lucide-react";

import { CONDITION_LABEL, type PreviousItem } from "@/lib/walkthrough";
import { formatDate } from "@/lib/format";
import type { WalkthroughPhoto } from "@shared/schema";

/**
 * What the last walkthrough said, shown beside this one's item while a
 * move-out is being captured. Read-only and collapsed by default, so the
 * screen stays one room at a time on a phone; one tap opens it.
 */
export function LastTimeItem({ previous, when, itemId }: { previous: PreviousItem | undefined; when: string; itemId: string }) {
  return (
    <details className="text-sm" data-testid={`details-last-time-${itemId}`}>
      <summary className="flex cursor-pointer items-center gap-1 text-muted-foreground">
        <History className="h-3.5 w-3.5" aria-hidden />
        Last time ({when})
        {previous ? `: ${CONDITION_LABEL[previous.condition]}` : ": not on that walkthrough"}
      </summary>
      {previous?.notes && (
        <p className="mt-1 whitespace-pre-line pl-5 text-muted-foreground" data-testid={`text-last-time-notes-${itemId}`}>
          {previous.notes}
        </p>
      )}
    </details>
  );
}

/**
 * Last time's photos of this room, for staff (walkthrough photos are
 * staff-only in both directions). Fetched only when opened.
 */
export function LastTimeRoomPhotos({ roomId, when }: { roomId: string; when: string }) {
  const { data: photos = [] } = useQuery<WalkthroughPhoto[]>({
    queryKey: ["/api/walkthrough-photos/room", roomId],
  });
  if (photos.length === 0) return null;
  return (
    <details className="text-sm" data-testid="details-last-time-photos">
      <summary className="flex cursor-pointer items-center gap-1 text-muted-foreground">
        <History className="h-3.5 w-3.5" aria-hidden />
        {photos.length} photo{photos.length === 1 ? "" : "s"} of this room from {when}
      </summary>
      <div className="mt-2 grid grid-cols-3 gap-2">
        {photos.map((photo) => (
          <img
            key={photo.id}
            src={photo.imageUrl}
            alt={photo.notes ?? `Photo from ${formatDate(photo.uploadedDate)}`}
            className="aspect-square w-full rounded-md object-cover"
            loading="lazy"
          />
        ))}
      </div>
    </details>
  );
}
