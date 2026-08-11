/**
 * Idempotent startup migration: convert kebab-case allowedRegions to Title Case.
 *
 * Old format (written by Settings.tsx before the fix): "west-central"
 * Canonical format (matching data in maintenance requests, contacts, properties): "West Central"
 *
 * This runs on every boot; rows that are already in Title Case are left untouched.
 */
import { db } from "./db";
import { userPermissions } from "@shared/schema";

export const KEBAB_TO_TITLE: Record<string, string> = {
  "west-central": "West Central",
  "east-central": "East Central",
  "north-west": "North West",
  "south-west": "South West",
  "north-east": "North East",
  "south-east": "South East",
};

/** Convert a single region value to the canonical Title Case format. */
export function normalizeRegion(value: string): string {
  return KEBAB_TO_TITLE[value] ?? value;
}

/** Normalize every element of an allowedRegions array. */
export function normalizeRegions(regions: string[]): string[] {
  return regions.map(normalizeRegion);
}

export async function migrateRegionsToTitleCase(): Promise<void> {
  try {
    const rows = await db.select().from(userPermissions);
    const { eq } = await import("drizzle-orm");

    for (const row of rows) {
      const current = row.allowedRegions ?? [];
      const fixed = current.map(normalizeRegion);
      if (fixed.some((v, i) => v !== current[i])) {
        await db
          .update(userPermissions)
          .set({ allowedRegions: fixed, updatedAt: new Date() })
          .where(eq(userPermissions.userId, row.userId));
        console.log(
          `[region-migration] userId=${row.userId}: ${JSON.stringify(current)} → ${JSON.stringify(fixed)}`
        );
      }
    }
  } catch (err) {
    // Log but do not crash the server — the normalization at the
    // authorization boundary handles any rows that weren't updated.
    console.error("[region-migration] failed (non-fatal):", err);
  }
}
