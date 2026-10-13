import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { formatDate } from "@/lib/format";
import { invitationOutcomeMessage, type InvitationOutcome } from "@/lib/invitations";
import { isPortalAccessQuery, portalAccessKey } from "@/lib/portalAccess";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { serverMessage } from "@/lib/serverMessage";
import { invitationState } from "@shared/invitations";
import type { Resident } from "@shared/schema";

interface PortalAccess {
  hasAccess: boolean;
  houseAccounts: Array<{ name: string; email: string | null }>;
  limit: number;
  /** The newest invitation for this login, while it has access. */
  invitation: { sendAt: string; sentAt: string | null; cancelledAt: string | null } | null;
}

const today = () => new Date().toISOString().slice(0, 10);

/** One line on where the invitation email stands. */
function invitationLine(invitation: NonNullable<PortalAccess["invitation"]>): string {
  switch (invitationState(invitation, new Date())) {
    case "sent":
      return `Invitation sent ${formatDate(invitation.sentAt)}.`;
    case "scheduled":
      return `Invitation goes out ${formatDate(invitation.sendAt)}.`;
    case "waiting":
      return "Invitation not sent yet: email is not set up, or the last try failed. It is tried again every day.";
    case "cancelled":
      return "The last invitation was dropped before it went.";
  }
}

/**
 * Whether this resident can sign in to the portal. The portal is by
 * invitation: a household leader or steward gets in because their RA gave
 * them access here, and signs in with Google using the email on the roster.
 */
export default function PortalAccessCard({ resident, canManage }: { resident: Resident; canManage: boolean }) {
  const { toast } = useToast();
  const key = portalAccessKey(resident.id);
  const { data } = useQuery<PortalAccess>({ queryKey: [key] });
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [sendOn, setSendOn] = useState(today);

  const refresh = () => {
    // Every resident's card, not just this one: each carries the house's count.
    queryClient.invalidateQueries({ predicate: isPortalAccessQuery });
    queryClient.invalidateQueries({ queryKey: ["/api/users"] });
  };
  const failed = (title: string) => (error: unknown) => toast({ title, description: serverMessage(error), variant: "destructive" });

  const grant = useMutation({
    mutationFn: async () => (await (await apiRequest("POST", key, { sendOn })).json()) as { invitation: InvitationOutcome },
    onSuccess: ({ invitation }) => {
      refresh();
      toast({
        title: "Access given",
        description: `${resident.firstName} can sign in with Google using ${resident.email}. ${invitationOutcomeMessage(invitation)}`,
      });
    },
    onError: failed("Access not given"),
  });
  const sendAgain = useMutation({
    mutationFn: async () => (await (await apiRequest("POST", `${key}/invitation`)).json()) as { invitation: InvitationOutcome },
    onSuccess: ({ invitation }) => {
      refresh();
      toast({ title: invitation.outcome === "sent" ? "Invitation sent" : "Invitation not sent", description: invitationOutcomeMessage(invitation) });
    },
    onError: failed("Invitation not sent"),
  });
  const remove = useMutation({
    mutationFn: async () => await apiRequest("DELETE", key),
    onSuccess: () => {
      refresh();
      toast({ title: "Access removed" });
    },
    onError: failed("Access not removed"),
  });

  if (!data) return null;
  const full = !data.hasAccess && data.houseAccounts.length >= data.limit;

  return (
    <Card data-testid="card-portal-access">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="h-5 w-5" /> Portal access
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          For the household leader and stewards: up to {data.limit} people per house. They sign in with Google using the email on
          the roster ({resident.email}).
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {data.hasAccess ? (
            <Badge variant="success" data-testid="badge-portal-access">Has access</Badge>
          ) : (
            <Badge variant="outline" data-testid="badge-portal-access">No access</Badge>
          )}
          <span className="text-sm text-muted-foreground">
            {data.houseAccounts.length} of {data.limit} used at this house
            {data.houseAccounts.length > 0 ? `: ${data.houseAccounts.map((a) => a.name).join(", ")}` : ""}
          </span>
        </div>
        {data.hasAccess && data.invitation && (
          <p className="text-sm text-muted-foreground" data-testid="text-invitation-state">
            {invitationLine(data.invitation)}
          </p>
        )}
        {canManage &&
          (data.hasAccess ? (
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => setConfirmRemove(true)} disabled={remove.isPending} data-testid="button-remove-portal-access">
                Remove portal access
              </Button>
              <Button variant="secondary" onClick={() => sendAgain.mutate()} disabled={sendAgain.isPending} data-testid="button-send-invitation-again">
                Send the invitation again
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              {!full && resident.isActive && (
                <div className="space-y-1">
                  <Label htmlFor={`invitation-send-on-${resident.id}`}>Send the invitation email on</Label>
                  <Input
                    id={`invitation-send-on-${resident.id}`}
                    type="date"
                    value={sendOn}
                    min={today()}
                    onChange={(e) => setSendOn(e.target.value || today())}
                    className="max-w-xs"
                    data-testid="input-invitation-send-on"
                  />
                  <p className="text-xs text-muted-foreground">
                    Their login is ready straight away; this is only when the email telling them goes. Today means now.
                  </p>
                </div>
              )}
              <Button
                variant="primary"
                onClick={() => grant.mutate()}
                disabled={grant.isPending || full || !resident.isActive}
                data-testid="button-give-portal-access"
              >
                Give portal access
              </Button>
            </div>
          ))}
        {canManage && full && (
          <p className="text-sm text-muted-foreground">This house already has {data.limit} logins, the most a house can have. Remove one to add another.</p>
        )}
      </CardContent>

      <AlertDialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {resident.firstName}'s portal access?</AlertDialogTitle>
            <AlertDialogDescription>
              They will no longer be able to sign in. Their roster record, requests and history stay as they are, and you can give
              access again later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => remove.mutate()}>Remove access</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
