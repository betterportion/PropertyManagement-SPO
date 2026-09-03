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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { assetLifecycle } from "@shared/assetLifecycle";
import type { Asset } from "@shared/schema";

/**
 * Parking an asset an RA is confident about.
 *
 * The reason field is the point. An RA who knows a boiler was serviced last
 * month needs it off the dashboard, and next year somebody has to be able to
 * find out why it went quiet — that sentence is what makes the budget
 * conversation possible. So the form will not submit without one, matching the
 * server, which refuses a blank reason too.
 *
 * Snooze never edits the replacement date. Editing the date is the permanent
 * correction and lives on the asset form; this is the temporary one, it has an
 * end, and it returns.
 */

/** A year out, as "YYYY-MM-DD". The common case is "ask me again next budget". */
function defaultUntil(): string {
  const date = new Date();
  date.setFullYear(date.getFullYear() + 1);
  return date.toISOString().slice(0, 10);
}

export default function SnoozeDialog({
  asset,
  open,
  onOpenChange,
}: {
  asset: Asset | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { toast } = useToast();
  const [until, setUntil] = useState(defaultUntil);
  const [reason, setReason] = useState("");

  const isSnoozed = asset ? assetLifecycle(asset).snoozed : false;

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/assets"] });
    // The dashboard hides a snoozed asset, so it has to be re-read too.
    queryClient.invalidateQueries({ queryKey: ["/api/action-items"] });
  };

  const snooze = useMutation({
    mutationFn: async () =>
      await apiRequest("POST", `/api/assets/${asset!.id}/snooze`, { until, reason }),
    onSuccess: () => {
      invalidate();
      onOpenChange(false);
      setReason("");
      toast({ title: "Snoozed", description: `${asset?.name} is off the dashboard until then.` });
    },
    onError: () => {
      toast({
        title: "That did not save",
        description: "The asset was not snoozed. Check the date and reason, then try again.",
        variant: "destructive",
      });
    },
  });

  const wake = useMutation({
    mutationFn: async () => await apiRequest("DELETE", `/api/assets/${asset!.id}/snooze`),
    onSuccess: () => {
      invalidate();
      onOpenChange(false);
      toast({ title: "Back on the dashboard", description: `${asset?.name} is no longer snoozed.` });
    },
    onError: () => {
      toast({
        title: "That did not save",
        description: "The snooze was not cleared. Try again in a moment.",
        variant: "destructive",
      });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isSnoozed ? "Snoozed" : "Snooze this asset"}</DialogTitle>
          <DialogDescription>
            {asset?.name} — {asset?.buildingAddress}
          </DialogDescription>
        </DialogHeader>

        {isSnoozed ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              This is off the dashboard until further notice. It still appears on this page, and
              its replacement date has not been changed.
            </p>
            {asset?.snoozeReason && (
              <p className="rounded-md border border-border bg-muted px-3 py-2 text-sm" data-testid="text-snooze-reason">
                {asset.snoozeReason}
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              This clears it from the dashboard for a while. It stays on this page, and its
              replacement date is left exactly as it is — to change that, edit the asset instead.
            </p>

            <div className="space-y-2">
              <Label htmlFor="snooze-until">Ask me again on</Label>
              <Input
                id="snooze-until"
                type="date"
                value={until}
                onChange={(event) => setUntil(event.target.value)}
                data-testid="input-snooze-until"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="snooze-reason">Why can this wait?</Label>
              <Textarea
                id="snooze-reason"
                rows={3}
                value={reason}
                maxLength={500}
                placeholder="e.g. Serviced in March, technician said five years left."
                onChange={(event) => setReason(event.target.value)}
                data-testid="textarea-snooze-reason"
              />
              <p className="text-xs text-muted-foreground">
                Required. This is what next year's budget conversation runs on.
              </p>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {isSnoozed ? (
            <Button
              variant="primary"
              disabled={wake.isPending}
              onClick={() => wake.mutate()}
              data-testid="button-clear-snooze"
            >
              {wake.isPending ? "Clearing…" : "Put it back on the dashboard"}
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={!until || reason.trim().length === 0 || snooze.isPending}
              onClick={() => snooze.mutate()}
              data-testid="button-confirm-snooze"
            >
              {snooze.isPending ? "Snoozing…" : "Snooze"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
