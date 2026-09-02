import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/states";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { WalkthroughItem } from "@shared/schema";
import ConditionPicker from "./ConditionPicker";

/**
 * One room's checklist: every item, its condition, and a place for a note.
 *
 * Each tap is written to the server on its own. There is no save button and
 * no draft held in the browser, because the thing this screen has to survive
 * is a phone locking itself in the middle of a house.
 *
 * Notes are the hard half of that. A condition is one tap and one request; a
 * note is typed over several seconds, and the moments it can be lost are
 * exactly the moments nothing fires an event you would normally listen for.
 * See `ItemRow` for the four ways a note gets written.
 */

/**
 * How long typing has to stop before a note is written.
 *
 * Long enough that a request does not go out per word, short enough that the
 * window in which a locking phone can lose something is under a second.
 */
const NOTE_SAVE_DELAY_MS = 700;

interface RoomChecklistProps {
  walkthroughId: string;
  items: WalkthroughItem[];
  canManage: boolean;
}

export default function RoomChecklist({ walkthroughId, items, canManage }: RoomChecklistProps) {
  const { toast } = useToast();

  const itemsKey = ["/api/walkthroughs", walkthroughId, "items"] as const;

  /**
   * Updates one item, showing the change before the server confirms it.
   *
   * The optimistic write is what makes tapping through a room feel like
   * ticking a paper form; the invalidate in onSettled is what keeps the cache
   * honest afterwards, since nothing here refetches on its own.
   */
  const updateItem = useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<WalkthroughItem> }) => {
      await apiRequest("PATCH", `/api/walkthrough-items/${id}`, patch);
    },
    onMutate: async ({ id, patch }) => {
      await queryClient.cancelQueries({ queryKey: itemsKey });
      const previous = queryClient.getQueryData<WalkthroughItem[]>(itemsKey);
      queryClient.setQueryData<WalkthroughItem[]>(itemsKey, (current) =>
        (current ?? []).map((item) => (item.id === id ? { ...item, ...patch } : item)),
      );
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) queryClient.setQueryData(itemsKey, context.previous);
      toast({ variant: "destructive", title: "Not saved", description: "That change did not save. Check your signal and try again." });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: itemsKey });
    },
  });

  const deleteItem = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/walkthrough-items/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: itemsKey });
    },
    onError: () => {
      toast({ variant: "destructive", title: "Not removed", description: "That item could not be removed." });
    },
  });

  return (
    <div className="space-y-3">
      {items.length === 0 ? (
        <EmptyState
          title="Nothing to check in this room"
          description="Every item here has been removed, so this room records nothing. Photos of it can still be added below."
        />
      ) : (
        items.map((item) => (
          <ItemRow
            key={item.id}
            item={item}
            canManage={canManage}
            // `mutate` keeps the same identity across renders, which is what
            // lets the autosave effects below depend on it without restarting
            // their timer on every keystroke.
            onSave={updateItem.mutate}
            onDelete={() => deleteItem.mutate(item.id)}
          />
        ))
      )}

    </div>
  );
}

interface ItemRowProps {
  item: WalkthroughItem;
  canManage: boolean;
  onSave: (change: { id: string; patch: Partial<WalkthroughItem> }) => void;
  onDelete: () => void;
}

function ItemRow({ item, canManage, onSave, onDelete }: ItemRowProps) {
  // Held locally while it is being typed. Saving every keystroke would mean a
  // request per character on a phone signal.
  const [notes, setNotes] = useState(item.notes ?? "");
  const saved = item.notes ?? "";
  const unsaved = notes !== saved;

  // The latest unsaved text, readable from the handlers below without making
  // them re-subscribe on every keystroke.
  const draft = useRef({ notes, unsaved });
  useEffect(() => {
    draft.current = { notes, unsaved };
  }, [notes, unsaved]);

  // 1. A moment after typing stops.
  useEffect(() => {
    if (!unsaved) return;
    const timer = setTimeout(() => onSave({ id: item.id, patch: { notes } }), NOTE_SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [notes, unsaved, item.id, onSave]);

  // 2. When the phone locks or the tab goes away, and 3. when this row is
  //    unmounted -- moving to the next room, or leaving the walkthrough. Both
  //    are moments the timer above would never get to run.
  useEffect(() => {
    const flush = () => {
      if (draft.current.unsaved) onSave({ id: item.id, patch: { notes: draft.current.notes } });
    };
    const flushOnHide = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", flushOnHide);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", flushOnHide);
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [item.id, onSave]);

  return (
    <Card data-testid={`card-item-${item.id}`}>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <h3 className="font-medium leading-tight" data-testid={`text-item-label-${item.id}`}>
            {item.label}
          </h3>
          {canManage && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`Remove ${item.label}`}
              onClick={onDelete}
              data-testid={`button-delete-item-${item.id}`}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>

        <ConditionPicker
          value={item.condition}
          onChange={(condition) => onSave({ id: item.id, patch: { condition } })}
          disabled={!canManage}
          testId={item.id}
        />

        <Textarea
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          // 4. And straight away when the field is left, so tapping a chip or
          //    another item writes the note without waiting out the timer.
          onBlur={() => {
            if (unsaved) onSave({ id: item.id, patch: { notes } });
          }}
          disabled={!canManage}
          rows={2}
          placeholder="Note anything worth remembering…"
          aria-label={`Notes for ${item.label}`}
          data-testid={`input-item-notes-${item.id}`}
        />
      </CardContent>
    </Card>
  );
}
