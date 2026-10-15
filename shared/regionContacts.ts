/**
 * Who a household calls, by region.
 *
 * From section 1 of "SPO Portal: Information We Need From SPO" (Joseph, 2026):
 * an urgent house problem goes to the region's regional administrator, one
 * number per region, answered roughly 7 AM to 9 PM; a life-threatening one to
 * 911 first; and a non-urgent question to the RA or to property@spo.org.
 * Admins and the region's own RAs keep the number current (1.8).
 *
 * The line below is SPO's chosen wording (1.6), shown to every household
 * whether or not their region's contact has been entered yet.
 */
export const EMERGENCY_LINE = "Fire, gas leak or anyone hurt: call 911 first, then call SPO.";

/** Where a non-urgent question goes when the region's RA has no email on file (1.5). */
export const SPO_PROPERTY_EMAIL = "property@spo.org";

/** What the household's hub is told about its region's contact: named fields, never the row. */
export interface EmergencyContact {
  name: string;
  phone: string;
  email: string | null;
  hours: string | null;
}
