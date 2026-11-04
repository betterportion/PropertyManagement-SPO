import { X } from "lucide-react";
import { formatDate } from "@/lib/format";
import type { WalkthroughPhoto } from "@shared/schema";

/**
 * One walkthrough photo as a thumbnail with its date underneath.
 *
 * Shared by the room screen and the year-over-year comparison so a photo
 * looks the same wherever it turns up. The date is the upload date -- the
 * closest thing a photo has to "when this was taken". `onRemove` adds the
 * small remove button in the corner; the comparison passes none.
 */
export default function PhotoThumbnail({
  photo,
  alt,
  testId,
  onRemove,
}: {
  photo: Pick<WalkthroughPhoto, "id" | "imageUrl" | "notes" | "uploadedDate">;
  alt: string;
  testId: string;
  onRemove?: () => void;
}) {
  return (
    <figure className="relative overflow-hidden rounded-md border border-border" data-testid={testId}>
      <img
        src={photo.imageUrl}
        alt={photo.notes || alt}
        className="aspect-square w-full object-cover"
        loading="lazy"
      />
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove photo"
          className="absolute right-1.5 top-1.5 flex h-8 w-8 items-center justify-center rounded-md bg-background/90 text-foreground shadow-sm transition-colors hover:bg-destructive hover:text-destructive-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid={`button-remove-${testId}`}
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      )}
      <figcaption className="border-t border-border bg-background px-2 py-1 text-xs text-muted-foreground">
        {formatDate(photo.uploadedDate)}
      </figcaption>
    </figure>
  );
}
