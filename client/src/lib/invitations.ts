/**
 * What the server says became of an invitation when access was given or the
 * email was sent again, and the one sentence the toast shows for it.
 */
import { formatDate } from "@/lib/format";

export type InvitationOutcome =
  | { outcome: "sent" }
  | { outcome: "scheduled"; sendAt: string }
  | { outcome: "cancelled" }
  | { outcome: "not_sent"; reason: "not_configured" | "send_failed" };

export function invitationOutcomeMessage(invitation: InvitationOutcome | null | undefined): string {
  if (!invitation) return "";
  switch (invitation.outcome) {
    case "sent":
      return "The invitation email has been sent.";
    case "scheduled":
      return `The invitation email goes out ${formatDate(invitation.sendAt)}.`;
    case "cancelled":
      return "The invitation email was not sent.";
    case "not_sent":
      return invitation.reason === "not_configured"
        ? "The invitation email did not go: email is not set up yet. It will be sent once it is."
        : "The invitation email did not go: the email provider refused it. It will be tried again tomorrow, or press Send the invitation again.";
  }
}
