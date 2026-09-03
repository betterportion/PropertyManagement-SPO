/**
 * The vocabulary of the activity trail.
 *
 * This lives in `shared/` rather than in `server/audit.ts` because the filter
 * on the activity page has to offer exactly the actions the server records, and
 * a copy of the list kept in the client is one that goes quietly stale the
 * first time an action is added. `server/audit.ts` re-exports these, so server
 * code still imports the log's vocabulary from the log.
 *
 * Format is `<thing>.<past tense verb>`. The stored names are stable -- they
 * are written into rows that are never rewritten -- so renaming one means
 * leaving history behind under the old name.
 */
export const AUDIT_ACTIONS = {
  USER_CREATED: "user.created",
  USER_DELETED: "user.deleted",
  USER_ROLE_CHANGED: "user.role_changed",
  USER_STATUS_CHANGED: "user.status_changed",
  USER_PERMISSIONS_CHANGED: "user.permissions_changed",
  USER_PROPERTY_CHANGED: "user.property_changed",
  MAINTENANCE_STATUS_CHANGED: "maintenance_request.status_changed",
  INVOICE_CREATED: "invoice.created",
  INVOICE_UPDATED: "invoice.updated",
  INVOICE_DELETED: "invoice.deleted",
  BILLING_RECORD_CREATED: "billing_record.created",
  BILLING_RECORD_UPDATED: "billing_record.updated",
  BILLING_RECORD_DELETED: "billing_record.deleted",
  RENT_PAYMENT_CREATED: "rent_payment.created",
  RENT_PAYMENT_UPDATED: "rent_payment.updated",
  RENT_PAYMENT_DELETED: "rent_payment.deleted",
  SECURITY_DEPOSIT_CREATED: "security_deposit.created",
  SECURITY_DEPOSIT_UPDATED: "security_deposit.updated",
  SECURITY_DEPOSIT_DELETED: "security_deposit.deleted",
  DEPOSIT_DEDUCTION_ADDED: "deposit_deduction.added",
  DEPOSIT_DEDUCTION_UPDATED: "deposit_deduction.updated",
  DEPOSIT_DEDUCTION_DELETED: "deposit_deduction.deleted",
  PROPERTY_DOCUMENTS_CHANGED: "property.documents_changed",
  PROPERTY_HOUSEHOLD_EMAILED: "property.household_emailed",
  DOCUMENT_UPLOADED: "document.uploaded",
  DOCUMENT_DOWNLOADED: "document.downloaded",
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

/** Every recorded action, for validating a filter and for building its menu. */
export const AUDIT_ACTION_VALUES = Object.values(AUDIT_ACTIONS) as AuditAction[];

/**
 * How each action is named to somebody who does not work on the code. The
 * dotted names are for the database; nobody should have to read one to find
 * out who deleted an invoice.
 */
export const AUDIT_ACTION_LABELS: Record<AuditAction, string> = {
  "user.created": "Account created",
  "user.deleted": "Account deleted",
  "user.role_changed": "Role changed",
  "user.status_changed": "Account activated or deactivated",
  "user.permissions_changed": "Permissions changed",
  "user.property_changed": "House link changed",
  "maintenance_request.status_changed": "Maintenance request status changed",
  "invoice.created": "Invoice created",
  "invoice.updated": "Invoice updated",
  "invoice.deleted": "Invoice deleted",
  "billing_record.created": "Billing record created",
  "billing_record.updated": "Billing record updated",
  "billing_record.deleted": "Billing record deleted",
  "rent_payment.created": "Rent charge recorded",
  "rent_payment.updated": "Rent charge updated",
  "rent_payment.deleted": "Rent charge deleted",
  "security_deposit.created": "Security deposit recorded",
  "security_deposit.updated": "Security deposit updated",
  "security_deposit.deleted": "Security deposit deleted",
  "deposit_deduction.added": "Deposit deduction added",
  "deposit_deduction.updated": "Deposit deduction updated",
  "deposit_deduction.deleted": "Deposit deduction removed",
  "property.documents_changed": "Property lease link or photo changed",
  "property.household_emailed": "Household emailed",
  "document.uploaded": "Document uploaded",
  "document.downloaded": "Document downloaded",
};

/**
 * A readable name for an action. Falls back to the stored name so a row
 * written by a newer version of the server still displays as something rather
 * than as a blank cell.
 */
export function auditActionLabel(action: string): string {
  return AUDIT_ACTION_LABELS[action as AuditAction] ?? action;
}
