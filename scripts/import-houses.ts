/**
 * Import SPO's houses from the National Property Info sheet, saved as CSV.
 *
 *   DATABASE_URL=postgresql://... npm run db:import-houses -- path/to/houses.csv
 *   DATABASE_URL=postgresql://... npm run db:import-houses -- path/to/houses.csv --dry-run
 *
 * The CSV is the sheet as exported, with its own headers (Region, Chapter,
 * Address, City, State, Zip Code, Owned or Rented, Household or Office, Men or
 * Women, Capacity (Legal), Capacity (Mission), # Bedrooms, # Baths, Total SF,
 * Nickname). It is never committed: the repository is public and the rows are
 * where students live, so the file lives outside the repo and its path is
 * given at run time.
 *
 * What one row becomes: a house written through the same storage layer and
 * schema the "Add property" form uses, with its setup checklist, exactly as
 * POST /api/properties does. Offices are left out (the portal manages houses).
 * The nickname is the house name; a house without one is named by its street
 * address, and a nickname two houses share gets the city after it. Men or
 * women and the two capacities (legal, what the city allows; mission, the most
 * SPO puts in the house) are the house's own columns, shown on its page.
 *
 * Safe to run twice: a row whose full address is already a house is skipped,
 * never updated, so a correction made in the portal is not overwritten by an
 * older sheet. `--dry-run` parses and reports without touching the database.
 */
import fs from "fs";
import Papa from "papaparse";

import { CHAPTERS_BY_REGION, type Region } from "../shared/regions";
import { setupItemsFor } from "../shared/propertySetup";
import { insertPropertySchema, type InsertPropertyWithAddress } from "../shared/schema";

/** The sheet's region codes, as the portal names them (shared/regions.ts). */
export const REGION_CODES: Record<string, Region> = {
  SE: "Southeast",
  SW: "Southwest",
  NE: "Northeast",
  NW: "Northwest",
  EC: "East Central",
  WC: "West Central",
  NATO: "National",
};

/** The sheet's chapter codes, as the property form names them. */
export const CHAPTER_CODES: Record<string, string> = {
  USF: "University of South Florida",
  BC: "Benedictine College",
  KU: "University of Kansas",
  UMN: "University of Minnesota",
  UST: "University of St. Thomas",
  TCYA: "Twin Cities Young Adults",
  SHU: "Seton Hall University",
  RU: "Rutgers University",
  BOS: "Boston Area Colleges",
  OSU: "Ohio State University",
  UC: "University of Cincinnati",
  ASU: "Arizona State University",
  TXST: "Texas State University",
  BCS: "Bryan College Station Young Adults",
};

export type SheetRow = Record<string, string>;

export type HouseOutcome =
  | { kind: "house"; row: number; house: InsertPropertyWithAddress }
  | { kind: "office"; row: number; address: string }
  | { kind: "error"; row: number; message: string };

function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

const COLUMNS = {
  region: "region",
  chapter: "chapter",
  address: "address",
  city: "city",
  state: "state",
  zip: "zipcode",
  ownership: "ownedorrented",
  kind: "householdoroffice",
  gender: "menorwomen",
  capacityLegal: "capacitylegal",
  capacityMission: "capacitymission",
  bedrooms: "bedrooms",
  baths: "baths",
  squareFeet: "totalsf",
  nickname: "nickname",
} as const;

const REQUIRED = [COLUMNS.region, COLUMNS.chapter, COLUMNS.address, COLUMNS.city, COLUMNS.state, COLUMNS.zip, COLUMNS.ownership, COLUMNS.kind];

function cell(row: SheetRow, column: string): string {
  const value = (row[column] ?? "").trim();
  return value === "N/A" || value === "n/a" ? "" : value;
}

/** "1,889" -> 1889; "" or "N/A" -> null; anything else is left to the schema to refuse. */
function numberOrNull(value: string): string | null {
  const cleaned = value.replace(/,/g, "").trim();
  return cleaned === "" ? null : cleaned;
}

/** Parses the sheet's CSV text into the rows as given, headers normalised. */
export function parseHouseCsv(text: string): { rows: SheetRow[]; fileErrors: string[] } {
  const source = text.replace(/^ /, "");
  if (source.trim() === "") return { rows: [], fileErrors: ["The file is empty"] };
  const parsed = Papa.parse<SheetRow>(source, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: normalizeHeader,
  });
  const present = new Set(parsed.meta.fields ?? []);
  const missing = REQUIRED.filter((column) => !present.has(column));
  if (missing.length > 0) return { rows: [], fileErrors: [`The file is missing a column for: ${missing.join(", ")}`] };
  return { rows: parsed.data, fileErrors: [] };
}

/**
 * Every row of the sheet as what it becomes: a house, an office left out, or
 * an error naming the row. Pure, so the mapping is tested without a database.
 */
