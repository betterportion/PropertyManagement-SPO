import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Check, CircleDashed, CircleDot, DoorOpen, Plus, Trash2 } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { progressOf, roomStatus, type RoomStatus } from "@/lib/walkthrough";
import { cn } from "@/lib/utils";
import type { WalkthroughItem, WalkthroughRoom, WalkthroughTemplateRoom } from "@shared/schema";

/**
 * The room list, and the only way to move between rooms other than "next".
 *
 * Rooms are never locked. An RA walks the house in whatever order the house
 * allows — the kitchen is occupied, so do the porch first — and a screen that
 * insists on finishing one room before the next is a screen that gets
 * abandoned halfway.
 */

const STATUS_STYLE: Record<RoomStatus, { label: string; icon: typeof Check; className: string }> = {
  done: {
    label: "Done",
    icon: Check,
    className: "text-emerald-700 dark:text-emerald-400",
  },
  partial: {
    label: "Started",
    icon: CircleDot,
    className: "text-amber-700 dark:text-amber-400",
  },
  todo: {
    label: "Not started",
    icon: CircleDashed,
    className: "text-muted-foreground",
  },
  empty: {
    label: "No items",
    icon: CircleDashed,
    className: "text-muted-foreground",
  },
};

interface RoomSwitcherProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  walkthroughId: string;
  rooms: WalkthroughRoom[];
  itemsFor: (roomId: string) => WalkthroughItem[];
  currentRoomId: string | null;
  onSelectRoom: (roomId: string) => void;
  canManage: boolean;
}

export default function RoomSwitcher({
  open,
  onOpenChange,
  walkthroughId,
  rooms,
  itemsFor,
  currentRoomId,
  onSelectRoom,
  canManage,
}: RoomSwitcherProps) {
  const { toast } = useToast();
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [roomToDelete, setRoomToDelete] = useState<WalkthroughRoom | null>(null);
  const [templateRoomId, setTemplateRoomId] = useState("");
  const [customName, setCustomName] = useState("");

  // The catalogue of known room types. Every one of these prefills its own
  // standard items, which is the whole reason to pick from a list rather than
  // type a name.
  const { data: templateRooms = [] } = useQuery<WalkthroughTemplateRoom[]>({
    queryKey: ["/api/walkthrough-template/rooms"],
    enabled: canManage,
  });

  const roomsKey = ["/api/walkthroughs", walkthroughId, "rooms"] as const;
  const itemsKey = ["/api/walkthroughs", walkthroughId, "items"] as const;

  const addRoom = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", `/api/walkthroughs/${walkthroughId}/rooms`, {
        templateRoomId: templateRoomId || undefined,
        name: customName.trim() || undefined,
      });
      return (await response.json()) as WalkthroughRoom & { itemsCreated: number };
    },
    onSuccess: (room) => {
      queryClient.invalidateQueries({ queryKey: roomsKey });
      queryClient.invalidateQueries({ queryKey: itemsKey });
      setIsAddOpen(false);
      setTemplateRoomId("");
      setCustomName("");
      onSelectRoom(room.id);
      onOpenChange(false);
      toast({
        title: `${room.name} added`,
        description: room.itemsCreated > 0
          ? `Started with ${room.itemsCreated} standard item${room.itemsCreated === 1 ? "" : "s"}. Remove anything this house does not have.`
          : "Add what should be checked in this room.",
      });
    },
    onError: () => {
      toast({ variant: "destructive", title: "Not added", description: "That room could not be added." });
    },
  });

  const deleteRoom = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/walkthrough-rooms/${id}`);
    },
    onSuccess: (_result, id) => {
      queryClient.invalidateQueries({ queryKey: roomsKey });
      queryClient.invalidateQueries({ queryKey: itemsKey });
      setRoomToDelete(null);
      if (id === currentRoomId) {
        const next = rooms.find((room) => room.id !== id);
        if (next) onSelectRoom(next.id);
      }
    },
    onError: () => {
      toast({ variant: "destructive", title: "Not removed", description: "That room could not be removed." });
    },
  });

  const canSubmitRoom = Boolean(templateRoomId || customName.trim());

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="left" className="w-full overflow-y-auto sm:max-w-sm">
          <SheetHeader>
            <SheetTitle>Rooms</SheetTitle>
            <SheetDescription>Go to any room. Nothing has to be finished first.</SheetDescription>
          </SheetHeader>

          <ul className="mt-4 space-y-2">
            {rooms.map((room) => {
              const items = itemsFor(room.id);
              const { assessed, total } = progressOf(items);
              const status = STATUS_STYLE[roomStatus(items)];
              const StatusIcon = status.icon;
              return (
                <li key={room.id} className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      onSelectRoom(room.id);
                      onOpenChange(false);
                    }}
                    aria-current={room.id === currentRoomId ? "true" : undefined}
                    className={cn(
                      "flex min-h-14 flex-1 items-center gap-3 rounded-md border px-3 py-2 text-left",
                      room.id === currentRoomId
                        ? "border-primary bg-primary/10"
                        : "border-border hover:bg-muted",
                    )}
                    data-testid={`button-goto-room-${room.id}`}
                  >
                    <DoorOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{room.name}</span>
                      <span className={cn("flex items-center gap-1 text-xs", status.className)}>
                        <StatusIcon className="h-3 w-3" />
                        {status.label} · {assessed} of {total}
                      </span>
                    </span>
                  </button>
                  {canManage && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove ${room.name}`}
                      onClick={() => setRoomToDelete(room)}
                      data-testid={`button-delete-room-${room.id}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>

          {canManage && (
            <Button
              type="button"
              variant="secondary"
              className="mt-4 w-full"
              onClick={() => setIsAddOpen(true)}
              data-testid="button-open-add-room"
            >
              <Plus className="h-4 w-4" />
              Add a room
            </Button>
          )}
        </SheetContent>
      </Sheet>

      <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add a room</DialogTitle>
            <DialogDescription>
              Pick a room type and it starts with the usual items for that room. Anything this
              house does not have can be removed afterwards.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="room-type">Room type</Label>
              <Select value={templateRoomId} onValueChange={setTemplateRoomId}>
                <SelectTrigger id="room-type" data-testid="select-room-type">
                  <SelectValue placeholder="Choose a room type" />
                </SelectTrigger>
                <SelectContent>
                  {templateRooms.map((templateRoom) => (
                    <SelectItem key={templateRoom.id} value={templateRoom.id}>
                      {templateRoom.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="room-name">
                Name <span className="text-xs text-muted-foreground">(optional — two bathrooms need telling apart)</span>
              </Label>
              <Input
                id="room-name"
                value={customName}
                onChange={(event) => setCustomName(event.target.value)}
                placeholder="Upstairs bathroom"
                data-testid="input-room-name"
              />
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setIsAddOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="primary"
              disabled={!canSubmitRoom || addRoom.isPending}
              onClick={() => addRoom.mutate()}
              data-testid="button-submit-room"
            >
              {addRoom.isPending ? "Adding…" : "Add room"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!roomToDelete} onOpenChange={(next) => !next && setRoomToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {roomToDelete?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Everything recorded for this room in this walkthrough goes with it — the items,
              their conditions and notes, and any photos. Earlier walkthroughs are not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete-room">Keep it</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => roomToDelete && deleteRoom.mutate(roomToDelete.id)}
              data-testid="button-confirm-delete-room"
            >
              Remove the room
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
