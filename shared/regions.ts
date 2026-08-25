/**
 * SPO's regions and the chapters within each, from the official SPO Regions map.
 *
 * This is the single source of truth for both. The region filters, the property
 * form, the settings permission grid and the demo seed all read from here, so
 * the list can never drift between them (it used to be copied into five files,
 * which is how one of them ended up with a different casing that silently broke
 * filtering).
 *
 * `National` is a catch-all for a property that does not belong to a campus
 * region (e.g. a national office); it has no chapters.
 */
export const REGIONS = [
  "East Central",
  "Northeast",
  "Northwest",
  "Southeast",
  "Southwest",
  "West Central",
  "National",
] as const;

export type Region = (typeof REGIONS)[number];

/** The chapters within each region. Adding a chapter is a one-line edit here. */
export const CHAPTERS_BY_REGION: Record<string, string[]> = {
  "Northwest": ["University of Minnesota", "University of St. Thomas", "Twin Cities Young Adults"],
  "East Central": ["Ohio State University", "University of Cincinnati", "Columbus Young Adults"],
  "Northeast": ["Boston Area Colleges", "Rutgers University", "Seton Hall University"],
  "West Central": ["Benedictine College", "University of Kansas", "Kansas City Young Adults"],
  "Southwest": [
    "Arizona State University",
    "Texas State University",
    "Bryan College Station Young Adults",
    "University of St. Thomas - Houston",
  ],
  "Southeast": ["University of Central Florida", "University of South Florida"],
  "National": [],
};

/** Chapters for a region, or an empty list if the region is unset or unknown. */
export function chaptersForRegion(region: string | null | undefined): string[] {
  return (region && CHAPTERS_BY_REGION[region]) || [];
}