export function housesFromRows(rows: SheetRow[]): HouseOutcome[] {
  // A nickname two houses share ("Cana" in Cincinnati and in San Marcos) gets
  // its city after it, so the house list does not show two identical names.
  const nicknameCount = new Map<string, number>();
  for (const row of rows) {
    const nickname = cell(row, COLUMNS.nickname);
    if (nickname) nicknameCount.set(nickname, (nicknameCount.get(nickname) ?? 0) + 1);
  }

  return rows.map((row, index): HouseOutcome => {
    const rowNumber = index + 2; // 1 is the header
    const streetAddress = cell(row, COLUMNS.address);
    const city = cell(row, COLUMNS.city);
    const state = cell(row, COLUMNS.state).toUpperCase();
    const zipCode = cell(row, COLUMNS.zip);
    const address = `${streetAddress}, ${city}, ${state} ${zipCode}`;

    if (cell(row, COLUMNS.kind).toLowerCase() !== "household") {
      return { kind: "office", row: rowNumber, address };
    }

    const regionCode = cell(row, COLUMNS.region).toUpperCase();
    const region = REGION_CODES[regionCode];
    if (!region) return { kind: "error", row: rowNumber, message: `Row ${rowNumber}: unknown region code "${cell(row, COLUMNS.region)}"` };

    const chapterCode = cell(row, COLUMNS.chapter).toUpperCase();
    const chapter = CHAPTER_CODES[chapterCode];
    if (!chapter) return { kind: "error", row: rowNumber, message: `Row ${rowNumber}: unknown chapter code "${cell(row, COLUMNS.chapter)}"` };
    if (!(CHAPTERS_BY_REGION[region] ?? []).includes(chapter)) {
      return { kind: "error", row: rowNumber, message: `Row ${rowNumber}: ${chapter} is not a chapter in ${region}` };
    }

    const ownership = cell(row, COLUMNS.ownership).toLowerCase();
    if (ownership !== "owned" && ownership !== "rented") {
      return { kind: "error", row: rowNumber, message: `Row ${rowNumber}: "Owned or Rented" must be Owned or Rented, not "${cell(row, COLUMNS.ownership)}"` };
    }

    const household = cell(row, COLUMNS.gender).toLowerCase();
    if (household !== "" && household !== "men" && household !== "women") {
      return { kind: "error", row: rowNumber, message: `Row ${rowNumber}: "Men or Women" must be Men or Women, not "${cell(row, COLUMNS.gender)}"` };
    }

    const nickname = cell(row, COLUMNS.nickname);
    const name = nickname ? ((nicknameCount.get(nickname) ?? 0) > 1 ? `${nickname} (${city})` : nickname) : streetAddress;

    const parsed = insertPropertySchema.safeParse({
      name,
      streetAddress,
      city,
      state,
      zipCode,
      region,
      chapter,
      ownership,
      bedrooms: numberOrNull(cell(row, COLUMNS.bedrooms)),
      bathrooms: numberOrNull(cell(row, COLUMNS.baths)),
      squareFootage: numberOrNull(cell(row, COLUMNS.squareFeet)),
      household: household === "" ? null : household,
      capacityLegal: numberOrNull(cell(row, COLUMNS.capacityLegal)),
      capacityMission: numberOrNull(cell(row, COLUMNS.capacityMission)),
    });
    if (!parsed.success) {
      const reasons = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
      return { kind: "error", row: rowNumber, message: `Row ${rowNumber} (${address}): ${reasons}` };
    }
    return { kind: "house", row: rowNumber, house: { ...parsed.data, address } };
  });
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const file = args.find((arg) => !arg.startsWith("--"));
  if (!file) {
    console.error("Usage: npm run db:import-houses -- <houses.csv> [--dry-run]");
    process.exitCode = 1;
    return;
  }

  const { rows, fileErrors } = parseHouseCsv(fs.readFileSync(file, "utf8"));
  if (fileErrors.length > 0) {
    for (const error of fileErrors) console.error(error);
    process.exitCode = 1;
    return;
  }

  const outcomes = housesFromRows(rows);
  const errors = outcomes.filter((o) => o.kind === "error");
  const offices = outcomes.filter((o) => o.kind === "office");
  const houses = outcomes.filter((o) => o.kind === "house");

  for (const error of errors) console.error(error.message);
  console.log(`${rows.length} rows: ${houses.length} houses, ${offices.length} offices left out, ${errors.length} with errors`);
  if (errors.length > 0) {
    // Nothing is written while any row is wrong: a half-imported list is
    // harder to finish than one run again after the sheet is fixed.
    console.error("Fix the rows above and run again; nothing was written.");
    process.exitCode = 1;
    return;
  }
  if (dryRun) {
    for (const { house } of houses) console.log(`  ${house.name} — ${house.address} (${house.region}, ${house.chapter}, ${house.ownership})`);
    console.log("Dry run: nothing was written.");
    return;
  }

  const { storage } = await import("../server/storage");
  let created = 0;
  let skipped = 0;
  for (const { house } of houses) {
    const existing = await storage.getPropertyByAddress(house.address);
    if (existing) {
      skipped += 1;
      console.log(`  already there: ${house.address} (${existing.name})`);
      continue;
    }
    const property = await storage.createProperty(house);
    await storage.createPropertySetupItems(
      setupItemsFor(property.ownership).map((item) => ({
        propertyId: property.id,
        itemKey: item.key,
        status: "open" as const,
        region: property.region,
      })),
    );
    created += 1;
    console.log(`  added: ${property.name} — ${property.address}`);
  }
  console.log(`Done: ${created} added, ${skipped} already there.`);
}

const isDirectRun = process.argv[1]?.endsWith("import-houses.ts");
if (isDirectRun) {
  main()
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(async () => {
      const { closeDatabase } = await import("../server/db");
      closeDatabase();
    });
}
