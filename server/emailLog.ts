/**
 * The email log: whether the automated emails are actually going out.
 *
 * Every send's outcome is recorded through the seam in server/email.ts --
 * which email, to whom, sent / failed / not set up, and the kind of error --
 * never the subject, the body or a credential. Entries are kept one year,
 * removed in capped batches by the daily retention run (server/audit.ts), the
 * same way as the audit log.
 */
import { readEmailConfigFromEnv } from "./config";
import { storage as defaultStorage, type IStorage } from "./storage";
import { EMAIL_ALERT_WINDOW_DAYS, EMAIL_TEMPLATES, type EmailHealth, type EmailTemplate } from "@shared/emailTemplates";
import type { EmailLogEntry } from "@shared/schema";

export const EMAIL_LOG_RETENTION_DAYS = 365;
export const EMAIL_LOG_PURGE_BATCH = 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

/** Removes entries older than a year, a batch at a time. Returns how many. */
export async function purgeExpiredEmailLog(
  now = new Date(),
  storage: Pick<IStorage, "deleteEmailLogBefore"> = defaultStorage,
): Promise<number> {
  const cutoff = new Date(now.getTime() - EMAIL_LOG_RETENTION_DAYS * DAY_MS);
  let total = 0;
  for (;;) {
    const removed = await storage.deleteEmailLogBefore(cutoff, EMAIL_LOG_PURGE_BATCH);
    total += removed;
    if (removed < EMAIL_LOG_PURGE_BATCH) return total;
  }
}

export interface EmailStats {
  configured: boolean;
  /** Last 30 days, per email: how many went, failed, or were skipped as not set up. */
  byTemplate: Array<{ template: EmailTemplate | string; label: string; sent: number; failed: number; notConfigured: number }>;
  recentFailures: Array<Pick<EmailLogEntry, "id" | "template" | "recipient" | "errorClass" | "createdAt">>;
}

/** Pure: the log's last 30 days, summarised for the Email health panel. */
export function summarizeEmailLog(entries: EmailLogEntry[], configured: boolean): EmailStats {
  const rows = new Map<string, EmailStats["byTemplate"][number]>();
  for (const e of entries) {
    const row =
      rows.get(e.template) ??
      { template: e.template, label: EMAIL_TEMPLATES[e.template as EmailTemplate] ?? e.template, sent: 0, failed: 0, notConfigured: 0 };
    if (e.outcome === "sent") row.sent += 1;
    else if (e.outcome === "failed") row.failed += 1;
    else row.notConfigured += 1;
    rows.set(e.template, row);
  }
  return {
    configured,
    byTemplate: Array.from(rows.values()).sort((a, b) => a.label.localeCompare(b.label)),
    recentFailures: entries
      .filter((e) => e.outcome === "failed")
      .slice(0, 20)
      .map(({ id, template, recipient, errorClass, createdAt }) => ({ id, template, recipient, errorClass, createdAt })),
  };
}

/** What the alerts need: failed or skipped sends in the last week. */
export async function emailHealth(
  now = new Date(),
  storage: Pick<IStorage, "getEmailLogSince"> = defaultStorage,
): Promise<EmailHealth> {
  const recent = await storage.getEmailLogSince(new Date(now.getTime() - EMAIL_ALERT_WINDOW_DAYS * DAY_MS));
  const failed = recent.filter((e) => e.outcome === "failed");
  return {
    configured: readEmailConfigFromEnv().configured,
    failedRecent: failed.length,
    notConfiguredRecent: recent.filter((e) => e.outcome === "not_configured").length,
    lastFailureAt: failed[0]?.createdAt?.toISOString() ?? null,
  };
}
