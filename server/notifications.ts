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
import type { MaintenanceRequest, MaintenanceRequestComment, User } from "@shared/schema";
import type { OutboundEmail } from "./email";
import { isCurrentResident } from "@shared/residents";

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
    template: "maintenance_received",
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
    template: "maintenance_status",
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
 *   - **Current residents only.** A mail-out to people who moved out last
 *     spring is the kind of mistake that gets a tool abandoned. "Current"
 *     is `isCurrentResident`: active, and a stop date that has not passed,
 *     since the roster row stays active until the move-out is recorded.
 *   - **One message per person**, never one addressed to the whole list, so
 *     nobody's address is disclosed to the rest of the house.
 *
 * Somebody with no usable address is skipped rather than failing the send:
 * the other seven people still need to hear about the boiler.
 */
export function householdEmail(
  residents: readonly {
    email: string | null | undefined;
    isActive: boolean;
    moveOutDate?: Date | string | null;
  }[],
  propertyName: string,
  subject: string,
  body: string,
): OutboundEmail[] {
  const messages: OutboundEmail[] = [];
  for (const resident of residents) {
    if (!isCurrentResident(resident)) continue;
    const to = usableAddress(resident.email);
    if (!to) continue;
    messages.push({
      template: "household",
      to,
      subject: `${propertyName}: ${subject}`,
      text: `${body}${SIGN_OFF}`,
    });
  }
  return messages;
}

/** What the comment email needs to know, and nothing more. */
export interface CommentEmailInput {
  /** One person. A thread is never emailed with everybody on one To line. */
  to: string;
  request: Pick<MaintenanceRequest, "id" | "title" | "buildingAddress">;
  comment: Pick<
    MaintenanceRequestComment,
    "body" | "isInternal" | "authorName" | "authorEmail" | "relaySource"
  >;
  /** The portal's public address, or null for no link. From readAppUrlFromEnv. */
  appUrl: string | null;
}

/**
 * How a comment's author reads: "Sarah Lee", or "Sarah Lee, relaying Dave
 * (handyman)" for one posted on a contractor's behalf. Never the bare
 * contractor's name -- two years from now the thread must say who relayed it.
 */
function commentAuthorLine(comment: CommentEmailInput["comment"]): string {
  const author = comment.authorName?.trim() || comment.authorEmail?.trim() || "Somebody at SPO";
  const source = comment.relaySource?.trim();
  return source ? `${author}, relaying ${source}` : author;
}

/**
 * The note somebody gets when a comment lands on a thread they can see.
 *
 * Who "somebody" is was decided before this is called (server/commentRecipients.ts);
 * this only says what the message is. It carries the comment, the author
 * line, the request's title and house, an "internal" marker so staff know
 * the household did not get it, and a link to the request page when the
 * portal's public address is configured. Nothing else: the body is user
 * text already bounded at posting, and everything here is what the audit
 * log could hold.
 */
export function commentEmail({ to, request, comment, appUrl }: CommentEmailInput): OutboundEmail | null {
  const address = usableAddress(to);
  if (!address) return null;
  const body = comment.body.trim();
  if (!body) return null;

  const where = `"${request.title}" at ${request.buildingAddress}`;
  return {
    template: "comment",
    to: address,
    subject: `${comment.isInternal ? "Internal comment" : "New comment"} on ${request.title}`,
    text:
      `${commentAuthorLine(comment)} wrote on ${where}:\n\n` +
      `${body}\n` +
      (comment.isInternal
        ? `\nInternal — staff only. The household does not see this comment.\n`
        : "") +
      (appUrl ? `\nOpen the request: ${appUrl}/maintenance/${request.id}` : "") +
      SIGN_OFF,
  };
}

// ---------------------------------------------------------------------------
// Move-out (server/moveOut.ts). The wording SPO approves lives here, in one
// place: change it here and every move-out email changes with it.
// ---------------------------------------------------------------------------

/** "Wednesday, May 20, 2027", read as the calendar day it was entered as. */
function longDay(day: string): string {
  return new Intl.DateTimeFormat("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }).format(
    new Date(`${day}T00:00:00.000Z`),
  );
}

