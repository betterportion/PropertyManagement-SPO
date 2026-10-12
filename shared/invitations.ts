/**
 * When an invitation email goes (launch readiness 2.3).
 *
 * Giving somebody portal access creates their account at once; only the email
 * can wait. The RA or admin picks a day, and the rule for turning that day
 * into a moment lives here so the server, the forms and the tests agree:
 *
 *   - no day, today, or a day already gone  → now, sent as part of the action
 *   - a later day                            → that day, by the daily run
 *
 * A calendar day, never a time: the people choosing it are planning a
 * move-in week, not a delivery slot.
 */
import { z } from "zod";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A calendar day as the date input writes it, "YYYY-MM-DD". */
export const invitationDaySchema = z
  .string()
  .regex(DAY, "Enter a date as YYYY-MM-DD")
  .refine((day) => !Number.isNaN(new Date(`${day}T00:00:00.000Z`).getTime()), "Enter a real date");

/** The optional send day on the two routes that give access. */
export const invitationRequestSchema = z.object({
  sendOn: invitationDaySchema.optional(),
});

export type InvitationRequest = z.infer<typeof invitationRequestSchema>;

/** The hour (UTC) a scheduled invitation becomes due: early morning in the US. */
const SEND_HOUR_UTC = 12;

/**
 * The moment an invitation written at `now` for `sendOn` becomes due. Pure.
 * Today and the past mean now, so the email goes with the action rather than
 * waiting for a daily run that may be hours off.
 */
export function invitationSendAt(sendOn: string | null | undefined, now: Date): Date {
  if (!sendOn) return now;
  const today = now.toISOString().slice(0, 10);
  if (sendOn <= today) return now;
  return new Date(`${sendOn}T${String(SEND_HOUR_UTC).padStart(2, "0")}:00:00.000Z`);
}

/** Whether a send moment is due at `now`. */
export function isInvitationDue(sendAt: Date, now: Date): boolean {
  return sendAt.getTime() <= now.getTime();
}

/** What a screen shows about an invitation, from the three dates. */
export type InvitationState = "sent" | "scheduled" | "waiting" | "cancelled";

export function invitationState(
  invitation: { sendAt: Date | string; sentAt: Date | string | null; cancelledAt: Date | string | null },
  now: Date,
): InvitationState {
  if (invitation.cancelledAt) return "cancelled";
  if (invitation.sentAt) return "sent";
  return isInvitationDue(new Date(invitation.sendAt), now) ? "waiting" : "scheduled";
}
