/**
 * The house import maps SPO's property sheet onto the portal's house record.
 * Addresses here are made up; the real sheet is never committed.
 */
import { describe, it, expect } from "vitest";
import { housesFromRows, parseHouseCsv, REGION_CODES, CHAPTER_CODES } from "../import-houses";
import { CHAPTERS_BY_REGION, REGIONS } from "../../shared/regions";

const HEADER = "Region,Chapter,Address,City,State,Zip Code,Owned or Rented,Household or Office,Men or Women,Capacity (Legal),Capacity (Mission),# Bedrooms,# Baths,Total SF,Nickname";

function csv(...lines: string[]): string {
  return [HEADER, ...lines].join("\n");
}

const rows = (text: string) => parseHouseCsv(text).rows;

describe("the sheet's codes", () => {
  it("map every region code onto a portal region", () => {
    for (const region of Object.values(REGION_CODES)) expect(REGIONS).toContain(region);
  });

  it("map every chapter code onto a chapter the property form offers", () => {
    const all = Object.values(CHAPTERS_BY_REGION).flat();
    for (const chapter of Object.values(CHAPTER_CODES)) expect(all).toContain(chapter);
  });
});

describe("a house row", () => {
  it("becomes a house with the sheet's figures, named by its nickname", () => {
    const [outcome] = housesFromRows(rows(csv('WC,BC,"1 Example St",Atchison,KS,66002,Owned,Household,Women,8,8,4,3,"2,699",Hilltop')));
    expect(outcome.kind).toBe("house");
    if (outcome.kind !== "house") return;
    expect(outcome.house).toMatchObject({
      name: "Hilltop",
      streetAddress: "1 Example St",
      city: "Atchison",
      state: "KS",
      zipCode: "66002",
      address: "1 Example St, Atchison, KS 66002",
      region: "West Central",
      chapter: "Benedictine College",
      ownership: "owned",
      bedrooms: 4,
      bathrooms: "3",
      squareFootage: 2699,
      household: "women",
      capacityLegal: 8,
      capacityMission: 8,
    });
  });

  it("is named by its street address when the sheet has no nickname", () => {
    const [outcome] = housesFromRows(rows(csv("SE,USF,2 Example Dr,Tampa,FL,33613,Rented,Household,Women,6,6,3,2,1515,")));
    expect(outcome.kind === "house" && outcome.house.name).toBe("2 Example Dr");
  });

  it("gets its city after a nickname another house shares", () => {
    const outcomes = housesFromRows(
      rows(csv("EC,UC,3 Example Dr,Cincinnati,OH,45219,Rented,Household,Women,5,5,3,3,1415,Cana", "SW,TXST,4 Example Pkwy,San Marcos,TX,78666,Rented,Household,Women,,10,5,3,2644,Cana")),
    );
    expect(outcomes.map((o) => o.kind === "house" && o.house.name)).toEqual(["Cana (Cincinnati)", "Cana (San Marcos)"]);
  });

  it("keeps half baths and leaves blank figures empty", () => {
    const [outcome] = housesFromRows(rows(csv("WC,KU,5 Example Rd,Lawrence,KS,66044,Rented,Household,Men,6,10,5,3.5,,The Ark")));
    expect(outcome.kind === "house" && outcome.house).toMatchObject({ bathrooms: "3.5", squareFootage: null });
  });

  it("reads N/A as blank", () => {
    const [outcome] = housesFromRows(rows(csv("NW,UMN,6 Example Ave,Minneapolis,MN,55414,Rented,Household,Men,N/A,50,N/A,N/A,N/A,Frat")));
    expect(outcome.kind === "house" && outcome.house).toMatchObject({ bedrooms: null, bathrooms: null, squareFootage: null, household: "men", capacityLegal: null, capacityMission: 50 });
  });
});

describe("rows that are not houses", () => {
  it("leaves an office out rather than making it a house", () => {
    const [outcome] = housesFromRows(rows(csv("NatO,NatO,7 Example Ave,Mendota Heights,MN,55120,Owned,Office,Office,N/A,N/A,,,,National Office")));
    expect(outcome).toMatchObject({ kind: "office", address: "7 Example Ave, Mendota Heights, MN 55120" });
  });

  it.each([
    ["an unknown region code", "ZZ,BC,8 Example St,Atchison,KS,66002,Owned,Household,Women,,,4,3,,", /region code "ZZ"/],
    ["an unknown chapter code", "WC,XYZ,8 Example St,Atchison,KS,66002,Owned,Household,Women,,,4,3,,", /chapter code "XYZ"/],
    ["a chapter in the wrong region", "WC,OSU,8 Example St,Atchison,KS,66002,Owned,Household,Women,,,4,3,,", /not a chapter in West Central/],
    ["an ownership that is neither", "WC,BC,8 Example St,Atchison,KS,66002,Leased,Household,Women,,,4,3,,", /Owned or Rented/],
    ["a bedroom count that is not a number", "WC,BC,8 Example St,Atchison,KS,66002,Owned,Household,Women,,,four,3,,", /bedrooms/],
  ])("names the row and the reason for %s", (_label, line, reason) => {
    const [outcome] = housesFromRows(rows(csv(line)));
    expect(outcome.kind).toBe("error");
    expect(outcome.kind === "error" && outcome.message).toMatch(/^Row 2/);
    expect(outcome.kind === "error" && outcome.message).toMatch(reason);
  });
});

describe("the file", () => {
  it("names a missing column", () => {
    expect(parseHouseCsv("Region,Chapter\nWC,BC").fileErrors[0]).toMatch(/missing a column for: address/);
  });

  it("refuses an empty file", () => {
    expect(parseHouseCsv("").fileErrors).toEqual(["The file is empty"]);
  });
});

describe("men or women", () => {
  it("is left empty when the sheet leaves it blank", () => {
    const [outcome] = housesFromRows(rows(csv("SE,USF,2 Example Dr,Tampa,FL,33613,Rented,Household,,6,6,3,2,1515,")));
    expect(outcome.kind === "house" && outcome.house.household).toBeNull();
  });

  it("refuses a word that is neither, naming the row", () => {
    const [outcome] = housesFromRows(rows(csv("SE,USF,2 Example Dr,Tampa,FL,33613,Rented,Household,Coed,6,6,3,2,1515,")));
    expect(outcome).toMatchObject({ kind: "error", row: 2 });
    expect(outcome.kind === "error" && outcome.message).toContain('"Men or Women" must be Men or Women, not "Coed"');
  });
});
