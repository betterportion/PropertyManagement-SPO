import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmptyState, LoadingState } from "@/components/states";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { WalkthroughTemplateItem, WalkthroughTemplateRoom } from "@shared/schema";

/**
 * The national walkthrough template.
 *
 * One template doing two jobs, which is why editing it is worth being careful
 * about: the rooms marked "start with this" seed a property's **first**
 * walkthrough, and every room is a known room **type** whose items prefill
 * when an RA adds one later.
 *
 * **Editing it never changes a walkthrough that already exists.** A
 * walkthrough owns *copies* of these rows, so this screen shapes what future
 * ones start from and nothing else. That is stated on screen, because it is
 * the question an admin will have before they touch anything.
 *
 * Admin-only, unlike `canManageWalkthroughs` — that flag is a grant over your
 * own houses, and this reaches every region.
 */
export default function WalkthroughTemplateSettings() {
  const { toast } = useToast();
  const [openRoomId, setOpenRoomId] = useState<string | null>(null);
  const [newRoomName, setNewRoomName] = useState("");
  const [newItemLabel, setNewItemLabel] = useState("");

  const { data: rooms = [], isLoading } = useQuery<WalkthroughTemplateRoom[]>({
    queryKey: ["/api/walkthrough-template/rooms"],
  });
  const { data: items = [] } = useQuery<WalkthroughTemplateItem[]>({
    queryKey: ["/api/walkthrough-template/items"],
  });

  const itemsByRoom = useMemo(() => {
    const grouped = new Map<string, WalkthroughTemplateItem[]>();
    for (const item of items) {
      const existing = grouped.get(item.templateRoomId);
      if (existing) existing.push(item);
      else grouped.set(item.templateRoomId, [item]);
    }
    for (const group of Array.from(grouped.values())) {
      group.sort((a, b) => a.displayOrder - b.displayOrder);
    }
    return grouped;
  }, [items]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/walkthrough-template/rooms"] });
    queryClient.invalidateQueries({ queryKey: ["/api/walkthrough-template/items"] });
  };

  const failed = (what: string) => () =>
    toast({ title: `That ${what} was not saved`, description: "Try again in a moment.", variant: "destructive" });

  const addRoom = useMutation({
    mutationFn: async () =>
      await apiRequest("POST", "/api/walkthrough-template/rooms", {
        name: newRoomName.trim(),
        includeByDefault: true,
        displayOrder: rooms.length,
      }),
    onSuccess: () => {
      invalidate();
      setNewRoomName("");
    },
    onError: failed("room"),
  });

  const setIncluded = useMutation({
    mutationFn: async (vars: { id: string; includeByDefault: boolean }) =>
      await apiRequest("PATCH", `/api/walkthrough-template/rooms/${vars.id}`, {
        includeByDefault: vars.includeByDefault,
      }),
    onSuccess: invalidate,
    onError: failed("change"),
  });

  const removeRoom = useMutation({
    mutationFn: async (id: string) => await apiRequest("DELETE", `/api/walkthrough-template/rooms/${id}`),
    onSuccess: invalidate,
    onError: failed("room"),
  });

  const addItem = useMutation({
    mutationFn: async (roomId: string) =>
      await apiRequest("POST", "/api/walkthrough-template/items", {
        templateRoomId: roomId,
        label: newItemLabel.trim(),
        displayOrder: (itemsByRoom.get(roomId) ?? []).length,
      }),
    onSuccess: () => {
      invalidate();
      setNewItemLabel("");
    },
    onError: failed("item"),
  });

  const removeItem = useMutation({
    mutationFn: async (id: string) => await apiRequest("DELETE", `/api/walkthrough-template/items/${id}`),
    onSuccess: invalidate,
    onError: failed("item"),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>The standard walkthrough checklist</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <p className="text-sm text-muted-foreground">
          What a house's <em>first</em> walkthrough starts with, and the items that fill in when an
          RA adds a room of that type later. <strong>Editing this never changes a walkthrough that
          already exists</strong> — each one keeps its own copy — and a repeat walkthrough copies
          that house's own last visit rather than this list.
        </p>
        <p className="text-sm text-muted-foreground">
          A room that is not ticked is still a known room <em>type</em> an RA can add; it just does
          not appear in a new house's first walkthrough. A garage is the usual example.
        </p>

        <div className="flex gap-2">
          <Input
            value={newRoomName}
            maxLength={100}
            placeholder="Add a room type, e.g. Porch"
            onChange={(event) => setNewRoomName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && newRoomName.trim()) addRoom.mutate();
            }}
            data-testid="input-template-room-name"
          />
          <Button
            variant="primary"
            disabled={newRoomName.trim().length === 0 || addRoom.isPending}
            onClick={() => addRoom.mutate()}
            data-testid="button-add-template-room"
          >
            <Plus className="h-4 w-4" />
            Add
          </Button>
        </div>

        {isLoading ? (
          <LoadingState message="Loading the template..." />
        ) : rooms.length === 0 ? (
          <EmptyState
            title="The template has no rooms yet"
            description="Add the rooms a house is normally walked through, then the items to check in each."
          />
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {rooms.map((room) => {
              const roomItems = itemsByRoom.get(room.id) ?? [];
              const isOpen = openRoomId === room.id;
              return (
                <li key={room.id} data-testid={`row-template-room-${room.id}`}>
                  <div className="flex items-center gap-3 p-3">
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={isOpen ? `Collapse ${room.name}` : `Expand ${room.name}`}
                      onClick={() => setOpenRoomId(isOpen ? null : room.id)}
                      data-testid={`button-toggle-template-room-${room.id}`}
                    >
                      {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                    </Button>

                    <span className="min-w-0 flex-1 font-medium">{room.name}</span>

                    <Badge variant="secondary">
                      {roomItems.length} item{roomItems.length === 1 ? "" : "s"}
                    </Badge>

                    <Label className="flex items-center gap-2 text-sm font-normal">
                      <Checkbox
                        checked={room.includeByDefault}
                        onCheckedChange={(checked) =>
                          setIncluded.mutate({ id: room.id, includeByDefault: checked === true })
                        }
                        data-testid={`checkbox-template-default-${room.id}`}
                      />
                      Start with this
                    </Label>

                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`Remove ${room.name} from the template`}
                      onClick={() => removeRoom.mutate(room.id)}
                      data-testid={`button-remove-template-room-${room.id}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>

                  {isOpen && (
                    <div className="space-y-2 border-t border-border bg-muted/30 p-3">
                      {roomItems.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                          No items yet. Adding a {room.name.toLowerCase()} to a walkthrough would
                          bring nothing with it.
                        </p>
                      ) : (
                        <ul className="space-y-1">
                          {roomItems.map((item) => (
                            <li
                              key={item.id}
                              className="flex items-center gap-2 text-sm"
                              data-testid={`row-template-item-${item.id}`}
                            >
                              <span className="min-w-0 flex-1">{item.label}</span>
                              <Button
                                size="icon"
                                variant="ghost"
                                aria-label={`Remove ${item.label}`}
                                onClick={() => removeItem.mutate(item.id)}
                                data-testid={`button-remove-template-item-${item.id}`}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </li>
                          ))}
                        </ul>
                      )}

                      <div className="flex gap-2 pt-1">
                        <Input
                          value={newItemLabel}
                          maxLength={100}
                          placeholder={`Add an item to ${room.name}, e.g. Smoke detector`}
                          onChange={(event) => setNewItemLabel(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" && newItemLabel.trim()) addItem.mutate(room.id);
                          }}
                          data-testid={`input-template-item-${room.id}`}
                        />
                        <Button
                          variant="secondary"
                          disabled={newItemLabel.trim().length === 0 || addItem.isPending}
                          onClick={() => addItem.mutate(room.id)}
                          data-testid={`button-add-template-item-${room.id}`}
                        >
                          Add
                        </Button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
