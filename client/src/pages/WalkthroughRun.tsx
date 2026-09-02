import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link, useParams } from "wouter";
import { ArrowLeft, ArrowRight, ChevronLeft, DoorOpen, ListChecks } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import RoomChecklist from "@/components/walkthrough/RoomChecklist";
import RoomPhotos from "@/components/walkthrough/RoomPhotos";
import RoomSwitcher from "@/components/walkthrough/RoomSwitcher";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { formatDate } from "@/lib/format";
import {
  WALKTHROUGH_STATUS_BADGE,
  WALKTHROUGH_TYPE_LABEL,
  canManageWalkthroughs,
  itemsByRoom,
  progressOf,
  type WalkthroughUser,
} from "@/lib/walkthrough";
import type { Walkthrough, WalkthroughItem, WalkthroughRoom } from "@shared/schema";

/**
 * Filling in one walkthrough, one room at a time.
 *
 * Built for a student standing in a house holding a phone in one hand. That
 * shapes every decision here:
 *
 *   - One room fills the screen. Nothing scrolls sideways and nothing needs
 *     pinching.
 *   - Rooms are reachable in any order. Houses are not walked in list order.
 *   - Every tap is written to the server as it happens and the walkthrough
 *     stays a `draft` until somebody says otherwise, so a locked phone, a dead
 *     battery or a closed tab costs nothing.
 *
 * There is no separate save step and no client-side draft. "Submit" only
 * changes the status.
 */

