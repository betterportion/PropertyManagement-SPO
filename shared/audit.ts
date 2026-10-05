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
  USER_RELINKED: "user.relinked",
  MAINTENANCE_STATUS_CHANGED: "maintenance_request.status_changed",
  MAINTENANCE_DOCUMENTS_CHANGED: "maintenance_request.documents_changed",
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
  PROPERTY_BUDGET_SET: "property.budget_set",
  PROPERTY_REPAIR_BUDGET_SET: "property.repair_budget_set",
  QUICKBOOKS_CONNECTED: "quickbooks.connected",
  QUICKBOOKS_DISCONNECTED: "quickbooks.disconnected",
  QUICKBOOKS_MAPPING_CHANGED: "quickbooks.mapping_changed",
  QUICKBOOKS_ACCOUNTS_CHANGED: "quickbooks.accounts_changed",
  QUICKBOOKS_SYNC: "quickbooks.sync",
  PROPERTY_ACCESS_CODE_CHANGED: "property.access_code_changed",
  PROPERTY_DELETED: "property.deleted",
  RESIDENT_DOCUMENT_RECORDED: "resident.document_recorded",
  RESIDENT_DELETED: "resident.deleted",
  RESIDENT_STOP_DATE_CHANGED: "resident.stop_date_changed",
  RESIDENT_SHEET_SYNC: "resident.sheet_sync",
  RESIDENT_SHEET_CREATED: "resident.sheet_created",
  RESIDENT_SHEET_UPDATED: "resident.sheet_updated",
  RESIDENT_REVIEW_RESOLVED: "resident.review_resolved",
  RESIDENT_MOVE_OUT_CHECKLIST_COMPLETED: "resident.move_out_checklist_completed",
  DEPOSIT_RULE_CHANGED: "deposit_rule.changed",
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
  "user.relinked": "Account linked to a new sign-in",
  "maintenance_request.status_changed": "Maintenance request status changed",
  "maintenance_request.documents_changed": "Project contract link changed",
  "invoice.created": "Invoice created",
  "invoice.updated": "Invoice updated",
  "invoice.deleted": "Invoice deleted",
  "billing_record.created": "Billing record created",
  "billing_record.updated": "Billing record updated",
  "billing_record.deleted": "Billing record deleted",
  // "HH fees" is what SPO calls them on screen; the action names keep the
  // column's word because they are stored, not shown.
  "rent_payment.created": "HH fee charge recorded",
  "rent_payment.updated": "HH fee charge updated",
  "rent_payment.deleted": "HH fee charge deleted",
  "security_deposit.created": "Security deposit recorded",
  "security_deposit.updated": "Security deposit updated",
  "security_deposit.deleted": "Security deposit deleted",
  "deposit_deduction.added": "Deposit deduction added",
  "deposit_deduction.updated": "Deposit deduction updated",
  "deposit_deduction.deleted": "Deposit deduction removed",
  "property.documents_changed": "Property lease link or photo changed",
  "property.household_emailed": "Household emailed",
  "property.budget_set": "Startup budget set",
  "property.repair_budget_set": "Repair & maintenance budget set",
  "quickbooks.connected": "QuickBooks connected",
  "quickbooks.disconnected": "QuickBooks disconnected",
  "quickbooks.mapping_changed": "House linked to a QuickBooks class",
  "quickbooks.accounts_changed": "QuickBooks repair & maintenance accounts changed",
  "quickbooks.sync": "QuickBooks spend sync",
  "property.access_code_changed": "Door, gate or alarm code changed",
  "property.deleted": "Property deleted",
  "resident.document_recorded": "Resident paperwork recorded",
  "resident.deleted": "Resident removed from the roster",
  "resident.stop_date_changed": "Resident stop date changed",
  "resident.sheet_sync": "Resident sheet sync",
  "resident.sheet_created": "Resident added from the sheet",
  "resident.sheet_updated": "Resident updated from the sheet",
  "resident.review_resolved": "Roster review item marked reviewed",
  "resident.move_out_checklist_completed": "Move-out checklist completed",
  "deposit_rule.changed": "State deposit return deadline changed",
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
