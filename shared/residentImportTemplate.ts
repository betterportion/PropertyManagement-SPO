/**
 * The blank roster template an RA downloads before filling one in.
 *
 * In `shared/` because two sides read it: the client writes these headers
 * into the CSV it offers for download, and a server test checks that every
 * one of them is a spelling the parser in `server/residentImport.ts` accepts.
 * That test is what keeps the template and the parser from drifting apart --
 * a template whose "Move-in date" column the import silently ignored would be
 * worse than no template.
 *
 * The order is the order the parser lists its columns.
 */
export const RESIDENT_IMPORT_TEMPLATE_HEADERS = [
  "First name",
  "Last name",
  "Email",
  "Phone",
  "Room",
  "Move-in date",
  "Notes",
] as const;

/** One example row, so the date spelling is never a guess. */
export const RESIDENT_IMPORT_TEMPLATE_EXAMPLE = [
  "Jane",
  "Smith",
  "jane.smith@example.com",
  "612-555-0100",
  "Bedroom 2",
  "2026-08-20",
  "Household leader",
] as const;

export const RESIDENT_IMPORT_TEMPLATE_FILENAME = "roster-template.csv";
