/**
 * Turning SPO's master resident sheet into roster changes.
 *
 * The rule, from SPO: **the sheet wins, but conflicts are flagged for review.**
 *
 *   - Residents are matched by email (case and spaces aside). A new email is a
 *     new resident on the house the row names; an unknown house creates
 *     nothing and is flagged.
 *   - A value the sheet changes is applied. If a PERSON had changed that same
 *     value in the portal since the last sync, it is still applied, but a
 *     review item records the old value, the new one, and who edited it when.
 *     A plain sheet update over a value nobody touched applies silently.
 *   - A returning resident -- a different house, or a start date after their
 *     last stay ended -- gets a NEW stay (a new resident row), so the old
 *     stay keeps its own dates, deposit and paperwork.
 *   - Nobody is ever deleted. An active resident the sheet no longer lists is
 *     flagged.
 *   - A row with a bad date, a stop date before its start, or an email that
 *     appears twice is skipped and reported; the rest of the sheet carries on.
 *   - A header that looks like a banking field refuses the whole sheet before
 *     a single row is read (shared/rosterSheet.ts).
 *
 * `planRosterSync` is pure -- sheet rows and the current roster in, a plan
 * out -- so every one of those rules is tested without a database or Google.
 * Applying a plan is one transaction (storage.applyRosterPlan). Running the
 * same sheet twice plans nothing the second time.
 */
import {
  looksLikeBankingHeader,
  mapRosterHeaders,
  ROSTER_REQUIRED_COLUMNS,
  ROSTER_SHEET_COLUMNS,
  type RosterColumnKey,
} from "@shared/rosterSheet";
import {
  RESIDENT_PAYMENT_PLANS,
  type Property,
  type Resident,
  type ResidentSheetLink,
  type RosterReviewItem,
} from "@shared/schema";

/** The resident fields the sheet controls, compared and stored as strings/booleans. */
export const SYNCED_FIELDS = ["firstName", "lastName", "moveInDate", "moveOutDate", "paymentPlan", "isActive"] as const;
export type SyncedField = (typeof SYNCED_FIELDS)[number];
export type SyncedValues = Record<SyncedField, string | boolean | null>;

const FIELD_LABEL: Record<SyncedField, string> = {
  firstName: "first name",
  lastName: "last name",
  moveInDate: "household start date",
  moveOutDate: "household stop date",
  paymentPlan: "payment plan",
  isActive: "active",
};

export interface SheetTable {
  headers: string[];
  /** Data rows, each the cells under `headers`, in sheet order (row 2 onwards). */
  rows: string[][];
}

export type ReviewDraft = Omit<
  RosterReviewItem,
  "id" | "status" | "reviewedByEmail" | "reviewedAt" | "createdAt" | "editedAt"
> & { editedAt: Date | null };

export interface PlannedCreate {
  row: number;
  property: Property;
  values: SyncedValues & { email: string };
  /** The stay this one follows, for a returning resident. */
  previousStayId: string | null;
}

export interface PlannedUpdate {
  row: number;
  resident: Resident;
  changes: Array<{ field: SyncedField; from: string | boolean | null; to: string | boolean | null; conflict: boolean }>;
  /** Everything the sheet says now, stored as the link's synced values. */
  values: SyncedValues;
}

export interface RosterPlan {
  /** Header names that look like banking data: nothing else was planned. */
  refusedColumns: string[];
  /** A required header the sheet lacks: nothing else was planned. */
  missingColumns: string[];
  rowsRead: number;
  creates: PlannedCreate[];
  updates: PlannedUpdate[];
  /** Residents whose sheet values already match, to (re)record as synced. */
  unchanged: Array<{ resident: Resident; values: SyncedValues }>;
  reviews: ReviewDraft[];
  skipped: Array<{ row: number; reason: string }>;
}

export interface PlanInputs {
  table: SheetTable;
  residents: Resident[];
  properties: Property[];
  links: ResidentSheetLink[];
  now: Date;
}