export default function WalkthroughRun() {
  const params = useParams<{ id: string }>();
  const walkthroughId = params.id;
  const { user } = useAuth();
  const { toast } = useToast();

  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
  const [isSwitcherOpen, setIsSwitcherOpen] = useState(false);
  const [isFinishOpen, setIsFinishOpen] = useState(false);

  const typedUser = user as (WalkthroughUser & { email?: string }) | null;

  // The guard is computed, never returned early on: a return placed above the
  // queries below would change the hook count the moment the auth query
  // resolves, and React throws. This crashed the Settings page once.
  const canManage = canManageWalkthroughs(typedUser);

  const {
    data: walkthrough,
    isLoading: walkthroughLoading,
    isError: walkthroughError,
  } = useQuery<Walkthrough>({
    queryKey: ["/api/walkthroughs", walkthroughId],
    enabled: !!walkthroughId,
  });

  const { data: rooms = [], isLoading: roomsLoading } = useQuery<WalkthroughRoom[]>({
    queryKey: ["/api/walkthroughs", walkthroughId, "rooms"],
    enabled: !!walkthroughId,
  });

  // The whole checklist in one request. Progress across the house, and which
  // rooms are still untouched, have to be readable before the RA opens
  // anything — and a phone should not make one round trip per room to find out.
  const { data: items = [], isLoading: itemsLoading } = useQuery<WalkthroughItem[]>({
    queryKey: ["/api/walkthroughs", walkthroughId, "items"],
    enabled: !!walkthroughId,
  });

  const grouped = useMemo(() => itemsByRoom(items), [items]);
  const itemsFor = (roomId: string) => grouped.get(roomId) ?? [];

  const overall = useMemo(() => progressOf(items), [items]);

  // Falls back to the first room rather than holding an id that has been
  // deleted, so removing the room you are standing in leaves you somewhere.
  const currentRoom =
    rooms.find((room) => room.id === activeRoomId) ?? rooms[0] ?? null;
  const currentIndex = currentRoom ? rooms.findIndex((room) => room.id === currentRoom.id) : -1;

  const submitWalkthrough = useMutation({
    mutationFn: async (status: Walkthrough["status"]) => {
      await apiRequest("PATCH", `/api/walkthroughs/${walkthroughId}`, { status });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/walkthroughs", walkthroughId] });
      queryClient.invalidateQueries({ queryKey: ["/api/walkthroughs"] });
      setIsFinishOpen(false);
      toast({ title: "Walkthrough submitted", description: "It is now on record for this house." });
    },
    onError: () => {
      toast({ variant: "destructive", title: "Not submitted", description: "The walkthrough could not be submitted." });
    },
  });

  const isLoading = walkthroughLoading || roomsLoading || itemsLoading;
  const status = walkthrough ? WALKTHROUGH_STATUS_BADGE[walkthrough.status] : null;

  let body: React.ReactNode;
  if (isLoading) {
    body = <LoadingState message="Loading this walkthrough..." />;
  } else if (walkthroughError || !walkthrough) {
    body = (
      <ErrorState message="This walkthrough could not be opened. It may have been deleted, or it belongs to a region you do not cover." />
    );
  } else if (!currentRoom) {
    body = (
      <EmptyState
        icon={DoorOpen}
        title="This walkthrough has no rooms yet"
        description="Add the first room and it will start with the usual items for that kind of room."
        action={
          canManage ? (
            <Button variant="primary" onClick={() => setIsSwitcherOpen(true)} data-testid="button-add-first-room">
              Add a room
            </Button>
          ) : undefined
        }
      />
    );
  } else {
    const roomItems = itemsFor(currentRoom.id);
    const roomProgress = progressOf(roomItems);
    body = (
      <div className="space-y-6">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-2xl font-semibold tracking-tight" data-testid="text-current-room">
            {currentRoom.name}
          </h2>
          <p className="shrink-0 text-sm text-muted-foreground" data-testid="text-room-progress">
            {roomProgress.assessed} of {roomProgress.total} checked
          </p>
        </div>

        <RoomChecklist
          walkthroughId={walkthroughId}
          roomId={currentRoom.id}
          items={roomItems}
          canManage={canManage}
        />

        <RoomPhotos
          walkthrough={walkthrough}
          room={currentRoom}
          canManage={canManage}
          uploaderEmail={typedUser?.email ?? ""}
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-full flex-col">
      {/* Sticky, so the progress and the way out of a room are always in reach
          without scrolling back up a long checklist. */}
      <header className="sticky top-0 z-10 border-b border-border bg-background/95 backdrop-blur">
        <div className="mx-auto w-full max-w-3xl space-y-3 px-4 py-3">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" asChild aria-label="Back to walkthroughs">
              <Link href="/walkthroughs" data-testid="link-back-to-walkthroughs">
                <ChevronLeft className="h-5 w-5" />
              </Link>
            </Button>
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold leading-tight" data-testid="text-walkthrough-address">
                {walkthrough?.buildingAddress ?? "Walkthrough"}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {walkthrough
                  ? `${WALKTHROUGH_TYPE_LABEL[walkthrough.type]} · ${formatDate(walkthrough.walkthroughDate)}`
                  : ""}
              </p>
            </div>
            {status && (
              <Badge variant={status.variant} data-testid="badge-walkthrough-status">
                {status.label}
              </Badge>
            )}
          </div>

          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span data-testid="text-overall-progress">
                {overall.assessed} of {overall.total} items checked
              </span>
              {overall.flagged > 0 && (
                <span className="font-medium text-amber-700 dark:text-amber-400" data-testid="text-flagged-count">
                  {overall.flagged} need{overall.flagged === 1 ? "s" : ""} attention
                </span>
              )}
            </div>
            <div
              className="h-2 w-full overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-valuenow={overall.percent}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Walkthrough progress"
            >
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{ width: `${overall.percent}%` }}
              />
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              className="flex-1"
              onClick={() => setIsSwitcherOpen(true)}
              data-testid="button-open-rooms"
            >
              <ListChecks className="h-4 w-4" />
              {currentRoom ? `Room ${currentIndex + 1} of ${rooms.length}` : "Rooms"}
            </Button>
            {canManage && walkthrough?.status === "draft" && (
              <Button
                variant="primary"
                size="sm"
                onClick={() => setIsFinishOpen(true)}
                data-testid="button-open-finish"
              >
                Finish
              </Button>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">{body}</main>

      {currentRoom && rooms.length > 1 && (
        <footer className="sticky bottom-0 border-t border-border bg-background/95 backdrop-blur">
          <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-2 px-4 py-3">
            <Button
              variant="secondary"
              disabled={currentIndex <= 0}
              onClick={() => setActiveRoomId(rooms[currentIndex - 1].id)}
              data-testid="button-previous-room"
            >
              <ArrowLeft className="h-4 w-4" />
              Previous
            </Button>
            <Button
              variant="secondary"
              disabled={currentIndex >= rooms.length - 1}
              onClick={() => setActiveRoomId(rooms[currentIndex + 1].id)}
              data-testid="button-next-room"
            >
              Next
              <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </footer>
      )}

      <RoomSwitcher
        open={isSwitcherOpen}
        onOpenChange={setIsSwitcherOpen}
        walkthroughId={walkthroughId}
        rooms={rooms}
        itemsFor={itemsFor}
        currentRoomId={currentRoom?.id ?? null}
        onSelectRoom={setActiveRoomId}
        canManage={canManage}
      />

      <Dialog open={isFinishOpen} onOpenChange={setIsFinishOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Submit this walkthrough?</DialogTitle>
            <DialogDescription>
              {overall.assessed === overall.total
                ? "Everything on the checklist has been recorded."
                : `${overall.total - overall.assessed} item${overall.total - overall.assessed === 1 ? " has" : "s have"} not been checked. You can still submit, and anything left will show as "Not checked".`}
            </DialogDescription>
          </DialogHeader>
          {overall.flagged > 0 && (
            <p className="text-sm text-amber-700 dark:text-amber-400" data-testid="text-finish-flagged">
              {overall.flagged} item{overall.flagged === 1 ? " is" : "s are"} marked poor or damaged.
            </p>
          )}
          <DialogFooter>
            <Button variant="secondary" onClick={() => setIsFinishOpen(false)} data-testid="button-cancel-finish">
              Keep working
            </Button>
            <Button
              variant="primary"
              disabled={submitWalkthrough.isPending}
              onClick={() => submitWalkthrough.mutate("submitted")}
              data-testid="button-submit-walkthrough"
            >
              {submitWalkthrough.isPending ? "Submitting…" : "Submit"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
