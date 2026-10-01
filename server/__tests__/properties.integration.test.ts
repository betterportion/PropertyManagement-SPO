/**
 * A house's records, against a real PostgreSQL database: moving the house to
 * another region, and counting what deleting it would erase.
 *
 * Region scoping reads each record's OWN copy of its house's region -- the
 * roster, the HH fees, the requests and the rest never join back to the
 * property. So a region change that stopped at the property row would leave
 * the old region's RA reading the house's records and the new one reading
 * none. `storage.updateProperty` carries the new region to every one of those
 * copies, and only a real database can show that the SQL picks the right rows:
 * a mock cannot tell "this house's rows" from "every row".
 *
 * Isolation follows `auditRetention.integration.test.ts`: a schema created for
 * this run and dropped afterwards, tables copied from `public` with LIKE so they
 * cannot drift, and a connection whose `search_path` names only that schema.
 * Skipped when no database is configured, so `npm test` still runs offline.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import { getTableName, type Table } from "drizzle-orm";
import {
  properties,
  residents,
  rentPayments,
  securityDeposits,
  depositDeductions,
  residentDocuments,
  walkthroughs,
  walkthroughRooms,
  walkthroughPhotos,
  maintenanceSchedules,
  propertySetupItems,
  propertyBudgets,
  repairBudgets,
  propertyQuickbooksLinks,
  propertySpend,
  moveOutChecklists,
  moveOutPhotos,
  maintenanceRequests,
  assets,
  invoices,
  tasks,
} from "@shared/schema";

const { TEST_SCHEMA, TEST_DATABASE_URL } = vi.hoisted(() => ({
  TEST_SCHEMA: `region_move_itest_${process.pid}`,
  TEST_DATABASE_URL: process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? "",
}));

/** The application's pool, pinned to the test schema. Nothing else is replaced. */
vi.mock("../db", async () => {
  const { default: pg } = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");

  // Mirrors server/db.ts: encrypt anything that is not on this machine.
  const configured = process.env.DATABASE_SSL?.trim().toLowerCase();
  let ssl: false | { rejectUnauthorized: boolean };
  if (configured === "disable") {
    ssl = false;
  } else if (configured === "no-verify") {
    ssl = { rejectUnauthorized: false };
  } else if (configured === "require") {
    ssl = { rejectUnauthorized: true };
  } else {
    let local = false;
    try {
      const { hostname } = new URL(TEST_DATABASE_URL);
      local = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
    } catch {
      local = false;
    }
    ssl = local ? false : { rejectUnauthorized: true };
  }

  const pool = new pg.Pool({
    connectionString: TEST_DATABASE_URL,
    ssl,
    max: 2,
    options: `-c search_path="${TEST_SCHEMA}"`,
  });
  pool.on("error", () => {
    // A dropped idle connection must not take the test runner down.
  });

  return { db: drizzle(pool), pool };
});

const { storage }: typeof import("../storage") = await import("../storage");
const { db, pool }: typeof import("../db") = await import("../db");

const WEST = "West Central";
const EAST = "East Central";

/**
 * Every table that keeps its own copy of a house's region, plus the two
 * `properties` and `walkthrough_rooms` rows the fixtures hang off.
 */
const TABLES: Table[] = [
  properties,
  residents,
  rentPayments,
  securityDeposits,
  depositDeductions,
  residentDocuments,
  walkthroughs,
  walkthroughRooms,
  walkthroughPhotos,
  maintenanceSchedules,
  propertySetupItems,
  propertyBudgets,
  repairBudgets,
  propertyQuickbooksLinks,
  propertySpend,
  moveOutChecklists,
  moveOutPhotos,
  maintenanceRequests,
  assets,
  invoices,
  tasks,
];

/** The rows that carry a region, by table, for one house. */
type HouseRows = Record<string, string[]>;

/**
 * One house in `region` with a row in every region-carrying table, and the
 * ids of those rows so the test can read each one back.
 */
