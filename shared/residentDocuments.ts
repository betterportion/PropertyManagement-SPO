/**
 * The paperwork SPO asks each resident to sign.
 *
 * Fixed in code, like the property setup checklist and for the same reason:
 * the stored row carries a `documentKey`, so if SPO later wants to edit the
 * list themselves this becomes a small config table and the rows keep working
 * unchanged.
 *
 * **This is not e-signature.** An RA records that a document was signed and
 * when; the signing happens on paper or through whatever SPO already uses.
 * E-signature is a vendor integration and a separate decision, and a checkbox
 * pretending to be one would be worse than not having it at all — it would
 * read as evidence in a dispute and be nothing of the sort.
 *
 * In `shared/` because the resident-facing hub, the staff roster view and the
 * route that validates a write all read it.
 */

export interface ResidentDocumentDefinition {
  /** Stable identifier stored on the row. Never shown on screen. */
  key: string;
  label: string;
  /** One line of what it is, for somebody who has not seen it before. */
  hint: string;
}

export const RESIDENT_DOCUMENTS: readonly ResidentDocumentDefinition[] = [
  {
    key: "housing_agreement",
    label: "Housing agreement",
    hint: "The terms of living in an SPO house.",
  },
  {
    key: "liability_waiver",
    label: "Liability waiver",
    hint: "Signed before moving in.",
  },
  {
    key: "renter_insurance",
    label: "Renter's insurance acknowledgement",
    hint: "That they have read the memo and know it is their own cover.",
  },
  {
    key: "conduct_policy",
    label: "Conduct policy",
    hint: "The general standards for living in an SPO house.",
  },
  {
    key: "deposit_terms",
    label: "Deposit terms",
    hint: "What the deposit covers and how it comes back.",
  },
];

/** Whether a key names a document SPO actually asks for. */
export function isKnownResidentDocument(key: string): boolean {
  return RESIDENT_DOCUMENTS.some((document) => document.key === key);
}

export interface ResidentDocumentSummary {
  total: number;
  signed: number;
  /** True only when every document has a date on it. */
  complete: boolean;
}

/**
 * How much of one resident's paperwork is in.
 *
 * A row with no `signedOn` counts as unsigned: the row existing means somebody
 * looked, not that anybody signed. Only a date is evidence.
 */
export function summarizeResidentDocuments(
  rows: readonly { documentKey: string; signedOn: Date | string | null }[],
): ResidentDocumentSummary {
  const signedKeys = new Set(
    rows.filter((row) => !!row.signedOn).map((row) => row.documentKey),
  );
  const signed = RESIDENT_DOCUMENTS.filter((document) => signedKeys.has(document.key)).length;
  return {
    total: RESIDENT_DOCUMENTS.length,
    signed,
    complete: signed === RESIDENT_DOCUMENTS.length,
  };
}
