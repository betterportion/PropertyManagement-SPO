/**
 * Turning a roster spreadsheet into resident rows.
 *
 * Eight people per house move in every August. Typing them in one at a time is
 * what makes people give up on a system, so the roster arrives as a CSV export
 * instead. The rule that shapes everything here is that an import is never
 * applied on upload: the file is parsed and checked, the result is shown back,
 * and nothing is written until somebody confirms what they are about to create.
 *
 * The file itself is never stored. It is parsed in memory and discarded --
 * there is no reason to keep a copy of a spreadsheet of names and email
 * addresses in a bucket once the rows are in the database.
 *
 * Everything in this module is pure. Parsing, validation and duplicate
 * classification take text and records in, and return findings out; the routes
 * do the reading and the writing. That is what lets the interesting cases --
 * a file with a duplicate inside itself, a row that is already on the roster,
 * a malformed date -- be tested without a database or an HTTP server.
 */
import Papa from "papaparse";

/** The columns an import understands, in the order a template would list them. */
export const RESIDENT_IMPORT_COLUMNS = [
  "firstName",
  "lastName",
  "email",
  "phone",
  "moveInDate",
  "notes",
] as const;

const REQUIRED_COLUMNS = ["firstName", "lastName", "email"] as const;

/**
 * Header spellings accepted for each column.
 *
 * A roster exported from a spreadsheet says "First Name" or "first_name", not
 * "firstName". Rejecting a file over the header spelling would send somebody
 * back to edit the export by hand, which is the manual typing this feature
 * exists to remove.
 */
const HEADER_ALIASES: Record<string, (typeof RESIDENT_IMPORT_COLUMNS)[number]> = {
  firstname: "firstName",
  first: "firstName",
  givenname: "firstName",
  lastname: "lastName",
  last: "lastName",
  surname: "lastName",
  familyname: "lastName",
  email: "email",
  emailaddress: "email",
  mail: "email",
  phone: "phone",
  phonenumber: "phone",
  mobile: "phone",
  cell: "phone",
  movein: "moveInDate",
  moveindate: "moveInDate",
  startdate: "moveInDate",
  notes: "notes",
  note: "notes",
  comments: "notes",
};

/** "First Name" and "first_name" both reduce to "firstname". */
function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/[^a-z]/g, "");
}

export interface ParsedResidentRow {
  /** 1-based row number as a person reading the spreadsheet would count it. */
  rowNumber: number;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  notes: string | null;
  moveInDate: string | null;
  /** Empty when the row is usable. */
  errors: string[];
}

export interface ParsedResidentCsv {
  rows: ParsedResidentRow[];
  /** Problems with the file as a whole, which make every row unusable. */
  fileErrors: string[];
}

// Deliberately loose. This checks a value is shaped like an address so an
// obviously wrong cell is caught at preview; it is not an attempt to decide
// deliverability, which no regex can do.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function cleanCell(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * A date the roster can store, as `YYYY-MM-DD`, or null.
 *
 * Accepts the two spellings a spreadsheet actually produces -- ISO, and
 * US-style M/D/YYYY -- and refuses anything else rather than guessing. A
 * silently misread move-in date is worse than a row flagged at preview,
 * because the move-out clock the deposit reminders will run on starts from it.
 */
export function parseImportDate(value: string): { date: string | null; error?: string } {
  const raw = value.trim();
  if (!raw) return { date: null };

  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw);

  let year: number, month: number, day: number;
  if (iso) {
    [year, month, day] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  } else if (us) {
    [month, day, year] = [Number(us[1]), Number(us[2]), Number(us[3])];
  } else {
    return { date: null, error: `Move-in date "${raw}" is not a date the import understands (use YYYY-MM-DD)` };
  }

  // Round-trip through UTC to reject 2026-02-30 and friends, which Date would
  // otherwise roll forward into March without complaint.
  const asDate = new Date(Date.UTC(year, month - 1, day));
  if (
    asDate.getUTCFullYear() !== year ||
    asDate.getUTCMonth() !== month - 1 ||
    asDate.getUTCDate() !== day
  ) {
    return { date: null, error: `Move-in date "${raw}" is not a real date` };
  }

  const pad = (n: number) => String(n).padStart(2, "0");
  return { date: `${year}-${pad(month)}-${pad(day)}` };
}