async function seedHouse(key: string, region: string): Promise<HouseRows> {
  const address = `${key} Main St, St Paul, MN 55101`;
  const id = (suffix: string) => `${key}-${suffix}`;
  const propertyId = id("house");
  const common = { region, buildingAddress: address };

  await db.insert(properties).values({
    id: propertyId, name: `${key} House`, streetAddress: `${key} Main St`,
    city: "St Paul", state: "MN", zipCode: "55101", address, region,
  });
  await db.insert(residents).values({
    id: id("resident"), propertyId, firstName: "Maria", lastName: key, email: `${key}@example.org`, ...common,
  });
  const residentId = id("resident");
  await db.insert(rentPayments).values({ id: id("fee"), residentId, propertyId, period: "2026-09", amount: "450.00", ...common });
  await db.insert(securityDeposits).values({ id: id("deposit"), residentId, propertyId, amountHeld: "500.00", ...common });
  await db.insert(depositDeductions).values({
    id: id("deduction"), residentId, propertyId, description: "Broken blind", amount: "20.00", chargeDate: new Date("2026-09-01"), ...common,
  });
  await db.insert(residentDocuments).values({ id: id("document"), residentId, documentKey: "lease", region });
  await db.insert(walkthroughs).values({ id: id("walkthrough"), propertyId, ...common });
  await db.insert(walkthroughRooms).values({
    id: id("room"), walkthroughId: id("walkthrough"), propertyId, name: "Kitchen", buildingAddress: address, displayOrder: 1,
  });
  // A room from before walkthroughs existed: it knows its house, not a walkthrough.
  await db.insert(walkthroughRooms).values({
    id: id("legacy-room"), propertyId, name: "Porch", buildingAddress: address, displayOrder: 2,
  });
  const photo = { imageUrl: "/uploads/x.jpg", location: "Kitchen", uploadedBy: "staff@example.org", ...common };
  await db.insert(walkthroughPhotos).values({ id: id("photo"), roomId: id("room"), ...photo });
  await db.insert(walkthroughPhotos).values({ id: id("legacy-photo"), roomId: id("legacy-room"), ...photo });
  await db.insert(maintenanceSchedules).values({
    id: id("schedule"), propertyId, title: "Furnace filter", category: "hvac", intervalMonths: 3, nextDueDate: new Date("2026-12-01"), ...common,
  });
  await db.insert(propertySetupItems).values({ id: id("setup"), propertyId, itemKey: "insurance", region });
  await db.insert(propertyBudgets).values({ id: id("budget"), propertyId, year: 2026, amount: "1000.00", region });
  await db.insert(repairBudgets).values({ id: id("repair-budget"), propertyId, fiscalYear: 2027, amount: "10500.00", region });
  await db.insert(propertyQuickbooksLinks).values({ propertyId, externalId: "101", externalName: `${key} House`, region });
  await db.insert(propertySpend).values({ id: id("spend"), propertyId, fiscalYear: 2027, amount: "1200.00", region, syncedAt: new Date() });
  await db.insert(maintenanceRequests).values({
    id: id("request"), title: "Leaky tap", description: "Drips", category: "plumbing", priority: "low",
    location: "Kitchen", submittedBy: `${key}@example.org`, ...common,
  });
  await db.insert(assets).values({
    id: id("asset"), propertyId, name: "Fridge", category: "appliance", type: "movable", ageInYears: 2, location: "Kitchen", ...common,
  });
  await db.insert(invoices).values({
    id: id("invoice"), invoiceNumber: `INV-${key}`, service: "Plumbing", amount: "80.00", dueDate: new Date("2026-10-01"), ...common,
  });
  await db.insert(tasks).values({ id: id("lease-task"), title: "Renew or leave?", region, sourceKey: `lease-renewal:${propertyId}:2027-01-01` });
  await db.insert(tasks).values({ id: id("utilities-task"), title: "Turn off utilities", region, sourceKey: `utilities-lease:${propertyId}:2027-06-30` });
  await db.insert(tasks).values({ id: id("move-out-task"), title: "Maria moves out", region, sourceKey: `move-out:${residentId}:2027-05-20` });
  await db.insert(moveOutChecklists).values({ residentId, region });
  await db.insert(moveOutPhotos).values({ id: id("move-out-photo"), residentId, imageUrl: "/uploads/m.jpg", region });

  return {
    residents: [id("resident")],
    rent_payments: [id("fee")],
    security_deposits: [id("deposit")],
    deposit_deductions: [id("deduction")],
    resident_documents: [id("document")],
    walkthroughs: [id("walkthrough")],
    walkthrough_photos: [id("photo"), id("legacy-photo")],
    maintenance_schedules: [id("schedule")],
    property_setup_items: [id("setup")],
    property_budgets: [id("budget")],
    repair_budgets: [id("repair-budget")],
    property_spend: [id("spend")],
    maintenance_requests: [id("request")],
    assets: [id("asset")],
    invoices: [id("invoice")],
    tasks: [id("lease-task"), id("utilities-task"), id("move-out-task")],
    move_out_photos: [id("move-out-photo")],
  };
}

/** The region each seeded row now holds, as `table/id -> region`. */
async function regionsOf(rows: HouseRows): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  for (const [table, ids] of Object.entries(rows)) {
    const { rows: result } = await pool.query<{ id: string; region: string }>(
      `select id, region from "${table}" where id = any($1)`,
      [ids],
    );
    expect(result.map((r) => r.id).sort()).toEqual([...ids].sort());
    for (const row of result) found[`${table}/${row.id}`] = row.region;
  }
  return found;
}

