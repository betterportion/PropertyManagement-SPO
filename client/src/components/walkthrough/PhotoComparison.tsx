import { useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";

import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { LoadingState } from "@/components/states";
import PhotoThumbnail from "@/components/walkthrough/PhotoThumbnail";
import { formatDate } from "@/lib/format";
import { WALKTHROUGH_TYPE_LABEL, comparePhotosByRoom } from "@/lib/walkthrough";
import type { Walkthrough, WalkthroughPhoto, WalkthroughRoom } from "@shared/schema";

/**
 * One room's photos from each of a house's walkthroughs, side by side.
 *
 * This is the reason the photos are worth taking: "has that crack grown" is
 * answered by looking at this year's wall next to last year's. It is a view
 * over data that already exists -- the walkthroughs, their rooms and the
 * rooms' photos -- and stores nothing.
 *
 * Read from the routes that already exist rather than a new one: the rooms of
 * each walkthrough (one request per visit, and a house has a handful), and
 * the staff photo list, which is region-wide and narrowed to this house by
 * `comparePhotosByRoom`. Staff only by construction: it sits on the staff
 * index, and the photo list refuses a resident account outright.
 *
 * The copy at the top is not decoration. Two photos of the same room from
 * different corners compare nothing, and no amount of software fixes that.
 */
export default function PhotoComparison({ walkthroughs }: { walkthroughs: Walkthrough[] }) {
  const [roomKey, setRoomKey] = useState<string | null>(null);

  const { rooms, roomsLoading } = useQueries({
    queries: walkthroughs.map((walkthrough) => ({
      queryKey: ["/api/walkthroughs", walkthrough.id, "rooms"] as const,
    })),
    combine: (results) => ({
      rooms: results.flatMap((result) => (result.data as WalkthroughRoom[] | undefined) ?? []),
      roomsLoading: results.some((result) => result.isLoading),
    }),
  });
  const { data: photos = [], isLoading: photosLoading } = useQuery<WalkthroughPhoto[]>({
    queryKey: ["/api/walkthrough-photos"],
  });

  const rows = comparePhotosByRoom(walkthroughs, rooms, photos);

  // Derived rather than reset in an effect: a picked room that no longer
  // exists (the house changed under us) falls back to the first one.
  const activeRow = rows.find((row) => row.key === roomKey) ?? rows[0];

  return (
    <section className="space-y-4" data-testid="section-photo-comparison">
      <div>
        <h2 className="text-lg font-semibold">Compare photos across years</h2>
        <p className="text-sm text-muted-foreground">
          This only answers &lsquo;has that crack grown&rsquo; if somebody photographs the same wall each year.
        </p>
      </div>

      {roomsLoading || photosLoading ? (
        <LoadingState message="Loading photos..." />
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">None of this house&rsquo;s walkthroughs has a room to compare yet.</p>
      ) : (
        <>
          <div className="max-w-xs space-y-2">
            <Label htmlFor="compare-room">Room</Label>
            <Select value={activeRow.key} onValueChange={setRoomKey}>
              <SelectTrigger id="compare-room" data-testid="select-compare-room">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {rows.map((row) => (
                  <SelectItem key={row.key} value={row.key}>
                    {row.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="overflow-x-auto">
            <div className="flex gap-4">
              {activeRow.columns.map((column) => {
                const walkthrough = walkthroughs.find((candidate) => candidate.id === column.walkthroughId);
                return (
                  <div
                    key={column.walkthroughId}
                    className="w-56 flex-shrink-0 space-y-2"
                    data-testid={`compare-column-${column.walkthroughId}`}
                  >
                    <div>
                      <p className="font-semibold">{formatDate(column.date)}</p>
                      {walkthrough && (
                        <p className="text-xs text-muted-foreground">{WALKTHROUGH_TYPE_LABEL[walkthrough.type]}</p>
                      )}
                    </div>
                    {column.photos.length === 0 ? (
                      <p className="rounded-md border border-dashed border-border p-3 text-sm text-muted-foreground">
                        No photos of this room that year
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {column.photos.map((photo) => (
                          <a
                            key={photo.id}
                            href={photo.imageUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="block"
                            aria-label={`Open ${activeRow.label} photo from ${formatDate(column.date)} full size`}
                          >
                            <PhotoThumbnail photo={photo} alt={`${activeRow.label} photo`} testId={`compare-photo-${photo.id}`} />
                          </a>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
