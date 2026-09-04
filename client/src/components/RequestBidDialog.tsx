import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { CommentAttachmentField, type PendingAttachment } from "@/components/CommentAttachmentField";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { MaintenanceContact, MaintenanceRequestBid } from "@shared/schema";

/**
 * Recording or editing one bid: who, how much, when, notes, and the quote.
 *
 * The contractor is a contact record when the firm has one and a typed name
 * when it does not -- nobody should have to create a vendor for a company
 * SPO may never use. The quote goes up through the request's own
 * bid-document route the moment it is chosen and is only named in the body
 * once Save is pressed, so the server can check the file is the caller's.
 * On an edit the document is sent only when it changed: the server refuses
 * a URL somebody else uploaded, and an untouched file may well be one.
 */

const NO_CONTACT = "none";

/** What the form carries between opening and saving. */
interface BidDraft {
  contactId: string;
  vendorName: string;
  amount: string;
  bidDate: string;
  notes: string;
  document: PendingAttachment | null;
}

function draftFrom(bid: MaintenanceRequestBid | null): BidDraft {
  return {
    contactId: bid?.contactId ?? NO_CONTACT,
    vendorName: bid?.vendorName ?? "",
    amount: bid?.amount ?? "",
    bidDate: bid?.bidDate ? String(bid.bidDate).slice(0, 10) : "",
    notes: bid?.notes ?? "",
    document: bid?.documentUrl ? { url: bid.documentUrl, name: bid.documentName ?? "Quote" } : null,
  };
}

interface RequestBidDialogProps {
  requestId: string;
  /** The bid being edited, or null for a new one. */
  bid: MaintenanceRequestBid | null;
  open: boolean;
  onClose: () => void;
}

export function RequestBidDialog({ requestId, bid, open, onClose }: RequestBidDialogProps) {
  const { toast } = useToast();
  const [draft, setDraft] = useState<BidDraft>(() => draftFrom(bid));
  const [error, setError] = useState<string | null>(null);
  const bidsKey = ["/api/maintenance-requests", requestId, "bids"];

  const contactsQuery = useQuery<MaintenanceContact[]>({ queryKey: ["/api/contacts"], enabled: open });
  const contacts = contactsQuery.data ?? [];

  const save = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        contactId: draft.contactId === NO_CONTACT ? null : draft.contactId,
        vendorName: draft.vendorName.trim() || null,
        amount: draft.amount,
        bidDate: draft.bidDate || null,
        notes: draft.notes.trim() || null,
      };
      const documentChanged = (draft.document?.url ?? null) !== (bid?.documentUrl ?? null);
      if (!bid || documentChanged) {
        body.documentUrl = draft.document?.url ?? null;
        body.documentName = draft.document?.name ?? null;
      }
      return bid
        ? apiRequest("PATCH", `/api/maintenance-request-bids/${bid.id}`, body)
        : apiRequest("POST", `/api/maintenance-requests/${requestId}/bids`, body);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: bidsKey });
      toast({ title: bid ? "Bid updated" : "Bid recorded" });
      onClose();
    },
    onError: (err: Error) => setError(err.message),
  });

  const update = (patch: Partial<BidDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const hasVendor = draft.contactId !== NO_CONTACT || draft.vendorName.trim().length > 0;
  const canSave = hasVendor && draft.amount.trim().length > 0 && !save.isPending;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto" data-testid="dialog-bid">
        <DialogHeader>
          <DialogTitle>{bid ? "Edit bid" : "Record a bid"}</DialogTitle>
          <DialogDescription>
            Who offered to do the work, for how much, and the quote they sent. Amounts only; the money moves in QuickBooks
            and Ramp.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            save.mutate();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="bid-contact">Contractor on file</Label>
            <Select value={draft.contactId} onValueChange={(value) => update({ contactId: value })}>
              <SelectTrigger id="bid-contact" data-testid="select-bid-contact">
                <SelectValue placeholder="Pick a contractor" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_CONTACT}>Not on file — type the name below</SelectItem>
                {contacts.map((contact) => (
                  <SelectItem key={contact.id} value={contact.id} data-testid={`option-bid-contact-${contact.id}`}>
                    {contact.name}
                    {contact.company ? ` · ${contact.company}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="bid-vendor">Company name{draft.contactId === NO_CONTACT ? "" : " (optional)"}</Label>
            <Input
              id="bid-vendor"
              value={draft.vendorName}
              maxLength={200}
              placeholder="e.g. Northside Fence Co"
              onChange={(event) => update({ vendorName: event.target.value })}
              data-testid="input-bid-vendor"
            />
            <p className="text-xs text-muted-foreground">
              For a firm with no contact record. You do not have to create a vendor for a company we may never use.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="bid-amount">Amount ($)</Label>
              <Input
                id="bid-amount"
                type="number"
                min={0}
                step="0.01"
                value={draft.amount}
                onChange={(event) => update({ amount: event.target.value })}
                data-testid="input-bid-amount"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="bid-date">Bid date</Label>
              <Input
                id="bid-date"
                type="date"
                value={draft.bidDate}
                onChange={(event) => update({ bidDate: event.target.value })}
                data-testid="input-bid-date"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="bid-notes">Notes</Label>
            <Textarea
              id="bid-notes"
              rows={3}
              maxLength={4000}
              value={draft.notes}
              placeholder="What the quote covers, what it leaves out, how long it stands."
              onChange={(event) => update({ notes: event.target.value })}
              data-testid="input-bid-notes"
            />
          </div>

          <div className="space-y-2">
            <Label>Quote document</Label>
            <CommentAttachmentField
              requestId={requestId}
              endpoint={`/api/maintenance-requests/${requestId}/bid-documents`}
              hint="The quote as sent. PDF, Word or an image, up to 20MB."
              value={draft.document}
              onChange={(document) => update({ document })}
              onError={setError}
              disabled={save.isPending}
            />
          </div>

          {error && (
            <p className="text-sm text-destructive" role="alert" data-testid="text-bid-error">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose} disabled={save.isPending} data-testid="button-cancel-bid">
              Cancel
            </Button>
            <Button type="submit" disabled={!canSave} data-testid="button-save-bid">
              {save.isPending ? "Saving..." : bid ? "Save changes" : "Record bid"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
