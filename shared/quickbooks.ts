/**
 * How fresh the QuickBooks spend has to be to be trusted.
 *
 * Shared because the server raises "QuickBooks hasn't updated" from it and the
 * screens grey out a figure by it -- one number, so the alert and the page
 * can't disagree about whether a house's spend is current.
 */

/** The sync runs daily; a day and a half without a good one is a problem. */
export const QUICKBOOKS_STALE_AFTER_HOURS = 36;

const HOUR_MS = 60 * 60 * 1_000;

/** True when there has never been a good sync, or the last one is too old. */
export function isQuickBooksStale(lastSuccessAt: Date | string | null | undefined, now: Date): boolean {
  if (!lastSuccessAt) return true;
  const at = lastSuccessAt instanceof Date ? lastSuccessAt : new Date(lastSuccessAt);
  if (Number.isNaN(at.getTime())) return true;
  return now.getTime() - at.getTime() > QUICKBOOKS_STALE_AFTER_HOURS * HOUR_MS;
}

/** What the portal can say about the QuickBooks connection, for the screens and the alerts. */
export interface QuickBooksHealth {
  /** All four QUICKBOOKS_* variables are set. Off is a normal state. */
  configured: boolean;
  /** A refresh token is held. */
  connected: boolean;
  /** Was connected, and QuickBooks has since refused it -- not a deliberate disconnect. */
  lost: boolean;
  connectedAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
}
