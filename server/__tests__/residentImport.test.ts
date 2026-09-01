/**
 * Tests for the roster CSV rules in server/residentImport.ts.
 *
 * Pure: no database, no HTTP, no file store. The cases that matter for an
 * import are all about the contents of the file -- a header spelled the way a
 * spreadsheet spells it, a row missing a name, the same email twice -- and
 * every one of them is text in and findings out.
 */
import { describe, it, expect } from "vitest";
import {
  parseResidentCsv,
  buildImportPreview,
  parseImportDate,
} from "../residentImport";

const HEADER = "First Name,Last Name,Email,Phone,Move-in Date,Notes";

function csv(...rows: string[]): string {
  return [HEADER, ...rows].join("\n");
}

describe("parseImportDate", () => {
  it("accepts an ISO date", () => {
    expect(parseImportDate("2026-08-15")).toEqual({ date: "2026-08-15" });
  });

  it("accepts the US spelling a spreadsheet exports", () => {
    expect(parseImportDate("8/15/2026")).toEqual({ date: "2026-08-15" });
    expect(parseImportDate("12/1/2026")).toEqual({ date: "2026-12-01" });
  });

  it("treats an empty cell as no date rather than an error", () => {
    expect(parseImportDate("")).toEqual({ date: null });
    expect(parseImportDate("   ")).toEqual({ date: null });
  });

  it("refuses a date that does not exist instead of rolling it forward", () => {
    // new Date(2026, 1, 30) silently becomes 2 March. A move-in date is what
    // the deposit return clock will run from, so a quiet shift is not
    // acceptable -- the row gets flagged at preview instead.
    const result = parseImportDate("2026-02-30");
    expect(result.date).toBeNull();
    expect(result.error).toMatch(/not a real date/);
  });

  it("refuses a spelling it cannot read, rather than guessing", () => {
    const result = parseImportDate("15 August 2026");
    expect(result.date).toBeNull();
    expect(result.error).toMatch(/not a date the import understands/);
  });
});

describe("parseResidentCsv", () => {
  it("reads a straightforward roster", () => {
    const { rows, fileErrors } = parseResidentCsv(
      csv("Ada,Lovelace,ada@spo.org,(555) 111-2222,2026-08-15,Household leader"),
    );

    expect(fileErrors).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      rowNumber: 1,
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@spo.org",
      phone: "(555) 111-2222",
      moveInDate: "2026-08-15",
      notes: "Household leader",
      errors: [],
    });
  });

  it("accepts the header spellings a spreadsheet actually produces", () => {
    // Rejecting "first_name" would send somebody back to hand-edit the export,
    // which is the manual typing this feature exists to remove.
    const { rows, fileErrors } = parseResidentCsv(
      "first_name,last_name,Email Address\nGrace,Hopper,grace@spo.org",
    );
    expect(fileErrors).toEqual([]);
    expect(rows[0]).toMatchObject({ firstName: "Grace", lastName: "Hopper", email: "grace@spo.org" });
  });

  it("survives the byte-order mark Excel writes", () => {
    const { rows, fileErrors } = parseResidentCsv(
      "\uFEFFFirst Name,Last Name,Email\nGrace,Hopper,grace@spo.org",
    );
    expect(fileErrors).toEqual([]);
    expect(rows[0].firstName).toBe("Grace");
  });

  it("keeps a quoted field containing a comma in one piece", () => {
    const { rows } = parseResidentCsv(
      csv('Ada,Lovelace,ada@spo.org,,,"Leader, and steward last year"'),
    );
    expect(rows[0].notes).toBe("Leader, and steward last year");
    expect(rows[0].errors).toEqual([]);
  });

  it("leaves an absent phone and notes null rather than empty strings", () => {
    const { rows } = parseResidentCsv(csv("Ada,Lovelace,ada@spo.org,,,"));
    expect(rows[0].phone).toBeNull();
    expect(rows[0].notes).toBeNull();
    expect(rows[0].moveInDate).toBeNull();
  });

  it("flags a bad row without discarding the good ones around it", () => {
    // The requirement is per-row errors, not an aborted import: one wrong cell
    // must not cost somebody the other seven housemates.
    const { rows } = parseResidentCsv(
      csv(
        "Ada,Lovelace,ada@spo.org,,,",
        "Grace,,grace@spo.org,,,",
        "Katherine,Johnson,not-an-email,,,",
        "Mary,Jackson,mary@spo.org,,,",
      ),
    );

    expect(rows).toHaveLength(4);
    expect(rows[0].errors).toEqual([]);
    expect(rows[1].errors).toEqual(["Last name is missing"]);
    expect(rows[2].errors).toEqual(['"not-an-email" is not a valid email address']);
    expect(rows[3].errors).toEqual([]);
  });

  it("numbers rows the way a person reading the spreadsheet would", () => {
    const { rows } = parseResidentCsv(
      csv("Ada,Lovelace,ada@spo.org,,,", "Grace,Hopper,grace@spo.org,,,"),
    );
    expect(rows.map((r) => r.rowNumber)).toEqual([1, 2]);
  });

  it("refuses a file missing a column it cannot do without", () => {
    const { rows, fileErrors } = parseResidentCsv("First Name,Last Name\nAda,Lovelace");
    expect(rows).toEqual([]);
    expect(fileErrors[0]).toMatch(/missing a column for: email/);
  });

  it("refuses an empty file", () => {
    expect(parseResidentCsv("").fileErrors).toEqual(["The file is empty"]);
    expect(parseResidentCsv("   \n  ").fileErrors).toEqual(["The file is empty"]);
  });

  it("refuses a file with a header and nothing under it", () => {
    const { rows, fileErrors } = parseResidentCsv(HEADER);
    expect(rows).toEqual([]);
    expect(fileErrors).toEqual(["The file has a header but no rows"]);
  });
});