const allIn = (region: string, regions: Record<string, string>) =>
  Object.fromEntries(Object.keys(regions).map((key) => [key, region]));

describe.skipIf(!TEST_DATABASE_URL)("a house's records, against PostgreSQL", () => {
  beforeAll(async () => {
    await pool.query(`drop schema if exists "${TEST_SCHEMA}" cascade`);
    await pool.query(`create schema "${TEST_SCHEMA}"`);
    for (const table of TABLES) {
      const name = getTableName(table);
      await pool.query(`create table "${TEST_SCHEMA}"."${name}" (like public."${name}" including all)`);
    }
    // If this ever fails, the unqualified table names in storage.ts would be
    // resolving somewhere else -- possibly the real tables -- and nothing
    // below may run.
    const { rows } = await pool.query<{ schema: string; isolated: boolean }>(
      `select current_schema() as schema,
              to_regclass('residents')::oid = to_regclass('"${TEST_SCHEMA}".residents')::oid as isolated`,
    );
    expect(rows[0].schema).toBe(TEST_SCHEMA);
    expect(rows[0].isolated).toBe(true);
  }, 60_000);

  beforeEach(async () => {
    for (const table of TABLES) await pool.query(`truncate table "${getTableName(table)}"`);
  });

  afterAll(async () => {
    try {
      await pool.query(`drop schema if exists "${TEST_SCHEMA}" cascade`);
    } finally {
      await pool.end();
    }
  }, 60_000);

  it("carries the new region to every record the house keeps a copy of it on, and to nobody else's", async () => {
    const moving = await seedHouse("a1", WEST);
    const staying = await seedHouse("b2", WEST);
    // A regional reminder names the region, not a house, and stays with it.
    await db.insert(tasks).values({ id: "regional-task", title: "Book walkthroughs", region: WEST, sourceKey: `walkthrough:fall:${WEST}:2026` });

    const property = await storage.updateProperty("a1-house", { region: EAST });

    expect(property.region).toBe(EAST);
    const moved = await regionsOf(moving);
    expect(moved).toEqual(allIn(EAST, moved));
    const untouched = await regionsOf(staying);
    expect(untouched).toEqual(allIn(WEST, untouched));
    expect(await regionsOf({ tasks: ["regional-task"] })).toEqual({ "tasks/regional-task": WEST });
    // The QuickBooks link is keyed by its house, not an id, so it is read here.
    const { rows: links } = await pool.query<{ property_id: string; region: string }>(
      `select property_id, region from property_quickbooks_links order by property_id`,
    );
    expect(links).toEqual([
      { property_id: "a1-house", region: EAST },
      { property_id: "b2-house", region: WEST },
    ]);
    const { rows: checklists } = await pool.query<{ resident_id: string; region: string }>(
      `select resident_id, region from move_out_checklists order by resident_id`,
    );
    expect(checklists).toEqual([
      { resident_id: "a1-resident", region: EAST },
      { resident_id: "b2-resident", region: WEST },
    ]);
  });

  it("finds the house's requests and invoices by the address it had before the same edit changed it", async () => {
    const moving = await seedHouse("c3", WEST);

    await storage.updateProperty("c3-house", {
      region: EAST,
      streetAddress: "9 New Rd",
      address: "9 New Rd, St Paul, MN 55101",
    });

    const moved = await regionsOf({
      maintenance_requests: moving.maintenance_requests,
      invoices: moving.invoices,
    });
    expect(moved).toEqual(allIn(EAST, moved));
  });

  it("leaves every record alone on an edit that keeps the region", async () => {
    const house = await seedHouse("d4", WEST);
    // A row whose copy disagrees with its house: an edit that is not a move
    // must not quietly rewrite it.
    await pool.query(`update residents set region = 'west-central' where id = 'd4-resident'`);

    await storage.updateProperty("d4-house", { bedrooms: 6, region: WEST });

    expect((await regionsOf({ residents: house.residents }))["residents/d4-resident"]).toBe("west-central");
  });

  it("counts the roster and money rows a delete would erase, for that house only", async () => {
    await seedHouse("e5", WEST);
    await db.insert(properties).values({
      id: "empty-house", name: "Empty House", streetAddress: "5 Oak St", city: "St Paul",
      state: "MN", zipCode: "55101", address: "5 Oak St, St Paul, MN 55101", region: WEST,
    });

    expect(await storage.getPropertyDeleteBlockers("e5-house")).toEqual({ residents: 1, hhFees: 1, deposits: 1, deductions: 1 });
    expect(await storage.getPropertyDeleteBlockers("empty-house")).toEqual({ residents: 0, hhFees: 0, deposits: 0, deductions: 0 });
  });
});
