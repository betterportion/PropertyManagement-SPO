import { useState } from "react";
import { useMutation } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";

/**
 * Taking a flagged item off the needs-attention list.
 *
 * Somebody marked it poor and it turned out fine. The reason is the point,
 * exactly as with an asset snooze: the next RA opening the walkthrough sees
 * "dismissed" and has to be able to read why. The recorded condition is not
 * changed -- that would be inventing an assessment -- so the item stays on
 * its walkthrough, saying it was dismissed.
 */
export default function DismissItemDialog({
  item,
  open,
  onOpenChange,
}: {
  item: { itemId: string; label: string; roomName: string; walkthroughId: string } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { toast } = useToast();
  const [reason, setReason] = useState("");

  const dismiss = useMutation({
    mutationFn: async () =>
      await apiRequest("POST", `/api/walkthrough-items/${item!.itemId}/dismiss`, { reason }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/walkthrough-flagged-items"] });
      queryClient.invalidateQueries({ queryKey: ["/api/walkthroughs", item!.walkthroughId, "items"] });
      onOpenChange(false);
      setReason("");
      toast({ title: "Dismissed", description: `${item?.label} is off the needs-attention list. It still shows on the walkthrough.` });
    },
    onError: () => {
      toast({ title: "That did not save", description: "The item was not dismissed. Check the reason and try again.", variant: "destructive" });
    },
  });

  // A reason typed about one item must not be waiting when the next one
  // opens: closing without saving forgets it.
  const close = (next: boolean) => {
    if (!next) setReason("");
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Dismiss this item</DialogTitle>
          <DialogDescription>
            {item?.roomName} · {item?.label}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            This takes it off the needs-attention list. The walkthrough keeps what was recorded and
            shows that it was dismissed, with your reason.
          </p>
          <div className="space-y-2">
            <Label htmlFor="dismiss-reason">Why does this not need attention?</Label>
            <Textarea
              id="dismiss-reason"
              rows={3}
              value={reason}
              maxLength={500}
              placeholder="e.g. Looked at it on site — a scuff, not a hole."
              onChange={(event) => setReason(event.target.value)}
              data-testid="textarea-dismiss-reason"
            />
            <p className="text-xs text-muted-foreground">Required. The next RA reads this.</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => close(false)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={reason.trim().length === 0 || dismiss.isPending}
            onClick={() => dismiss.mutate()}
            data-testid="button-confirm-dismiss"
          >
            {dismiss.isPending ? "Dismissing…" : "Dismiss"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
