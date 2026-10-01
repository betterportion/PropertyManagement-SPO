/**
 * The resident sheet sync. The sheet wins, but conflicts are flagged; nobody
 * is deleted; banking columns refuse the lot. Google is replaced entirely.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";

vi.mock("../db", () => ({ db: {}, pool: {} }));
const { createAuditEvent } = vi.hoisted(() => ({ createAuditEvent: vi.fn() }));
vi.mock("../storage", () => ({ storage: { createAuditEvent } }));

import { planRosterSync, parseSheetDate, residentValues, newReviews, type SheetTable, type RosterPlan } from "../rosterSync";
import { runRosterSync } from "../rosterSheetSync";
import { columnLetter, createRosterSheetReader } from "../googleSheets";
import { looksLikeBankingHeader } from "@shared/rosterSheet";
import { rosterSyncItems } from "../actionItems";
import type { Property, Resident, ResidentSheetLink } from "@shared/schema";

const NOW = new Date("2026-10-01T12:00:00Z");
const HEADERS = ["Full Name", "Email", "House", "Household Start Date", "Household Stop Date", "Payment Plan", "Active"];

const COMO = { id: "p-como", name: "Como Men's House", address: "981 Como Ave, St Paul, MN 55103", region: "Northwest" } as Property;
const DINKY = { id: "p-dinky", name: "Dinkytown Women's House", address: "615 8th Ave SE, Minneapolis, MN 55414", region: "Northwest" } as Property;
const PROPERTIES = [COMO, DINKY];

function resident(patch: Partial<Resident>): Resident {
  return {
    id: "r-1",
    propertyId: COMO.id,
    firstName: "Sam",
    lastName: "O'Connor",
    email: "sam@example.org",
    phone: null,
    roomName: null,
    notes: null,
    depositAmountOverride: null,
    moveInDate: new Date("2026-08-15T00:00:00Z"),
    moveOutDate: null,
    isActive: true,
    paymentPlan: "monthly",
    region: COMO.region,
    buildingAddress: COMO.address,
    editedAt: null,
    editedByEmail: null,
    createdAt: new Date("2026-08-01T00:00:00Z"),
    updatedAt: null,
    ...patch,
  } as Resident;
}

const linkFor = (r: Resident, patch: Partial<ResidentSheetLink["syncedValues"]> = {}): ResidentSheetLink => ({
  residentId: r.id,
  syncedValues: { ...residentValues(r), ...patch },
  syncedAt: new Date("2026-09-30T12:00:00Z"),
});

const table = (...rows: string[][]): SheetTable => ({ headers: HEADERS, rows });
const SAM_ROW = ["Sam O'Connor", "Sam@Example.org ", "981 Como Ave, St Paul, MN 55103", "2026-08-15", "", "Monthly", "Yes"];

const plan = (t: SheetTable, residents: Resident[] = [], links: ResidentSheetLink[] = []) =>
  planRosterSync({ table: t, residents, properties: PROPERTIES, links, now: NOW });

describe("the banking backstop", () => {
  it.each(["Bank Account", "Routing #", "ACH", "Card Number", "Acct", "Direct Deposit", "IBAN"])("refuses a sheet with a %s column, reading no row", (header) => {
    const p = plan({ headers: [...HEADERS, header], rows: [SAM_ROW] });
    expect(p.refusedColumns).toEqual([header]);
    expect(p.rowsRead).toBe(0);
    expect(p.creates).toEqual([]);
  });

  it("lets the contract's own headers through", () => {
    expect(HEADERS.filter(looksLikeBankingHeader)).toEqual([]);
  });
});

describe("headers", () => {
  it("matches the contract ignoring case and spacing, and ignores every other column", () => {
    const p = plan({
      headers: ["  full   name", "EMAIL", "House", "Favourite Food", "Household Start Date"],
      rows: [["Sam O'Connor", "sam@example.org", "Como Men's House", "Pizza", "2026-08-15"]],
    });
    expect(p.creates).toHaveLength(1);
    expect(JSON.stringify(p)).not.toContain("Pizza");
  });

  it("plans nothing when a required column is missing", () => {
    const p = plan({ headers: ["Full Name", "House"], rows: [["Sam O'Connor", "Como Men's House"]] });
    expect(p.missingColumns).toEqual(["Email"]);
    expect(p.creates).toEqual([]);
  });
});

describe("matching and creating", () => {
  it("creates a new email on the house its row names, by address or by name", () => {
    const p = plan(table(SAM_ROW, ["Ana Lopez", "ana@example.org", "Dinkytown Women's House", "8/20/2026", "", "installments", ""]));
    expect(p.creates.map((c) => [c.values.email, c.property.id, c.values.moveInDate, c.values.paymentPlan, c.values.isActive])).toEqual([
      ["sam@example.org", "p-como", "2026-08-15", "monthly", true],
      ["ana@example.org", "p-dinky", "2026-08-20", "installments", true],
    ]);
  });

  it("creates nothing for an unknown house, and flags it", () => {
    const p = plan(table(["Sam O'Connor", "sam@example.org", "1 Nowhere St", "", "", "", ""]));
    expect(p.creates).toEqual([]);
    expect(p.reviews.map((r) => r.kind)).toEqual(["unknown_house"]);
  });

  it("matches an existing resident by email, whatever its case", () => {
    const r = resident({});
    expect(plan(table(SAM_ROW), [r], [linkFor(r)])).toMatchObject({ creates: [], updates: [] });
  });
});

describe("the sheet wins, and conflicts are flagged", () => {
  it("applies a plain sheet change silently", () => {
    const r = resident({});
    const p = plan(table([...SAM_ROW.slice(0, 4), "2027-05-20", "Monthly", "Yes"]), [r], [linkFor(r)]);
    expect(p.updates[0].changes).toEqual([{ field: "moveOutDate", from: null, to: "2027-05-20", conflict: false }]);
    expect(p.reviews).toEqual([]);
  });

  it("applies a change over a person's edit, and records who edited it and when", () => {
    // The sync last wrote no stop date; an RA has since entered one.
    const r = resident({ moveOutDate: new Date("2026-12-20T00:00:00Z"), editedByEmail: "ra@spo.org", editedAt: new Date("2026-09-20T15:00:00Z") });
    const p = plan(table([...SAM_ROW.slice(0, 4), "2027-05-20", "Monthly", "Yes"]), [r], [linkFor(r, { moveOutDate: null })]);
    expect(p.updates[0].changes).toEqual([{ field: "moveOutDate", from: "2026-12-20", to: "2027-05-20", conflict: true }]);
    expect(p.reviews).toEqual([
      expect.objectContaining({
        kind: "conflict",
        field: "moveOutDate",
        oldValue: "2026-12-20",
        newValue: "2027-05-20",
        editedByEmail: "ra@spo.org",
        editedAt: new Date("2026-09-20T15:00:00Z"),
      }),
    ]);
  });

  it("treats a never-synced resident's values as a person's", () => {
    const r = resident({ paymentPlan: "installments" });
    const p = plan(table(SAM_ROW), [r], []);
    expect(p.updates[0].changes[0]).toMatchObject({ field: "paymentPlan", conflict: true });
  });

  it("fills a never-synced resident's blank quietly: it overwrites nothing anybody typed", () => {
    const r = resident({ paymentPlan: null });
    const p = plan(table(SAM_ROW), [r], []);
    expect(p.updates[0].changes).toEqual([{ field: "paymentPlan", from: null, to: "monthly", conflict: false }]);
    expect(p.reviews).toEqual([]);
  });
});

describe("returning residents", () => {
  it("gives a different house a new stay, leaving the old one alone, and flags an old stay still open", () => {
    const r = resident({});
    const p = plan(table(["Sam O'Connor", "sam@example.org", "Dinkytown Women's House", "2027-08-15", "", "", ""]), [r], [linkFor(r)]);
    expect(p.updates).toEqual([]);
    expect(p.creates).toEqual([expect.objectContaining({ previousStayId: "r-1", property: DINKY })]);
    expect(p.reviews.map((x) => x.kind).sort()).toEqual(["new_stay", "previous_stay_open"]);
  });

  it("gives a start date after the last stay ended a new stay at the same house", () => {
    const r = resident({ moveOutDate: new Date("2026-05-20T00:00:00Z"), moveInDate: new Date("2025-08-15T00:00:00Z"), isActive: false });
    const p = plan(table([SAM_ROW[0], SAM_ROW[1], SAM_ROW[2], "2026-08-15", "", "Monthly", "Yes"]), [r], [linkFor(r)]);
    expect(p.creates).toHaveLength(1);
    expect(p.reviews.map((x) => x.kind)).toEqual(["new_stay"]);
  });
});

describe("never deleted", () => {
  it("flags an active resident the sheet no longer lists, and changes nothing about them", () => {
    const r = resident({});
    const p = plan(table(["Ana Lopez", "ana@example.org", "Dinkytown Women's House", "", "", "", ""]), [r], [linkFor(r)]);
    expect(p.updates).toEqual([]);
    expect(p.reviews).toEqual([expect.objectContaining({ kind: "missing_from_sheet", residentId: "r-1" })]);
  });

  it("does not call a resident missing whose row was only skipped", () => {
    const r = resident({});
    const p = plan(table([SAM_ROW[0], SAM_ROW[1], SAM_ROW[2], "not a date", "", "", ""]), [r], [linkFor(r)]);
    expect(p.reviews.filter((x) => x.kind === "missing_from_sheet")).toEqual([]);
  });
});

describe("bad rows are skipped and reported, and the rest carries on", () => {
  it.each([
    [[SAM_ROW[0], SAM_ROW[1], SAM_ROW[2], "31/31/2026", "", "", ""], /Start Date "31\/31\/2026" is not a date/],
    [[SAM_ROW[0], SAM_ROW[1], SAM_ROW[2], "2026-08-15", "2026-08-01", "", ""], /before the start date/],
    [["Sam", "sam@example.org", SAM_ROW[2], "", "", "", ""], /first and a last name/],
    [[SAM_ROW[0], "not-an-email", SAM_ROW[2], "", "", "", ""], /not an email address/],
    [[SAM_ROW[0], SAM_ROW[1], SAM_ROW[2], "", "", "Weekly", ""], /not Monthly or Installments/],
  ])("skips %j", (row, reason) => {
    const p = plan(table(row, ["Ana Lopez", "ana@example.org", "Dinkytown Women's House", "", "", "", ""]));
    expect(p.skipped).toEqual([{ row: 2, reason: expect.stringMatching(reason) }]);
    expect(p.creates.map((c) => c.values.email)).toEqual(["ana@example.org"]);
  });

  it("skips every row of an email that appears twice", () => {
    const p = plan(table(SAM_ROW, [...SAM_ROW.slice(0, 2), "Dinkytown Women's House", "", "", "", ""]));
    expect(p.skipped.map((s) => s.row)).toEqual([2, 3]);
    expect(p.creates).toEqual([]);
  });
});

describe("idempotency", () => {
  /** Applies a plan to an in-memory roster, the way storage.applyRosterPlan does. */
  function apply(p: RosterPlan, residents: Resident[], links: ResidentSheetLink[]) {
    const next = residents.map((r) => {
      const u = p.updates.find((x) => x.resident.id === r.id);
      return u ? resident({ ...r, ...toResident(u.values) }) : r;
    });
    const nextLinks = links.filter((l) => !p.updates.some((u) => u.resident.id === l.residentId));
    for (const u of p.updates) nextLinks.push({ residentId: u.resident.id, syncedValues: u.values, syncedAt: NOW });
    p.creates.forEach((c, i) => {
      const r = resident({ id: `new-${i}`, email: c.values.email, propertyId: c.property.id, ...toResident(c.values) });
      next.push(r);
      const { email: _email, ...values } = c.values;
      nextLinks.push({ residentId: r.id, syncedValues: values, syncedAt: NOW });
    });
    return { residents: next, links: nextLinks };
  }
  const toResident = (v: RosterPlan["updates"][number]["values"]) => ({
    firstName: v.firstName as string,
    lastName: v.lastName as string,
    moveInDate: v.moveInDate ? new Date(`${v.moveInDate}T00:00:00Z`) : null,
    moveOutDate: v.moveOutDate ? new Date(`${v.moveOutDate}T00:00:00Z`) : null,
    paymentPlan: v.paymentPlan as Resident["paymentPlan"],
    isActive: v.isActive as boolean,
  });

  it("plans nothing the second time the same sheet is read", () => {
    const r = resident({ moveOutDate: new Date("2026-12-20T00:00:00Z") });
    const sheet = table([...SAM_ROW.slice(0, 4), "2027-05-20", "Monthly", "Yes"], ["Ana Lopez", "ana@example.org", "Dinkytown Women's House", "", "", "", ""]);
    const first = plan(sheet, [r], [linkFor(r, { moveOutDate: null })]);
    expect(first.updates).toHaveLength(1);
    expect(first.creates).toHaveLength(1);

    const after = apply(first, [r], [linkFor(r, { moveOutDate: null })]);
    const second = plan(sheet, after.residents, after.links);
    expect(second.creates).toEqual([]);
    expect(second.updates).toEqual([]);
    expect(second.reviews).toEqual([]);
  });

  it("files a review only once while it is still open", () => {
    const p = plan(table(["Sam O'Connor", "sam@example.org", "1 Nowhere St", "", "", "", ""]));
    expect(newReviews(p, new Set())).toHaveLength(1);
    expect(newReviews(p, new Set([p.reviews[0].dedupeKey]))).toEqual([]);
  });
});