/**
 * Parses a roster CSV into rows, each carrying its own errors.
 *
 * A bad row never stops the file: it comes back flagged, alongside the good
 * ones, so somebody can fix one cell rather than re-export the whole sheet.
 */
export function parseResidentCsv(text: string): ParsedResidentCsv {
  // Strip a BOM, which Excel writes and which would otherwise become part of
  // the first header's name and lose that column.
  const source = text.replace(/^\uFEFF/, "");

  if (!source.trim()) {
    return { rows: [], fileErrors: ["The file is empty"] };
  }

  const parsed = Papa.parse<Record<string, string>>(source, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (header) => HEADER_ALIASES[normalizeHeader(header)] ?? normalizeHeader(header),
  });

  const present = new Set(parsed.meta.fields ?? []);
  const missing = REQUIRED_COLUMNS.filter((column) => !present.has(column));
  if (missing.length > 0) {
    return {
      rows: [],
      fileErrors: [`The file is missing a column for: ${missing.join(", ")}`],
    };
  }

  const rows = (parsed.data ?? []).map((record, index): ParsedResidentRow => {
    const errors: string[] = [];

    const firstName = cleanCell(record.firstName);
    const lastName = cleanCell(record.lastName);
    const email = cleanCell(record.email);
    if (!firstName) errors.push("First name is missing");
    if (!lastName) errors.push("Last name is missing");
    if (!email) errors.push("Email is missing");
    else if (!EMAIL_SHAPE.test(email)) errors.push(`"${email}" is not a valid email address`);

    const { date: moveInDate, error: dateError } = parseImportDate(cleanCell(record.moveInDate));
    if (dateError) errors.push(dateError);

    return {
      rowNumber: index + 1,
      firstName,
      lastName,
      email,
      phone: cleanCell(record.phone) || null,
      notes: cleanCell(record.notes) || null,
      moveInDate,
      errors,
    };
  });

  return { rows, fileErrors: rows.length === 0 ? ["The file has a header but no rows"] : [] };
}

export type RowOutcomeKind = "create" | "duplicate" | "error";

export interface RowOutcome {
  row: ParsedResidentRow;
  kind: RowOutcomeKind;
  /** Why it is a duplicate or an error, in words an RA can act on. */
  reason?: string;
}

export interface ImportPreview {
  fileErrors: string[];
  outcomes: RowOutcome[];
  counts: Record<RowOutcomeKind, number>;
}

/** Email comparison is case- and whitespace-insensitive, as it is everywhere else. */
function emailKey(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Sorts parsed rows into what would be created, what is already there, and
 * what cannot be used.
 *
 * Duplicates are keyed on email **within the property**, which is what makes
 * this safe to re-run: importing the same sheet twice creates nothing the
 * second time. The same person may legitimately appear on two different
 * houses' rosters over time, so the check never reaches across properties.
 *
 * A file that repeats an email inside itself is caught too -- the second
 * occurrence is a duplicate of the first. Without that, one import would
 * create two rows that a re-import would then refuse.
 */
export function buildImportPreview(
  parsed: ParsedResidentCsv,
  existingEmailsForProperty: readonly string[],
): ImportPreview {
  const seen = new Set(existingEmailsForProperty.map(emailKey));
  const outcomes: RowOutcome[] = [];

  for (const row of parsed.rows) {
    if (row.errors.length > 0) {
      outcomes.push({ row, kind: "error", reason: row.errors.join("; ") });
      continue;
    }
    const key = emailKey(row.email);
    if (seen.has(key)) {
      outcomes.push({
        row,
        kind: "duplicate",
        reason: `${row.email} is already on this house's roster`,
      });
      continue;
    }
    seen.add(key);
    outcomes.push({ row, kind: "create" });
  }

  const counts: Record<RowOutcomeKind, number> = { create: 0, duplicate: 0, error: 0 };
  for (const outcome of outcomes) counts[outcome.kind] += 1;

  return { fileErrors: parsed.fileErrors, outcomes, counts };
}
