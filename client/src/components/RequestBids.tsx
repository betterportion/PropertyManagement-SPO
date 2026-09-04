import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { CheckCircle2, FileText, Gavel, Paperclip, Pencil, Plus, Trash2 } from "lucide-react";

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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { RequestBidDialog } from "@/components/RequestBidDialog";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency, formatDate } from "@/lib/format";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { MaintenanceContact, MaintenanceRequestBid } from "@shared/schema";

/**
 * The bids on a project or capital project, and what staff may do to them.
 *
 * Staff only, on a project only -- the page decides that and the server
 * refuses everything here on a repair. Exactly one bid can be accepted,
 * enforced on the server: accepting one un-accepts the others, and the
 * confirmation says so. Removing a bid removes the record and not the file
 * (known issue 1); the confirmation says that too.
 */

interface RequestBidsProps {
  requestId: string;
  canEdit: boolean;
}

/** Which dialog is open: a new bid, an existing one, or none. */
type Editing = { kind: "new" } | { kind: "edit"; bid: MaintenanceRequestBid } | null;

export function RequestBids({ requestId, canEdit }: RequestBidsProps) {
  const { toast } = useToast();
  const [editing, setEditing] = useState<Editing>(null);
  const [pendingAccept, setPendingAccept] = useState<MaintenanceRequestBid | null>(null);
  const [pendingDelete, setPendingDelete] = useState<MaintenanceRequestBid | null>(null);
  const bidsKey = ["/api/maintenance-requests", requestId, "bids"];

  const bidsQuery = useQuery<MaintenanceRequestBid[]>({ queryKey: bidsKey });
  const bids = bidsQuery.data ?? [];

  // Only to put a name on a bid that points at a contact record; a bid with
  // a typed vendor name needs nothing. A staff account without the contacts
  // permission gets a 403 here, and the row falls back to "Contractor on file".
  const contactsQuery = useQuery<MaintenanceContact[]>({
    queryKey: ["/api/contacts"],
    enabled: bids.some((bid) => !!bid.contactId),
  });
  const contactById = new Map((contactsQuery.data ?? []).map((contact) => [contact.id, contact]));

  const accept = useMutation({
    mutationFn: async (bidId: string) => apiRequest("POST", `/api/maintenance-request-bids/${bidId}/accept`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: bidsKey }),
    onError: (error: Error) => toast({ title: "The bid was not accepted", description: error.message, variant: "destructive" }),
  });

  const remove = useMutation({
    mutationFn: async (bidId: string) => apiRequest("DELETE", `/api/maintenance-request-bids/${bidId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: bidsKey }),
    onError: (error: Error) => toast({ title: "The bid was not removed", description: error.message, variant: "destructive" }),
  });

  function vendorOf(bid: MaintenanceRequestBid): React.ReactNode {
    const contact = bid.contactId ? contactById.get(bid.contactId) : undefined;
    if (contact) {
      return (
        <Link href={`/contacts/${contact.id}`} className="underline-offset-2 hover:underline" data-testid={`link-bid-contact-${bid.id}`}>
          {contact.name}
          {contact.company ? ` · ${contact.company}` : ""}
        </Link>
      );
    }
    return bid.vendorName || "Contractor on file";
  }

  return (
    <Card data-testid="request-bids">
      <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
        <CardTitle>Bids</CardTitle>
        {canEdit && (
          <Button variant="secondary" size="sm" onClick={() => setEditing({ kind: "new" })} data-testid="button-add-bid">
            <Plus className="h-3.5 w-3.5" />
            Record a bid
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {bidsQuery.isLoading ? (
          <LoadingState message="Loading bids..." className="h-24" />
        ) : bidsQuery.isError ? (
          <ErrorState message="The bids on this project could not be loaded." onRetry={() => bidsQuery.refetch()} />
        ) : bids.length === 0 ? (
          <EmptyState
            icon={Gavel}
            title="No bids yet"
            description={
              canEdit
                ? "Record each quote as it comes in, then mark the one the project went ahead with."
                : "Quotes will be listed here as the property team records them."
            }
          />
        ) : (
          <ul className="divide-y divide-border" data-testid="list-bids">
            {bids.map((bid) => (
              <li key={bid.id} className="flex flex-wrap items-start justify-between gap-3 py-3 text-sm" data-testid={`row-bid-${bid.id}`}>
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium" data-testid={`text-bid-vendor-${bid.id}`}>
                      {vendorOf(bid)}
                    </span>
                    {bid.accepted && (
                      <Badge variant="success" data-testid={`badge-bid-accepted-${bid.id}`}>
                        <CheckCircle2 className="mr-1 h-3 w-3" />
                        Accepted
                      </Badge>
                    )}
                  </div>
                  <p className="text-muted-foreground">
                    <span className="font-medium text-foreground" data-testid={`text-bid-amount-${bid.id}`}>
                      {formatCurrency(bid.amount)}
                    </span>
                    {bid.bidDate && <> · {formatDate(bid.bidDate)}</>}
                  </p>
                  {bid.notes && (
                    <p className="whitespace-pre-line text-muted-foreground" data-testid={`text-bid-notes-${bid.id}`}>
                      {bid.notes}
                    </p>
                  )}
                  {bid.documentUrl && (
                    <a
                      href={bid.documentUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 underline-offset-2 hover:underline"
                      data-testid={`link-bid-document-${bid.id}`}
                    >
                      <Paperclip className="h-3 w-3" />
                      {bid.documentName || "Quote"}
                    </a>
                  )}
                </div>
                {canEdit && (
                  <div className="flex flex-wrap items-center gap-1">
                    {!bid.accepted && (
                      <Button variant="ghost" size="sm" onClick={() => setPendingAccept(bid)} data-testid={`button-accept-bid-${bid.id}`}>
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        Accept
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" onClick={() => setEditing({ kind: "edit", bid })} data-testid={`button-edit-bid-${bid.id}`}>
                      <Pencil className="h-3.5 w-3.5" />
                      Edit
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setPendingDelete(bid)} data-testid={`button-delete-bid-${bid.id}`}>
                      <Trash2 className="h-3.5 w-3.5" />
                      Remove
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {bids.length > 0 && (
          <p className="mt-4 flex items-start gap-1 text-xs text-muted-foreground">
            <FileText className="mt-0.5 h-3 w-3 shrink-0" />
            One bid can be accepted at a time. Accepting a bid un-accepts the others.
          </p>
        )}
      </CardContent>

      {/* Keyed so a fresh dialog opens for each bid rather than one form
          being re-filled: the draft is read once when the dialog mounts. */}
      {editing && (
        <RequestBidDialog
          key={editing.kind === "edit" ? editing.bid.id : "new"}
          requestId={requestId}
          bid={editing.kind === "edit" ? editing.bid : null}
          open
          onClose={() => setEditing(null)}
        />
      )}

      <AlertDialog open={!!pendingAccept} onOpenChange={(open) => !open && setPendingAccept(null)}>
        <AlertDialogContent data-testid="dialog-accept-bid">
          <AlertDialogHeader>
            <AlertDialogTitle>Accept this bid?</AlertDialogTitle>
            <AlertDialogDescription data-testid="text-accept-bid-explainer">
              Accepting this bid un-accepts the others. The project's record will say it went ahead with{" "}
              {pendingAccept ? (pendingAccept.vendorName || contactById.get(pendingAccept.contactId ?? "")?.name || "this contractor") : "this contractor"}{" "}
              for {formatCurrency(pendingAccept?.amount)}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-accept-bid">Not yet</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingAccept) accept.mutate(pendingAccept.id);
                setPendingAccept(null);
              }}
              data-testid="button-confirm-accept-bid"
            >
              Accept bid
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!pendingDelete} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <AlertDialogContent data-testid="dialog-delete-bid">
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this bid?</AlertDialogTitle>
            <AlertDialogDescription data-testid="text-delete-bid-explainer">
              {pendingDelete?.documentUrl
                ? `This removes the bid, not the file. ${pendingDelete.documentName || "The quote"} stays in storage.`
                : "This removes the bid from the project's record. It cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete-bid">Keep it</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingDelete) remove.mutate(pendingDelete.id);
                setPendingDelete(null);
              }}
              data-testid="button-confirm-delete-bid"
            >
              Remove bid
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
