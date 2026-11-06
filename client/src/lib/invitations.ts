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

type Request = (method: string, url: string, data?: unknown) => Promise<Response>;

export interface InviteResult {
  residentId: string;
  name: string;
  given: boolean;
  message: string;
}

/**
 * Gives several residents portal access, each through the same route as the
 * resident's own card, so the house limit and every check still apply to each.
 * One at a time, so a refusal (a full house) names its own person and the rest
 * still go. Someone who already has access is skipped, not emailed again.
 */
export async function inviteResidents(
  residents: Array<{ id: string; firstName: string; lastName: string }>,
  sendOn: string,
  request: Request,
  describeError: (error: unknown) => string | undefined,
): Promise<InviteResult[]> {
  const results: InviteResult[] = [];
  for (const r of residents) {
    const name = `${r.firstName} ${r.lastName}`;
    const key = `/api/residents/${r.id}/portal-access`;
    try {
      const access = (await (await request("GET", key)).json()) as { hasAccess: boolean };
      if (access.hasAccess) {
        results.push({ residentId: r.id, name, given: false, message: "Already has access. No email sent." });
        continue;
      }
      const { invitation } = (await (await request("POST", key, { sendOn })).json()) as { invitation: InvitationOutcome };
      results.push({ residentId: r.id, name, given: true, message: `Access given. ${invitationOutcomeMessage(invitation)}` });
    } catch (error) {
      results.push({ residentId: r.id, name, given: false, message: `Not given. ${describeError(error) ?? "Something went wrong."}` });
    }
  }
  return results;
}
