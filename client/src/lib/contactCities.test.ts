import { describe, expect, it } from "vitest";
import { cityLabel, citiesWithHouses } from "./contactCities";

const HOUSES = [
  { city: "Columbus", state: "OH", region: "East Central" },
  { city: "Cincinnati", state: "OH", region: "East Central" },
  { city: "Columbus", state: "OH", region: "East Central" },
  { city: "Lawrence", state: "KS", region: "West Central" },
];

describe("contact cities", () => {
  it("names a city with its state, as the migration's backfill does", () => {
    expect(cityLabel({ city: "Kansas City", state: "MO" })).toBe("Kansas City, MO");
  });

  it("offers each city in a region once, A to Z", () => {
    expect(citiesWithHouses(HOUSES, "East Central")).toEqual(["Cincinnati, OH", "Columbus, OH"]);
  });

  it("offers every region's cities for all regions", () => {
    expect(citiesWithHouses(HOUSES, "all")).toEqual(["Cincinnati, OH", "Columbus, OH", "Lawrence, KS"]);
  });
});