describe("parseSheetDate", () => {
  it("reads ISO and US dates and refuses impossible ones", () => {
    expect(parseSheetDate("2026-08-15")).toBe("2026-08-15");
    expect(parseSheetDate("8/5/2026")).toBe("2026-08-05");
    expect(parseSheetDate("")).toBeNull();
    expect(parseSheetDate("2026-02-30")).toBeUndefined();
    expect(parseSheetDate("next week")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Running it
// ---------------------------------------------------------------------------

function fakeStorage(residents: Resident[] = [], links: ResidentSheetLink[] = []) {
  return {
    getAllResidents: vi.fn(async () => residents),
    getAllProperties: vi.fn(async () => PROPERTIES),
    getAllResidentSheetLinks: vi.fn(async () => links),
    getRosterReviewItems: vi.fn(async () => []),
    applyRosterPlan: vi.fn(async () => []),
    createRosterSyncRun: vi.fn(async (run) => ({ id: "run-1", createdAt: NOW, ...run })),
  };
}

describe("runRosterSync", () => {
  beforeEach(() => createAuditEvent.mockReset());

  it("records a refused run and writes nothing to the roster", async () => {
    const storage = fakeStorage();
    const { run } = await runRosterSync({
      source: "sheet",
      dryRun: false,
      actor: null,
      now: NOW,
      storage: storage as never,
      readSheet: async () => ({ headers: [...HEADERS, "Bank Account"], rows: [] }),
    });
    expect(run).toMatchObject({ ok: false, refusedColumns: ["Bank Account"] });
    expect(storage.applyRosterPlan).not.toHaveBeenCalled();
  });

  it("previews without writing, then applies the same plan for real (positive control)", async () => {
    const storage = fakeStorage();
    const preview = await runRosterSync({ source: "csv", table: table(SAM_ROW), dryRun: true, actor: null, now: NOW, storage: storage as never });
    expect(preview.run).toMatchObject({ ok: true, dryRun: true, created: 1 });
    expect(storage.applyRosterPlan).not.toHaveBeenCalled();

    await runRosterSync({ source: "csv", table: table(SAM_ROW), dryRun: false, actor: null, now: NOW, storage: storage as never });
    expect(storage.applyRosterPlan).toHaveBeenCalledTimes(1);
    const [write] = storage.applyRosterPlan.mock.calls[0] as unknown as [{ creates: Array<{ resident: Record<string, unknown> }> }];
    expect(write.creates[0].resident).toMatchObject({ email: "sam@example.org", propertyId: "p-como", region: "Northwest", roomName: null });
  });

  it("audits each date change with its old and new value", async () => {
    const r = resident({});
    const storage = fakeStorage([r], [linkFor(r)]);
    await runRosterSync({
      source: "sheet",
      dryRun: false,
      actor: null,
      now: NOW,
      storage: storage as never,
      readSheet: async () => table([...SAM_ROW.slice(0, 4), "2027-05-20", "Monthly", "Yes"]),
    });
    expect(createAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: "resident.sheet_updated", summary: expect.stringContaining("moveOutDate none → 2027-05-20") }),
    );
  });
});

describe("the Google Sheets reader", () => {
  const CONFIG = {
    clientEmail: "sync@spo.iam.gserviceaccount.com",
    // A throwaway key, generated for this test only.
    privateKey: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    sheetId: "1AbCdEfGhIjKlMnOpQrStUvWxYz",
    tab: "Residents",
  };

  function fakeFetch(headers: string[], columns: Record<string, string[]>) {
    const calls: string[] = [];
    const impl = vi.fn(async (url: string | URL) => {
      const u = String(url);
      calls.push(u);
      if (u.startsWith("https://oauth2.googleapis.com/token")) return new Response(JSON.stringify({ access_token: "t" }));
      if (u.includes("values:batchGet")) {
        const ranges = new URL(u).searchParams.getAll("ranges");
        return new Response(JSON.stringify({ valueRanges: ranges.map((r) => ({ values: [columns[r.split("!")[1][0]] ?? []] })) }));
      }
      return new Response(JSON.stringify({ values: [headers] }));
    });
    return { impl, calls };
  }

  it("never fetches a data cell from a sheet with a banking header", async () => {
    const { impl, calls } = fakeFetch([...HEADERS, "Routing Number"], {});
    const t = await createRosterSheetReader(CONFIG, impl as unknown as typeof fetch).readTable();
    expect(t.rows).toEqual([]);
    expect(calls.some((c) => c.includes("batchGet"))).toBe(false);
  });

  it("requests only the allowlisted columns (positive control)", async () => {
    const { impl, calls } = fakeFetch(["Full Name", "Notes", "Email", "House"], { A: ["Sam O'Connor"], C: ["sam@example.org"], D: ["Como Men's House"] });
    const t = await createRosterSheetReader(CONFIG, impl as unknown as typeof fetch).readTable();
    const batch = new URL(calls.find((c) => c.includes("batchGet"))!);
    expect(batch.searchParams.getAll("ranges")).toEqual(["'Residents'!A2:A", "'Residents'!C2:C", "'Residents'!D2:D"]);
    expect(t.rows).toEqual([["Sam O'Connor", "", "sam@example.org", "Como Men's House"]]);
  });

  it("names columns past Z", () => {
    expect([columnLetter(0), columnLetter(25), columnLetter(26), columnLetter(27)]).toEqual(["A", "Z", "AA", "AB"]);
  });
});

describe("rosterSyncItems", () => {
  const health = (patch = {}) => ({
    configured: true,
    lastRun: { ok: true, error: null, refusedColumns: [] as string[], createdAt: NOW },
    lastSuccessAt: NOW.toISOString(),
    openReviews: 0,
    ...patch,
  });

  it("says nothing when the sheet is off, or all is well", () => {
    expect(rosterSyncItems(health({ configured: false, openReviews: 3 }), NOW)).toEqual([]);
    expect(rosterSyncItems(health(), NOW)).toEqual([]);
  });

  it("names the column to remove when the sheet was refused", () => {
    const [item] = rosterSyncItems(health({ lastRun: { ok: false, error: "x", refusedColumns: ["Bank Account"], createdAt: NOW } }), NOW);
    expect(item).toMatchObject({ id: "roster-refused", overdue: true });
    expect(item.subtitle).toContain('"Bank Account"');
  });

  it("raises a stale sync after 36 hours, and the review count", () => {
    const items = rosterSyncItems(health({ lastSuccessAt: "2026-09-29T00:00:00Z", openReviews: 2 }), NOW);
    expect(items.map((i) => i.id)).toEqual(["roster-stale", "roster-review"]);
    expect(items[1].title).toBe("2 roster changes to review");
  });
});
