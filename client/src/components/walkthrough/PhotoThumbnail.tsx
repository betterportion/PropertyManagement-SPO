import { formatDate } from "@/lib/format";
import type { WalkthroughPhoto } from "@shared/schema";

/**
 * One walkthrough photo as a thumbnail with its date underneath.
 *
 * Shared by the room screen and the year-over-year comparison so a photo
 * looks the same wherever it turns up. The date is the upload date -- the
 * closest thing a photo has to "when this was taken".
 */
export default function PhotoThumbnail({
  photo,
  alt,
  testId,
}: {
  photo: Pick<WalkthroughPhoto, "id" | "imageUrl" | "notes" | "uploadedDate">;
  alt: string;
  testId: string;
}) {
  return (
    <figure className="overflow-hidden rounded-md border border-border" data-testid={testId}>
      <img
        src={photo.imageUrl}
        alt={photo.notes || alt}
        className="aspect-square w-full object-cover"
        loading="lazy"
      />
      <figcaption className="border-t border-border bg-background px-2 py-1 text-xs text-muted-foreground">
        {formatDate(photo.uploadedDate)}
      </figcaption>
    </figure>
  );
}
