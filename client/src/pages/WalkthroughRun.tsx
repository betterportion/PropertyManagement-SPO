import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useParams } from "wouter";
import { ArrowLeft, ArrowRight, CheckCircle2, ChevronLeft, DoorOpen, ListChecks } from "lucide-react";

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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  canFillInWalkthroughs,
  canSeeWalkthroughPhotos,
  canWriteWalkthrough,
  isResidentAccount,
  itemsByRoom,
  progressOf,
  type WalkthroughUser,
  canRemoveWalkthroughItems,
  canReviewWalkthrough,
  canSubmitWalkthrough,
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
 *     stays a `draft`, so a locked phone, a dead battery or a closed tab costs
 *     nothing.
 *
 * There is no separate save step and no client-side draft. Nothing here moves
 * a walkthrough out of `draft` -- the plan has not asked for that yet, and the
 * status badge below only reports what the record already says.
 */

export default function WalkthroughRun() {
  const params = useParams<{ id: string }>();
  const walkthroughId = params.id;
  const { user } = useAuth();

  // Seeded from `?room=` so the flagged-items list can link straight to the
  // room an item came from. Read once, not tracked: after the first render the
  // room switcher owns this, and re-reading the URL would fight it.
  const [activeRoomId, setActiveRoomId] = useState<string | null>(
    () => new URLSearchParams(window.location.search).get("room"),
  );
  const [isSwitcherOpen, setIsSwitcherOpen] = useState(false);

  const typedUser = user as (WalkthroughUser & { email?: string }) | null;

  // Every guard here is computed, never returned early on: a return placed
  // above the queries below would change the hook count the moment the auth
  // query resolves, and React throws. This crashed the Settings page once.
  //
  // Photos stay with staff. A resident cannot upload a file outside a
  // maintenance request, and cannot read a walkthrough photo back either, so
  // the section is hidden rather than shown and refused on every request.
  const showPhotos = canSeeWalkthroughPhotos(typedUser);
  // A resident-tier account is bound to their own house, never to a region, so
  // the two tiers are told different things about why one would not open.
  const isResidentTier = isResidentAccount(typedUser);

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

  // A leader's prior years are read-only, and knowing which year this is means
  // knowing what else their house has. `/api/walkthroughs` is already scoped to
  // their own house by the server, so this is one small request and only for
  // the tier that needs it -- staff writability does not depend on it.
  const { data: houseWalkthroughs = [] } = useQuery<Walkthrough[]>({
    queryKey: ["/api/walkthroughs"],
    enabled: isResidentTier && canFillInWalkthroughs(typedUser),
  });

  // Whether the controls belong on screen at all, for THIS walkthrough.
  const canManage = canWriteWalkthrough(typedUser, walkthrough, houseWalkthroughs);
  // Removing an item is staff work; a leader asks their RA.
  const canRemove = canManage && canRemoveWalkthroughItems(typedUser);
  // Disabled controls with no explanation read as a broken page. Say why.
  const isReadOnlyPriorYear =
    isResidentTier && canFillInWalkthroughs(typedUser) && !!walkthrough && !canManage;

  const grouped = useMemo(() => itemsByRoom(items), [items]);
  const itemsFor = (roomId: string) => grouped.get(roomId) ?? [];

  const overall = useMemo(() => progressOf(items), [items]);

  // Falls back to the first room rather than holding an id that has been
  // deleted, so removing the room you are standing in leaves you somewhere.
  const currentRoom =
    rooms.find((room) => room.id === activeRoomId) ?? rooms[0] ?? null;
  const currentIndex = currentRoom ? rooms.findIndex((room) => room.id === currentRoom.id) : -1;
  const isFirstRoom = currentIndex <= 0;
  const isLastRoom = currentIndex >= rooms.length - 1;

  // The two things that move a walkthrough on. Submitting says the house has
  // been walked; reviewing is staff reading it over. Neither locks editing.
  const { toast } = useToast();
  const [isSubmitOpen, setIsSubmitOpen] = useState(false);
  const canSubmit = canSubmitWalkthrough(typedUser, walkthrough, houseWalkthroughs);
  const canReview = canReviewWalkthrough(typedUser, walkthrough);
  const moveOn = useMutation({
    mutationFn: async (step: "submit" | "review") => {
      await apiRequest("POST", `/api/walkthroughs/${walkthroughId}/${step}`);
      return step;
    },
    onSuccess: (step) => {
      queryClient.invalidateQueries({ queryKey: ["/api/walkthroughs", walkthroughId] });
      queryClient.invalidateQueries({ queryKey: ["/api/walkthroughs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/walkthrough-flagged-items"] });
      setIsSubmitOpen(false);
      toast({
        title: step === "submit" ? "Submitted" : "Marked reviewed",
        description: step === "submit" ? "Conditions and notes can still be changed." : undefined,
      });
    },
    onError: () => {
      setIsSubmitOpen(false);
      toast({ variant: "destructive", title: "Not saved", description: "That did not go through. Try again in a moment." });
    },
  });

  const isLoading = walkthroughLoading || roomsLoading || itemsLoading;
  const status = walkthrough ? WALKTHROUGH_STATUS_BADGE[walkthrough.status] : null;

  let body: React.ReactNode;
  if (isLoading) {
    body = <LoadingState message="Loading this walkthrough..." />;
  } else if (walkthroughError || !walkthrough) {
    body = (
      <ErrorState
        message={
          isResidentTier
            ? "This walkthrough could not be opened. It may have been deleted, or it belongs to a house other than yours."
            : "This walkthrough could not be opened. It may have been deleted, or it belongs to a region you do not cover."
        }
      />
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
        {isReadOnlyPriorYear && (
          <p
            className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground"
            data-testid="text-read-only-notice"
          >
            This is an earlier walkthrough of your house, so it can be read but not changed. Your
            most recent one is the one to fill in.
          </p>
        )}
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-2xl font-semibold tracking-tight" data-testid="text-current-room">
            {currentRoom.name}
          </h2>
          <p className="shrink-0 text-sm text-muted-foreground" data-testid="text-room-progress">
            {roomProgress.assessed} of {roomProgress.total} checked
          </p>
        </div>

        <RoomChecklist walkthroughId={walkthroughId} items={roomItems} canManage={canManage} canRemove={canRemove} />

        {showPhotos && (
          <RoomPhotos
            walkthrough={walkthrough}
            room={currentRoom}
            canManage={canManage}
            uploaderEmail={typedUser?.email ?? ""}
          />
        )}
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
            {canSubmit && (
              <Button variant="primary" size="sm" onClick={() => setIsSubmitOpen(true)} data-testid="button-submit-walkthrough">
                <CheckCircle2 className="h-4 w-4" />
                Mark submitted
              </Button>
            )}
            {canReview && (
              <Button
                variant="primary"
                size="sm"
                disabled={moveOn.isPending}
                onClick={() => moveOn.mutate("review")}
                data-testid="button-review-walkthrough"
              >
                <CheckCircle2 className="h-4 w-4" />
                {moveOn.isPending ? "Saving…" : "Mark reviewed"}
              </Button>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">{body}</main>

      {currentRoom && rooms.length > 1 && (
        <footer className="sticky bottom-0 border-t border-border bg-background/95 backdrop-blur">
          {isLastRoom && (
            <p
              className="mx-auto w-full max-w-3xl px-4 pt-3 text-center text-sm text-muted-foreground"
              data-testid="text-last-room"
            >
              This is the last room. Everything you tap is saved as you go — use Rooms to check any you skipped.
            </p>
          )}
          <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-2 px-4 py-3">
            {/* A disabled button says why. "Next" going grey on the last room
                read as the app refusing to finish, because nothing else on
                this screen says the house is done. */}
            <Button
              variant="secondary"
              disabled={isFirstRoom}
              onClick={() => setActiveRoomId(rooms[currentIndex - 1].id)}
              data-testid="button-previous-room"
            >
              <ArrowLeft className="h-4 w-4" />
              {isFirstRoom ? "First room" : "Previous"}
            </Button>
            <Button
              variant="secondary"
              disabled={isLastRoom}
              onClick={() => setActiveRoomId(rooms[currentIndex + 1].id)}
              data-testid="button-next-room"
            >
              {isLastRoom ? "Last room" : "Next"}
              <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </footer>
      )}

      <AlertDialog open={isSubmitOpen} onOpenChange={setIsSubmitOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Mark this walkthrough submitted?</AlertDialogTitle>
            <AlertDialogDescription>
              This says the house has been walked. Conditions and notes can still be changed
              afterwards, and your regional administrator will read it over.
              {overall.total > 0 && overall.assessed < overall.total
                ? ` ${overall.total - overall.assessed} item${overall.total - overall.assessed === 1 ? " has" : "s have"} not been checked yet.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Not yet</AlertDialogCancel>
            <AlertDialogAction
              disabled={moveOn.isPending}
              onClick={(event) => {
                event.preventDefault();
                moveOn.mutate("submit");
              }}
              data-testid="button-confirm-submit-walkthrough"
            >
              {moveOn.isPending ? "Saving…" : "Mark submitted"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <RoomSwitcher
        open={isSwitcherOpen}
        onOpenChange={setIsSwitcherOpen}
        walkthroughId={walkthroughId}
        rooms={rooms}
        itemsFor={itemsFor}
        currentRoomId={currentRoom?.id ?? null}
        onSelectRoom={setActiveRoomId}
        canManage={canManage}
        canRemove={canRemove}
      />
    </div>
  );
}
