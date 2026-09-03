/**
 * What the portal's outbound emails say.
 *
 * Pure builders — a record in, a message out — so the wording is testable
 * without a mail provider and the content rule holds in one place:
 *
 *   **Names, dates, amounts and descriptions yes. A credential or a banking
 *   identifier never.** That is the audit log's rule, and email is held to it
 *   for the same reason: both leave the system and neither can be recalled.
 *
 * Sending is `server/email.ts`, which never throws — a courtesy attached to
 * something that already happened must not be able to fail the thing that
 * happened. Every builder here returns `null` (or an empty list) when there is
 * nothing to send, so a caller never has to distinguish "no message" from "a
 * message that failed".
 */
import type { MaintenanceRequest } from "@shared/schema";
import type { OutboundEmail } from "./email";

/**
 * A conservative check that there is somewhere to send.
 *
 * `submittedBy` holds an **email address**, not a user id — reading it as an
 * id would send every acknowledgement to nowhere, silently. This is the guard
 * that turns that into no message rather than a bad one.
 */
function usableAddress(value: string | null | undefined): string | null {
  const address = value?.trim();
  if (!address) return null;
  // Deliberately loose: the identity provider is the authority on what a real
  // address is, and rejecting an unusual but valid one would drop a message
  // somebody was waiting for. This only catches what is plainly not an address.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return null;
  return address;
}

/** How each status reads to somebody who does not work on the code. */
const STATUS_WORDS: Record<string, string> = {
  pending: "waiting to be picked up",
  in_progress: "in progress",
  completed: "finished",
  cancelled: "cancelled",
};

/** The signature every message ends with. */
const SIGN_OFF = "\n\nSaint Paul's Outreach housing\nThis mailbox is not monitored — reply to your RA or household leader.";

/**
 * The acknowledgement somebody gets when they file a request.
 *
 * One of the things JotForm used to do that the portal should do natively:
 * without it, filing a request feels like putting a note in a drawer.
 */
export function maintenanceReceivedEmail(request: MaintenanceRequest): OutboundEmail | null {
  const to = usableAddress(request.submittedBy);
  if (!to) return null;

  return {
    to,
    subject: `We got your request: ${request.title}`,
    text:
      `Thanks — your maintenance request has been logged.\n\n` +
      `What: ${request.title}\n` +
      `Where: ${request.location}, ${request.buildingAddress}\n` +
      `Priority: ${request.priority}\n\n` +
      `You will get another message when it is picked up or finished. ` +
      `You can also see it under "My requests" in the portal.` +
      SIGN_OFF,
  };
}

/**
 * The note somebody gets when their request moves on.
 *
 * Returns null when the status did not actually change, so an edit to a
 * description does not email anybody about nothing.
 */
export function maintenanceStatusEmail(
  request: MaintenanceRequest,
  previousStatus: string | null | undefined,
): OutboundEmail | null {
  if (!previousStatus || previousStatus === request.status) return null;

  const to = usableAddress(request.submittedBy);
  if (!to) return null;

  const words = STATUS_WORDS[request.status] ?? request.status;

  return {
    to,
    subject: `Update on your request: ${request.title}`,
    text:
      `Your maintenance request is now ${words}.\n\n` +
      `What: ${request.title}\n` +
      `Where: ${request.location}, ${request.buildingAddress}\n\n` +
      (request.status === "cancelled"
        ? `If this was not what you expected, speak to your RA or household leader.`
        : `Nothing is needed from you.`) +
      SIGN_OFF,
  };
}

/**
 * A message to everybody currently living in a house.
 *
 * Two rules, both load-bearing:
 *
 *   - **Active residents only.** A mail-out to people who moved out last
 *     spring is the kind of mistake that gets a tool abandoned.
 *   - **One message per person**, never one addressed to the whole list, so
 *     nobody's address is disclosed to the rest of the house.
 *
 * Somebody with no usable address is skipped rather than failing the send:
 * the other seven people still need to hear about the boiler.
 */
export function householdEmail(
  residents: readonly { email: string | null | undefined; isActive: boolean }[],
  propertyName: string,
  subject: string,
  body: string,
): OutboundEmail[] {
  const messages: OutboundEmail[] = [];
  for (const resident of residents) {
    if (!resident.isActive) continue;
    const to = usableAddress(resident.email);
    if (!to) continue;
    messages.push({
      to,
      subject: `${propertyName}: ${subject}`,
      text: `${body}${SIGN_OFF}`,
    });
  }
  return messages;
}
