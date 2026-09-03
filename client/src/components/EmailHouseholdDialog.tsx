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
import { apiRequest } from "@/lib/queryClient";
import type { Property, Resident } from "@shared/schema";

/**
 * A message to everybody currently living in a house.
 *
 * The recipient list is shown before sending, and it is the **active**
 * residents only: a mail-out to people who moved out last spring is the kind
 * of mistake that gets a tool abandoned, and seeing the names is what makes
 * that visible before it happens rather than after.
 *
 * The server sends one message per person rather than one addressed to the
 * whole list, so nobody's address is disclosed to the rest of the house.
 */
export default function EmailHouseholdDialog({
  property,
  residents,
  open,
  onOpenChange,
}: {
  property: Property;
  residents: Resident[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { toast } = useToast();
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");

  const active = residents.filter((resident) => resident.isActive);

  const send = useMutation({
    mutationFn: async () =>
      await apiRequest("POST", `/api/properties/${property.id}/email`, { subject, body }),
    onSuccess: (result: unknown) => {
      const recipients = (result as { recipients?: number })?.recipients ?? active.length;
      onOpenChange(false);
      setSubject("");
      setBody("");
      toast({
        title: "Sent",
        description: `The message went to ${recipients} ${recipients === 1 ? "person" : "people"} at ${property.name}.`,
      });
    },
    onError: () => {
      toast({
        title: "That did not send",
        description: "Nobody was emailed. Try again in a moment.",
        variant: "destructive",
      });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Email {property.name}</DialogTitle>
          <DialogDescription>
            Goes to the people living there now — not to anybody who has moved out.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1">
            <Label>Who gets this</Label>
            {active.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="text-email-nobody">
                Nobody on this house's roster is currently active, so there is nobody to email.
              </p>
            ) : (
              <p className="text-sm text-muted-foreground" data-testid="text-email-recipients">
                {active.map((resident) => `${resident.firstName} ${resident.lastName}`).join(", ")}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="household-subject">Subject</Label>
            <Input
              id="household-subject"
              value={subject}
              maxLength={200}
              placeholder="e.g. Boiler service on Friday"
              onChange={(event) => setSubject(event.target.value)}
              data-testid="input-household-subject"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="household-body">Message</Label>
            <Textarea
              id="household-body"
              rows={6}
              value={body}
              maxLength={5000}
              onChange={(event) => setBody(event.target.value)}
              data-testid="textarea-household-body"
            />
            <p className="text-xs text-muted-foreground">
              Names, dates and arrangements. Never a password, an account number or anything
              somebody could use to move money.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={
              active.length === 0 ||
              subject.trim().length === 0 ||
              body.trim().length === 0 ||
              send.isPending
            }
            onClick={() => send.mutate()}
            data-testid="button-send-household-email"
          >
            {send.isPending ? "Sending…" : `Send to ${active.length}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
