import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { CheckCircle2, CircleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDate, localToday } from "@/lib/format";
import { inviteResidents, type InviteResult } from "@/lib/invitations";
import { isPortalAccessQuery } from "@/lib/portalAccess";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { serverMessage } from "@/lib/serverMessage";
import type { Resident } from "@shared/schema";

/**
 * Portal access for the residents the RA ticked on the roster, with one
 * invitation day for all of them: today sends now, a later day schedules it.
 */
export default function InviteResidentsDialog({
  residents,
  houseName,
  open,
  onOpenChange,
  onDone,
}: {
  residents: Resident[];
  houseName: (propertyId: string) => string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const [sendOn, setSendOn] = useState(localToday);
  const [results, setResults] = useState<InviteResult[] | null>(null);
  const later = sendOn > localToday();

  const invite = useMutation({
    mutationFn: () => inviteResidents(residents, sendOn, apiRequest, serverMessage),
    onSuccess: (done) => {
      setResults(done);
      queryClient.invalidateQueries({ predicate: isPortalAccessQuery });
      queryClient.invalidateQueries({ queryKey: ["/api/users"] });
    },
  });

  const close = (next: boolean) => {
    if (invite.isPending) return;
    onOpenChange(next);
    if (!next) {
      if (results) onDone();
      setResults(null);
      setSendOn(localToday());
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {results ? "Portal access" : `Give portal access to ${residents.length} ${residents.length === 1 ? "person" : "people"}?`}
          </DialogTitle>
          <DialogDescription>
            {results
              ? "What happened for each person."
              : "Their login is ready straight away. They sign in with Google using the email on the roster."}
          </DialogDescription>
        </DialogHeader>

        {results ? (
          <ul className="space-y-3" data-testid="list-invite-results">
            {results.map((r) => (
              <li key={r.residentId} className="flex gap-2 text-sm" data-testid={`invite-result-${r.residentId}`}>
                {r.given ? (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-label="Done" />
                ) : (
                  <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-label="Not done" />
                )}
                <span>
                  <span className="font-medium">{r.name}</span>
                  <span className="text-muted-foreground"> · {r.message}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="space-y-4">
            <ul className="space-y-1 text-sm">
              {residents.map((r) => (
                <li key={r.id}>
                  <span className="font-medium">{r.firstName} {r.lastName}</span>
                  <span className="text-muted-foreground"> · {houseName(r.propertyId)}</span>
                </li>
              ))}
            </ul>
            <div className="space-y-1">
              <Label htmlFor="invite-send-on">Send the invitation email on</Label>
              <Input
                id="invite-send-on"
                type="date"
                value={sendOn}
                min={localToday()}
                onChange={(e) => setSendOn(e.target.value || localToday())}
                className="max-w-xs"
                data-testid="input-invite-send-on"
              />
              <p className="text-xs text-muted-foreground">Today sends it now. A later day sends it that morning.</p>
            </div>
          </div>
        )}

        <DialogFooter>
          {results ? (
            <Button onClick={() => close(false)} data-testid="button-invite-done">Done</Button>
          ) : (
            <>
              <Button variant="secondary" onClick={() => close(false)} disabled={invite.isPending}>Cancel</Button>
              <Button onClick={() => invite.mutate()} disabled={invite.isPending} data-testid="button-invite-confirm">
                {invite.isPending ? "Giving access..." : later ? `Give access, email on ${formatDate(sendOn)}` : "Give access and email now"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
