import { storage } from "./storage";
import { logError } from "./errors";
import type { AuthContext } from "./authz";

/**
 * ---------------------------------------------------------------------------
 * Audit log
 * ---------------------------------------------------------------------------
 * Records the handful of actions somebody may need to account for later: who
 * changed a person's access, who changed money, who put a document in or took
 * one out.
 *
 * This is a foundation, not a compliance system. It records events; nothing
 * reads them back inside the application. Read them with SQL:
 *
 *     select created_at, actor_email, action, summary
 *     from audit_log order by created_at desc limit 50;
 *
 * Two deliberate properties, both of which matter if you extend it:
 *
 * 1. **It never fails a request.** A failed audit write is reported to the
 *    server log and otherwise ignored. Somebody deactivating an account should
 *    not get an error because the log was unreachable. The trade-off is that an
 *    event can be lost, so this is a record of what happened, not proof of it.
 *
 * 2. **It never records a credential.** Callers pass details field by field
 *    rather than handing over a request body, and `scrubDetails` drops any key
 *    whose name looks like a secret. Both layers exist on purpose: the first
 *    keeps the log readable, the second means a careless caller cannot leak a
 *    token into a table that is, by design, never deleted.
 *
 * A summary *does* contain names, filenames, email addresses and company names,
 * because a log that says "user 4f2a changed 8c11" is one nobody can use. What
 * it must not contain is anything unbounded: a summary is truncated before it is
 * stored, so a caller that interpolates a hostile 2MB filename writes a short
 * row rather than a large one.
 */

/**
 * Keys whose *values* are dropped before anything is stored.
 *
 * Deliberately broad, and matched on the key name rather than the value, so
 * that a new field named `plaidAccessToken` is covered without anyone
 * remembering to add it. The financial entries are here because the portal is
 * forbidden from storing raw banking credentials at all (see CLAUDE.md); if one
 * ever reaches this helper, something upstream is already wrong and the log
 * must not be the place it comes to rest.
 */
const SENSITIVE_KEY =
  /(secret|token|password|passwd|credential|api[-_]?key|auth|cookie|session|signature|private[-_]?key|routing|account[-_]?number|iban|swift|card[-_]?number|cardnum|cvv|cvc|ssn|social[-_]?security|tax[-_]?id)/i;

const REDACTED = "[redacted]";

/** How deep a details object may nest before the rest is dropped. */
const MAX_DEPTH = 4;

/** Longest string kept verbatim; anything longer is truncated. */
const MAX_STRING = 500;

/**
 * Longest summary stored. Summaries interpolate filenames, request titles and
 * company names, all of which are ultimately typed by a user, so the length is
 * capped centrally rather than trusted at each of the call sites.
 */
const MAX_SUMMARY = 300;

/** Collapses whitespace and caps length. Newlines would break log readers. */
function truncate(text: string, limit: number): string {
  const flattened = text.replace(/\s+/g, " ").trim();
  return flattened.length <= limit ? flattened : `${flattened.slice(0, limit)}...[truncated]`;
}

/**
 * Returns a copy of `value` safe to store: sensitive keys redacted, long
 * strings truncated, deep structures cut off.
 */
export function scrubDetails(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}...[truncated]` : value;
  }

  if (typeof value === "number" || typeof value === "boolean") return value;

  if (value instanceof Date) return value.toISOString();

  if (depth >= MAX_DEPTH) return "[omitted]";

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((entry) => scrubDetails(entry, depth + 1));
  }

  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? REDACTED : scrubDetails(entry, depth + 1);
    }
    return out;
  }

  // Functions, symbols, bigints: not something a route should be logging.
  return "[unsupported]";
}

/**
 * The set of actions the portal records. Kept as one list so the names stay
 * consistent and so anyone reading the table can see the full vocabulary in one
 * place. Format is `<thing>.<past tense verb>`.
 */
export const AUDIT_ACTIONS = {
  USER_CREATED: "user.created",
  USER_DELETED: "user.deleted",
  USER_ROLE_CHANGED: "user.role_changed",
  USER_STATUS_CHANGED: "user.status_changed",
  USER_PERMISSIONS_CHANGED: "user.permissions_changed",
  MAINTENANCE_STATUS_CHANGED: "maintenance_request.status_changed",
  INVOICE_CREATED: "invoice.created",
  INVOICE_UPDATED: "invoice.updated",
  INVOICE_DELETED: "invoice.deleted",
  BILLING_RECORD_CREATED: "billing_record.created",
  BILLING_RECORD_UPDATED: "billing_record.updated",
  BILLING_RECORD_DELETED: "billing_record.deleted",
  DOCUMENT_UPLOADED: "document.uploaded",
  DOCUMENT_DOWNLOADED: "document.downloaded",
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

export interface AuditEventInput {
  action: AuditAction;
  entityType: string;
  entityId?: string | null;
  /** One sentence a non-technical reader can understand. */
  summary?: string;
  /** Field names and small scalar values only. Never a request body. */
  details?: Record<string, unknown>;
}

/**
 * Records an event. Returns immediately -- the write happens in the background
 * and its failure is logged, never surfaced to the caller.
 *
 * `actor` is the authenticated context of whoever performed the action, or null
 * for something the system did on its own (a webhook, a scheduled job).
 */
export function recordAuditEvent(actor: AuthContext | null, event: AuditEventInput): void {
  const row = {
    actorId: actor?.userId ?? null,
    actorEmail: actor?.user.email ?? null,
    action: event.action,
    entityType: event.entityType,
    entityId: event.entityId ?? null,
    summary: event.summary ? truncate(event.summary, MAX_SUMMARY) : null,
    details: event.details ? (scrubDetails(event.details) as Record<string, unknown>) : null,
  };

  // Promise.resolve, and the surrounding try, are both deliberate: this must
  // survive a storage layer that throws synchronously as well as one whose
  // write rejects. Loud in the log, invisible to the user -- the action itself
  // already succeeded, and refusing it now would be worse than losing the
  // record of it.
  try {
    void Promise.resolve(storage.createAuditEvent(row)).catch((error) => {
      logError(`Failed to record audit event "${event.action}"`, error);
    });
  } catch (error) {
    logError(`Failed to record audit event "${event.action}"`, error);
  }
}

/**
 * Loads a value that exists only to make an audit entry readable -- the email
 * address behind an ID, the permissions row an update is about to replace.
 *
 * Returns undefined rather than throwing. A lookup performed *for the log*
 * must not be able to fail the action being logged: without this, an unrelated
 * database hiccup while fetching somebody's email would 500 the request and the
 * role change would never happen at all. Losing the detail is the acceptable
 * outcome; losing the action is not.
 *
 * Only for enrichment. A read the handler needs for authorization or for its
 * own logic must stay outside this, where its failure is visible.
 */
export async function auditLookup<T>(load: () => Promise<T>): Promise<T | undefined> {
  try {
    return await load();
  } catch (error) {
    logError("Failed to load context for an audit event", error);
    return undefined;
  }
}

/**
 * Names of the fields a partial update actually changes, for updates where the
 * values themselves are not worth storing (or are somebody's personal details).
 *
 * Compares against the existing record so that a form which submits every field
 * does not report all of them as changed.
 */
export function changedFields(
  before: Record<string, unknown> | undefined,
  update: Record<string, unknown>,
): string[] {
  return Object.keys(update)
    .filter((key) => update[key] !== undefined)
    .filter((key) => !before || String(before[key] ?? "") !== String(update[key] ?? ""))
    .sort();
}
