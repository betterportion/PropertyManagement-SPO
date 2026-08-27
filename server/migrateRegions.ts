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

// Maps every legacy region spelling to the canonical name in shared/regions.ts.
// Two families of legacy values exist: kebab-case slugs once written by
// Settings.tsx ("north-west"), and the old two-word Title Case once handed out
// as an admin's default regions ("North West"). Both must resolve to the
// single-word canonical form ("Northwest") that records actually store.
export const KEBAB_TO_TITLE: Record<string, string> = {
  "west-central": "West Central",
  "east-central": "East Central",
  "north-west": "Northwest",
  "south-west": "Southwest",
  "north-east": "Northeast",
  "south-east": "Southeast",
  national: "National",
  "North West": "Northwest",
  "South West": "Southwest",
  "North East": "Northeast",
  "South East": "Southeast",
};

/** Convert a single region value to its canonical form (see shared/regions.ts). */
export function normalizeRegion(value: string): string {
  return KEBAB_TO_TITLE[value] ?? value;
}

/** Normalize every element of an allowedRegions array. */
export function normalizeRegions(regions: string[]): string[] {
  return regions.map(normalizeRegion);
}

/**
 * Idempotent startup migration: give existing billing records a region.
 *
 * Billing records gained a region column so they could be filtered like every
 * other record type. Rows created before that change have an empty region,
 * which the authorization layer treats as inaccessible to non-admins. Where a
 * row is linked to a maintenance contact, that contact's region is the correct
 * value; rows with no linked contact are left empty for an admin to set, since
 * guessing a region would be worse than showing nothing.
 */
export async function backfillBillingRegions(): Promise<void> {
  try {
    const { billingRecords, maintenanceContacts } = await import("@shared/schema");
    const { eq, and } = await import("drizzle-orm");

    // Only rows that still have no region. Once backfilled, this selects
    // nothing and the migration costs a single indexed query per boot.
    const rows = await db
      .select({ id: billingRecords.id, contactRegion: maintenanceContacts.region })
      .from(billingRecords)
      .innerJoin(maintenanceContacts, eq(maintenanceContacts.id, billingRecords.contactId))
      .where(eq(billingRecords.region, ""));

    for (const row of rows) {
      if (!row.contactRegion) continue;
      const updated = await db
        .update(billingRecords)
        .set({ region: row.contactRegion, updatedAt: new Date() })
        // Only touch rows that are still empty, so this stays idempotent and
        // never overwrites a region an admin has since corrected by hand.
        .where(and(eq(billingRecords.id, row.id), eq(billingRecords.region, "")))
        .returning({ id: billingRecords.id });

      if (updated.length > 0) {
        console.log(`[billing-region-backfill] ${row.id} → ${row.contactRegion}`);
      }
    }
  } catch (err) {
    // Non-fatal: an un-backfilled row is hidden from non-admins, which is the
    // safe direction to fail in.
    console.error("[billing-region-backfill] failed (non-fatal):", err);
  }
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