describe("buildImportPreview", () => {
  const parse = (...rows: string[]) => parseResidentCsv(csv(...rows));

  it("marks a row already on this house's roster as a duplicate", () => {
    const preview = buildImportPreview(parse("Ada,Lovelace,ada@spo.org,,,"), ["ada@spo.org"]);
    expect(preview.counts).toEqual({ create: 0, duplicate: 1, error: 0 });
    expect(preview.outcomes[0].reason).toMatch(/already on this house's roster/);
  });

  it("matches an existing resident regardless of case or padding", () => {
    const preview = buildImportPreview(parse("Ada,Lovelace,ADA@spo.org,,,"), ["  ada@SPO.org "]);
    expect(preview.counts.duplicate).toBe(1);
  });

  it("catches an email repeated inside the file itself", () => {
    // Without this, one import would create two rows that a re-import would
    // then refuse -- the file would be self-inconsistent with the rule.
    const preview = buildImportPreview(
      parse("Ada,Lovelace,ada@spo.org,,,", "Ada,Lovelace,ada@spo.org,,,"),
      [],
    );
    expect(preview.counts).toEqual({ create: 1, duplicate: 1, error: 0 });
  });

  it("is safe to run twice: the second time creates nothing", () => {
    const file = parse("Ada,Lovelace,ada@spo.org,,,", "Grace,Hopper,grace@spo.org,,,");
    expect(buildImportPreview(file, []).counts.create).toBe(2);
    expect(buildImportPreview(file, ["ada@spo.org", "grace@spo.org"]).counts.create).toBe(0);
  });

  it("never matches across properties", () => {
    // The same person can legitimately appear on two houses' rosters over
    // time, so the caller passes only this property's emails.
    const preview = buildImportPreview(parse("Ada,Lovelace,ada@spo.org,,,"), []);
    expect(preview.counts.create).toBe(1);
  });

  it("separates the unusable rows from the duplicates", () => {
    const preview = buildImportPreview(
      parse(
        "Ada,Lovelace,ada@spo.org,,,",
        "Grace,Hopper,grace@spo.org,,,",
        ",Johnson,katherine@spo.org,,,",
      ),
      ["grace@spo.org"],
    );
    expect(preview.counts).toEqual({ create: 1, duplicate: 1, error: 1 });
    expect(preview.outcomes.map((o) => o.kind)).toEqual(["create", "duplicate", "error"]);
  });

  it("carries the file-level errors through", () => {
    const preview = buildImportPreview(parseResidentCsv("Name\nAda"), []);
    expect(preview.fileErrors).toHaveLength(1);
    expect(preview.outcomes).toEqual([]);
  });
});
