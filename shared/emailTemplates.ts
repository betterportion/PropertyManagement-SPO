/**
 * The portal's automated emails, by name. Every outbound message carries one,
 * so the email log (Settings → Email health) can say which kind of email
 * failed without storing what it said.
 */
export const EMAIL_TEMPLATES = {
  maintenance_received: "Request received",
  maintenance_status: "Request status changed",
  comment: "New comment on a request",
  household: "Email to a household",
  move_out_resident: "Move-out checklist to resident",
  move_out_staff: "Move-out heads-up to RA",
  test: "Test email",
} as const;

export type EmailTemplate = keyof typeof EMAIL_TEMPLATES;

export const EMAIL_OUTCOMES = ["sent", "failed", "not_configured"] as const;
export type EmailOutcome = (typeof EMAIL_OUTCOMES)[number];

/** How far back the alerts look for a failed or skipped send. */
export const EMAIL_ALERT_WINDOW_DAYS = 7;

/** What the alerts know about email. */
export interface EmailHealth {
  configured: boolean;
  failedRecent: number;
  notConfiguredRecent: number;
  lastFailureAt: string | null;
}
