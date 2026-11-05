import type { Property } from "@shared/schema";

/**
 * A house's city as a contact's "City servicing" stores it: "Columbus, OH".
 * The state keeps two cities of the same name apart. Migration 0047 wrote the
 * existing contacts' cities in this same form, so the two must not drift.
 */
export function cityLabel(house: Pick<Property, "city" | "state">): string {
  return `${house.city}, ${house.state}`;
}

/** The cities SPO has houses in, in one region or ("all") every region, A to Z. */
export function citiesWithHouses(houses: Pick<Property, "city" | "state" | "region">[], region: string): string[] {
  const inRegion = region === "all" ? houses : houses.filter((house) => house.region === region);
  return Array.from(new Set(inRegion.map(cityLabel))).sort((a, b) => a.localeCompare(b));
}
