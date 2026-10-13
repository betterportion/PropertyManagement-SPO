/**
 * Invitations: telling somebody their portal login is waiting (launch
 * readiness 2.3, docs/LAUNCH_READINESS_ROUND.md).
 *
 * Giving access creates the account at once; this module only sends the
 * email, now or on the day the RA chose. Two rules, both deliberate:
 *
 *   - **Sent once.** `sentAt` is the record; a row with it set is never sent
 *     again, and a row whose send did not go (email not set up, the provider
 *     refused it) keeps `sentAt` null and is tried again on the next daily
 *     run, so an invitation written before Resend is configured goes out once
 *     it is.
 *   - **Checked again on the day.** A scheduled invitation is sent only if the
 *     login is still switched on and still linked to the house it was invited
 *     to. Anything else is dropped (`cancelledAt`), never sent: an RA who
 *     removed somebody's access in between did not mean to invite them.
 *
 * The daily job is the sixth in the web process (server/index.ts), with the
 * same guarantees as the others: idempotent through `sentAt`, and unable to
 * fail the boot. `selectDueInvitations` and `invitationStillStands` are pure.
 */
import { storage as defaultStorage, type IStorage } from "./storage";
import { sendEmail as defaultSendEmail, type OutboundEmail, type SendEmailResult } from "./email";
import { invitationEmail } from "./notifications";
import { recordAuditEvent, AUDIT_ACTIONS } from "./audit";
import { readAppUrlFromEnv } from "./config";
import { logError } from "./errors";
import type { AuthContext } from "./authz";
import { isInvitationDue } from "@shared/invitations";
import type { Invitation, User } from "@shared/schema";

export const INVITATION_SEND_INTERVAL_MS = 24 * 60 * 60 * 1_000;

/** Pure: the invitations due at `now`, among those neither sent nor dropped. */
export function selectDueInvitations<T extends Pick<Invitation, "sendAt" | "sentAt" | "cancelledAt">>(rows: T[], now: Date): T[] {
  return rows.filter((row) => !row.sentAt && !row.cancelledAt && isInvitationDue(new Date(row.sendAt), now));
}

/**
 * Pure: whether the account an invitation was written for can still use it.
 * A switched-off login cannot; a household login is held to the house it was
 * invited to, so one moved or unlinked since is not emailed about a house it
 * no longer reads.
 */
export function invitationStillStands(invitation: Pick<Invitation, "propertyId">, user: User | undefined): user is User {
  if (!user?.isActive) return false;
  if (user.role === "resident") return (user.propertyId ?? null) === (invitation.propertyId ?? null);
  return true;
}

export type InvitationStorage = Pick<
  IStorage,
  "getPendingInvitations" | "getUser" | "getProperty" | "markInvitationSent" | "cancelInvitation"
>;

export type DeliveryOutcome = { outcome: "sent" } | { outcome: "cancelled" } | { outcome: "not_sent"; reason: "not_configured" | "send_failed" };

type Send = (message: OutboundEmail) => Promise<SendEmailResult>;

/**
 * Sends one invitation, or drops it. `actor` is who pressed the button for a
 * send made from a route, null for the daily run. Throws only for a storage
 * failure; a send that does not go is an outcome, not an error.
 */
export async function deliverInvitation(
  invitation: Invitation,
  actor: AuthContext | null,
  now: Date = new Date(),
  storage: InvitationStorage = defaultStorage,
  send: Send = defaultSendEmail,
): Promise<DeliveryOutcome> {
  const user = await storage.getUser(invitation.userId);
  if (!invitationStillStands(invitation, user)) {
    await storage.cancelInvitation(invitation.id, now);
    recordAuditEvent(actor, {
      action: AUDIT_ACTIONS.INVITATION_CANCELLED,
      entityType: "user",
      entityId: invitation.userId,
      summary: `Did not send ${invitation.email} their invitation: the login is switched off or no longer at the house it was invited to`,
      details: { invitationId: invitation.id, propertyId: invitation.propertyId },
    });
    return { outcome: "cancelled" };
  }
  const house = invitation.propertyId ? await storage.getProperty(invitation.propertyId) : undefined;
  const message = invitationEmail({
    to: invitation.email,
    firstName: user.firstName,
    invitedByName: invitation.invitedByName,
    houseAddress: house?.address ?? null,
    role: user.role,
    appUrl: readAppUrlFromEnv().url,
  });
  // No usable address: nothing can ever go, so the row is closed rather than retried daily.
  if (!message) {
    await storage.cancelInvitation(invitation.id, now);
    return { outcome: "not_sent", reason: "send_failed" };
  }
  const result = await send(message);
  if (!result.sent) return { outcome: "not_sent", reason: result.reason };
  await storage.markInvitationSent(invitation.id, now);
  recordAuditEvent(actor, {
    action: AUDIT_ACTIONS.INVITATION_SENT,
    entityType: "user",
    entityId: invitation.userId,
    summary: `Sent ${invitation.email} their invitation to ${house?.address ?? "the portal"}`,
    details: { invitationId: invitation.id, propertyId: invitation.propertyId },
  });
  return { outcome: "sent" };
}

/** The daily run: every due invitation, each on its own. Returns what it did. */
export async function sendDueInvitations(
  now: Date = new Date(),
  storage: InvitationStorage = defaultStorage,
  send: Send = defaultSendEmail,
): Promise<{ sent: number; cancelled: number; notSent: number; failed: number }> {
  const result = { sent: 0, cancelled: 0, notSent: 0, failed: 0 };
  for (const invitation of selectDueInvitations(await storage.getPendingInvitations(), now)) {
    try {
      const { outcome } = await deliverInvitation(invitation, null, now, storage, send);
      if (outcome === "sent") result.sent++;
      else if (outcome === "cancelled") result.cancelled++;
      else result.notSent++;
    } catch (error) {
      // One bad row must not hold up the rest; it is still pending for tomorrow.
      logError(`Failed to send invitation ${invitation.id}`, error);
      result.failed++;
    }
  }
  return result;
}

function tick(run: () => Promise<unknown>): void {
  try {
    void run().catch((error) => logError("Invitation sending failed", error));
  } catch (error) {
    logError("Failed to start invitation sending", error);
  }
}

/**
 * Starts the daily sender and runs it once now. `run` is injectable so the
 * boot-safety of the wrapper itself can be tested: a run that throws or
 * rejects is logged and the server carries on.
 */
export function startInvitationJob(run: () => Promise<unknown> = () => sendDueInvitations()): NodeJS.Timeout {
  tick(run);
  const timer = setInterval(() => tick(run), INVITATION_SEND_INTERVAL_MS);
  timer.unref();
  return timer;
}