/** The checklist to the person leaving, about 30 days ahead. */
export function moveOutResidentEmail(input: {
  to: string | null | undefined;
  firstName: string;
  propertyName: string;
  moveOutDay: string;
}): OutboundEmail | null {
  const to = usableAddress(input.to);
  if (!to) return null;
  return {
    template: "move_out_resident",
    to,
    subject: `Your move-out from ${input.propertyName} on ${longDay(input.moveOutDay)}`,
    text:
      `Hi ${input.firstName},\n\n` +
      `Our records show you're moving out of ${input.propertyName} on ${longDay(input.moveOutDay)}. ` +
      `Here's what to do before you go, so your deposit can be returned without deductions:\n\n` +
      `  1. Take all of your belongings with you. Anything left behind has to be removed, and that cost can come out of your deposit.\n` +
      `  2. Leave your room clean, and patch or report any damage (holes in the walls, broken fixtures) before you leave.\n` +
      `  3. Return every key to your regional administrator.\n` +
      `  4. Your regional administrator will walk through your room with you, or after you leave.\n\n` +
      `If your move-out date has changed, please tell your regional administrator.` +
      SIGN_OFF,
  };
}

/** The heads-up to the house's regional administrators. */
export function moveOutStaffEmail(input: {
  to: string | null | undefined;
  residentName: string;
  propertyName: string;
  moveOutDay: string;
}): OutboundEmail | null {
  const to = usableAddress(input.to);
  if (!to) return null;
  return {
    template: "move_out_staff",
    to,
    subject: `${input.residentName} moves out of ${input.propertyName} on ${longDay(input.moveOutDay)}`,
    text:
      `${input.residentName} is moving out of ${input.propertyName} on ${longDay(input.moveOutDay)}.\n\n` +
      `They have been sent the move-out checklist. In the portal, open their resident page to complete the move-out ` +
      `checklist (room inspected, belongings removed, keys returned), and make sure their deposit is returned on time.` +
      SIGN_OFF,
  };
}

export interface InvitationEmailInput {
  to: string | null | undefined;
  firstName: string | null | undefined;
  /** Who gave access, as the roster or Settings knows them: "Michael Nichols". */
  invitedByName: string;
  /** The house's address for a household login; null for a staff account. */
  houseAddress: string | null;
  role: User["role"];
  /** The portal's public address, or null for no link. From readAppUrlFromEnv. */
  appUrl: string | null;
}

/** How a staff role reads in the invitation. */
const ROLE_WORDS: Record<User["role"], string> = {
  admin: "an admin",
  regional_administrator: "a regional administrator",
  resident: "a resident",
};

/**
 * The invitation: your login is waiting, here is how to use it. Wording
 * approved by JR (2026-10-12) and offered to SPO for changes in the
 * "Information we need from SPO" document.
 *
 * It names who gave access and which house, points at the sign-in page when
 * the portal's address is configured, and says which email to sign in with,
 * because that is the one thing people get wrong. No token, no link that
 * signs anybody in: Google is the only way in, and this is a plain-text note
 * saying so (launch readiness 2.3).
 */
export function invitationEmail(input: InvitationEmailInput): OutboundEmail | null {
  const to = usableAddress(input.to);
  if (!to) return null;
  const greeting = input.firstName?.trim() ? `Hi ${input.firstName.trim()},` : "Hello,";
  const forWhat = input.houseAddress
    ? ` for\n${input.houseAddress}.`
    : input.role === "resident"
      ? "."
      : ` as ${ROLE_WORDS[input.role]}.`;
  const whatYouCanDo =
    input.role === "resident"
      ? "Once you are in, you can report repairs for your house, follow the\nones your housemates reported, and fill in the walkthrough checklist."
      : "Once you are in, you can see the houses in your region, their repairs,\nwalkthroughs and residents.";
  return {
    template: "invitation",
    to,
    subject: "Your sign-in for the SPO housing portal",
    text:
      `${greeting}\n\n` +
      `${input.invitedByName} has given you access to the SPO housing portal${forWhat}\n\n` +
      (input.appUrl ? `Sign in here: ${input.appUrl}\n` : "") +
      `Use "Sign in with Google" with this email address: ${to}\n\n` +
      whatYouCanDo +
      SIGN_OFF,
  };
}