// ---------------------------------------------------------------------------
// Cell parsing
// ---------------------------------------------------------------------------

const normEmail = (value: string) => value.trim().toLowerCase();
const normAddress = (value: string) => value.toLowerCase().replace(/[.,#]/g, " ").replace(/\s+/g, " ").trim();
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** "2026-08-15", "8/15/2026" -> "2026-08-15"; "" -> null; anything else -> undefined (invalid). */
export function parseSheetDate(value: string): string | null | undefined {
  const text = value.trim();
  if (!text) return null;
  let y: number, m: number, d: number;
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (match) [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else if ((match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text))) [m, d, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else return undefined;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return undefined;
  return date.toISOString().slice(0, 10);
}

function parseActive(value: string): boolean | null | undefined {
  const text = value.trim().toLowerCase();
  if (!text) return null;
  if (["yes", "y", "true", "1", "active"].includes(text)) return true;
  if (["no", "n", "false", "0", "inactive"].includes(text)) return false;
  return undefined;
}

function parsePaymentPlan(value: string): string | null | undefined {
  const text = value.trim().toLowerCase();
  if (!text) return null;
  return (RESIDENT_PAYMENT_PLANS as readonly string[]).includes(text) ? text : undefined;
}

/** A resident's current values in the same shape as a sheet row's. */
export function residentValues(resident: Resident): SyncedValues {
  const day = (value: Date | string | null) => (value ? new Date(value).toISOString().slice(0, 10) : null);
  return {
    firstName: resident.firstName,
    lastName: resident.lastName,
    moveInDate: day(resident.moveInDate),
    moveOutDate: day(resident.moveOutDate),
    paymentPlan: resident.paymentPlan ?? null,
    isActive: resident.isActive,
  };
}

/** Which house a row names: its address as the portal holds it, or its name. */
function findHouse(properties: Property[], cell: string): Property | undefined {
  const wanted = normAddress(cell);
  return (
    properties.find((p) => normAddress(p.address) === wanted) ??
    properties.find((p) => p.name.trim().toLowerCase() === cell.trim().toLowerCase())
  );
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

interface ParsedRow {
  row: number;
  email: string;
  house: string;
  values: SyncedValues;
}

export function planRosterSync({ table, residents, properties, links, now }: PlanInputs): RosterPlan {
  const plan: RosterPlan = {
    refusedColumns: [],
    missingColumns: [],
    rowsRead: 0,
    creates: [],
    updates: [],
    unchanged: [],
    reviews: [],
    skipped: [],
  };

  // The backstop first, on the headers alone. Fails closed: one suspicious
  // header and nothing in the sheet is used.
  plan.refusedColumns = table.headers.filter((header) => header.trim() && looksLikeBankingHeader(header));
  if (plan.refusedColumns.length > 0) return plan;

  const keys = mapRosterHeaders(table.headers);
  plan.missingColumns = ROSTER_REQUIRED_COLUMNS.filter((key) => !keys.includes(key)).map((key) => ROSTER_SHEET_COLUMNS[key]);
  if (plan.missingColumns.length > 0) return plan;

  const today = now.toISOString().slice(0, 10);
  const parsed: ParsedRow[] = [];
  const seenEmails = new Map<string, number>();

  table.rows.forEach((cells, index) => {
    const row = index + 2; // the header is row 1
    const cell = (key: RosterColumnKey) => {
      const at = keys.indexOf(key);
      return at === -1 ? "" : (cells[at] ?? "").toString();
    };
    if (cells.every((c) => !String(c ?? "").trim())) return; // a blank line is not a row
    plan.rowsRead += 1;
    const skip = (reason: string) => plan.skipped.push({ row, reason });

    const email = normEmail(cell("email"));
    if (email) seenEmails.set(email, (seenEmails.get(email) ?? 0) + 1);
    if (!EMAIL.test(email)) return skip("Email is missing or not an email address");

    const name = cell("fullName").trim().replace(/\s+/g, " ");
    const space = name.lastIndexOf(" ");
    if (space < 1) return skip("Full Name needs a first and a last name");

    const house = cell("house").trim();
    if (!house) return skip("House is empty");

    const start = parseSheetDate(cell("startDate"));
    if (start === undefined) return skip(`Household Start Date "${cell("startDate").trim()}" is not a date`);
    const stop = parseSheetDate(cell("stopDate"));
    if (stop === undefined) return skip(`Household Stop Date "${cell("stopDate").trim()}" is not a date`);
    if (start && stop && stop < start) return skip("Household Stop Date is before the start date");

    const paymentPlan = parsePaymentPlan(cell("paymentPlan"));
    if (paymentPlan === undefined) return skip(`Payment Plan "${cell("paymentPlan").trim()}" is not Monthly or Installments`);
    const active = parseActive(cell("active"));
    if (active === undefined) return skip(`Active "${cell("active").trim()}" is not Yes or No`);

    parsed.push({
      row,
      email,
      house,
      values: {
        firstName: name.slice(0, space),
        lastName: name.slice(space + 1),
        moveInDate: start,
        moveOutDate: stop,
        paymentPlan,
        // Left blank, Active follows the stop date.
        isActive: active ?? !(stop && stop < today),
      },
    });
  });

  // An email on two rows is ambiguous: neither row is used.
  for (const p of parsed.filter((p) => (seenEmails.get(p.email) ?? 0) > 1)) {
    plan.skipped.push({ row: p.row, reason: `${p.email} appears on more than one row` });
  }
  const usable = parsed.filter((p) => (seenEmails.get(p.email) ?? 0) === 1);

  const linkByResident = new Map(links.map((l) => [l.residentId, l]));
  const staysByEmail = new Map<string, Resident[]>();
  for (const r of residents) {
    const key = normEmail(r.email);
    staysByEmail.set(key, [...(staysByEmail.get(key) ?? []), r]);
  }

  for (const p of usable) {
    const property = findHouse(properties, p.house);
    const stays = (staysByEmail.get(p.email) ?? []).sort(byLatestStay);
    const latest = stays[0];
    const fullName = `${p.values.firstName} ${p.values.lastName}`;

    if (!property) {
      plan.skipped.push({ row: p.row, reason: `No house matches "${p.house}"` });
      plan.reviews.push({
        dedupeKey: `unknown_house:${p.email}:${normAddress(p.house)}`,
        kind: "unknown_house",
        residentId: latest?.id ?? null,
        email: p.email,
        name: fullName,
        field: null,
        oldValue: null,
        newValue: p.house,
        editedByEmail: null,
        editedAt: null,
        detail: `Row ${p.row} names a house the portal doesn't have: "${p.house}". Use the house's address as the portal shows it, or its name.`,
      });
      continue;
    }

    const returning =
      latest &&
      (latest.propertyId !== property.id ||
        (p.values.moveInDate !== null && residentValues(latest).moveOutDate !== null && p.values.moveInDate > (residentValues(latest).moveOutDate as string)));

    if (!latest || returning) {
      plan.creates.push({ row: p.row, property, values: { ...p.values, email: p.email }, previousStayId: latest?.id ?? null });
      if (latest) {
        plan.reviews.push({
          dedupeKey: `new_stay:${p.email}:${property.id}:${p.values.moveInDate ?? ""}`,
          kind: "new_stay",
          residentId: latest.id,
          email: p.email,
          name: fullName,
          field: null,
          oldValue: latest.buildingAddress,
          newValue: property.address,
          editedByEmail: null,
          editedAt: null,
          detail: `${fullName} is back for a new stay at ${property.name}. Their earlier stay at ${latest.buildingAddress} keeps its own dates, deposit and paperwork.`,
        });
        if (latest.isActive && !latest.moveOutDate) {
          plan.reviews.push({
            dedupeKey: `previous_stay_open:${latest.id}`,
            kind: "previous_stay_open",
            residentId: latest.id,
            email: p.email,
            name: fullName,
            field: null,
            oldValue: null,
            newValue: null,
            editedByEmail: null,
            editedAt: null,
            detail: `${fullName}'s earlier stay at ${latest.buildingAddress} has no stop date and is still active. Set its stop date, or fix the sheet if the house there is wrong.`,
          });
        }
      }
      continue;
    }

    const current = residentValues(latest);
    const link = linkByResident.get(latest.id);
    const changes: PlannedUpdate["changes"] = [];
    for (const field of SYNCED_FIELDS) {
      if (current[field] === p.values[field]) continue;
      // Edited by a person since the last sync: the value differs from what
      // the sync last wrote. With no sync yet, whatever is there was typed by
      // somebody -- unless it is blank, and filling a blank overwrites nothing.
      const conflict = link ? link.syncedValues[field] !== current[field] : current[field] !== null && current[field] !== "";
      changes.push({ field, from: current[field], to: p.values[field], conflict });
      if (conflict) {
        plan.reviews.push({
          dedupeKey: `conflict:${latest.id}:${field}:${String(p.values[field])}`,
          kind: "conflict",
          residentId: latest.id,
          email: p.email,
          name: fullName,
          field,
          oldValue: current[field] === null ? null : String(current[field]),
          newValue: p.values[field] === null ? null : String(p.values[field]),
          editedByEmail: latest.editedByEmail ?? null,
          editedAt: latest.editedAt ?? null,
          detail: `The sheet changed ${fullName}'s ${FIELD_LABEL[field]} from ${show(current[field])} to ${show(p.values[field])}, over ${
            latest.editedByEmail ? `an edit by ${latest.editedByEmail}` : "a value entered in the portal"
          }.`,
        });
      }
    }
    if (changes.length > 0) plan.updates.push({ row: p.row, resident: latest, changes, values: p.values });
    else if (!link || SYNCED_FIELDS.some((f) => link.syncedValues[f] !== p.values[f])) {
      plan.unchanged.push({ resident: latest, values: p.values });
    }
  }

  // Never deleted: an active resident the sheet no longer lists is flagged.
  const onSheet = new Set(parsed.map((p) => p.email));
  for (const p of table.rows) {
    const at = keys.indexOf("email");
    if (at !== -1 && p[at]) onSheet.add(normEmail(String(p[at])));
  }
  for (const r of residents) {
    if (!r.isActive || onSheet.has(normEmail(r.email))) continue;
    plan.reviews.push({
      dedupeKey: `missing_from_sheet:${r.id}`,
      kind: "missing_from_sheet",
      residentId: r.id,
      email: normEmail(r.email),
      name: `${r.firstName} ${r.lastName}`,
      field: null,
      oldValue: null,
      newValue: null,
      editedByEmail: null,
      editedAt: null,
      detail: `${r.firstName} ${r.lastName} (${r.buildingAddress}) is active in the portal but not on the sheet. Nothing was changed: add them to the sheet, or record their move-out.`,
    });
  }

  return plan;
}

function show(value: string | boolean | null): string {
  if (value === null || value === "") return "blank";
  if (value === true) return "yes";
  if (value === false) return "no";
  return `"${value}"`;
}

/** Newest stay first: by start date, then by when the row was made. */
function byLatestStay(a: Resident, b: Resident): number {
  const start = (r: Resident) => (r.moveInDate ? new Date(r.moveInDate).getTime() : -Infinity);
  const made = (r: Resident) => (r.createdAt ? new Date(r.createdAt).getTime() : 0);
  return start(b) - start(a) || made(b) - made(a);
}

/** The review items in a plan that the stored open items do not already cover. */
export function newReviews(plan: RosterPlan, openKeys: ReadonlySet<string>): ReviewDraft[] {
  const seen = new Set<string>();
  return plan.reviews.filter((r) => {
    if (openKeys.has(r.dedupeKey) || seen.has(r.dedupeKey)) return false;
    seen.add(r.dedupeKey);
    return true;
  });
}
