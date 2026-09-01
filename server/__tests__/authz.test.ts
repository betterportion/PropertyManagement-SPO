/**
 * Tests for the authorization rules themselves, in server/authz.ts.
 *
 * These call the real helpers that every route uses, rather than a copy of
 * them. That distinction matters: an earlier version of these tests
 * re-implemented the region logic inline, which meant the tests kept passing
 * while the real rule drifted. Anything asserted here is asserted about the
 * code that actually runs in production.
 *
 * No database and no HTTP server: the data layer is stubbed, so this suite is
 * pure logic and runs in milliseconds.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Response } from "express";

// authz.ts pulls in storage and auth, both of which reach for a database
// connection when they are imported for real.
vi.mock("../db", () => ({ db: {}, pool: {} }));

const getUserId = vi.fn();
vi.mock("../auth", () => ({ getUserId: (...args: unknown[]) => getUserId(...args) }));

const getUser = vi.fn();
const getUserPermissions = vi.fn();
const getProperty = vi.fn();
vi.mock("../storage", () => ({
  storage: {
    getUser: (...args: unknown[]) => getUser(...args),
    getUserPermissions: (...args: unknown[]) => getUserPermissions(...args),
    getProperty: (...args: unknown[]) => getProperty(...args),
  },
}));

import {
  loadAuthContext,
  requireActiveUser,
  hasPermission,
  requirePermission,
  requireStaff,
  requireAdmin,
  canAccessRegion,
  requireRegion,
  requireRegionMove,
  filterByRegion,
  filterByRelatedRegion,
  ownsRecord,
  canReadMaintenanceRequest,
  requireMaintenanceRequestAccess,
  residentHouseAddress,
  type AuthContext,
  type PermissionName,
} from "../authz";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/**
 * A stand-in for the Express response, recording what a guard sent rather than
 * writing it anywhere. Guards only ever call `.status().json()`.
 */
function response() {
  const sent: { status?: number; message?: string } = {};
  const res = {
    status(code: number) {
      sent.status = code;
      return res;
    },
    json(body: { message?: string }) {
      sent.message = body?.message;
      return res;
    },
  };
  return Object.assign(res as unknown as Response, { sent });
}

/** Builds an AuthContext the way loadAuthContext would, without a database. */
function context(
  overrides: {
    role?: "admin" | "regional_administrator" | "resident";
    email?: string;
    allowedRegions?: string[];
    permissions?: Partial<Record<PermissionName, boolean>>;
    propertyId?: string | null;
  } = {},
): AuthContext {
  const role = overrides.role ?? "regional_administrator";
  return {
    userId: "user-1",
    user: {
      id: "user-1",
      email: overrides.email ?? "staff@example.com",
      role,
      isActive: true,
      propertyId: overrides.propertyId ?? null,
    } as AuthContext["user"],
    permissions: overrides.permissions as AuthContext["permissions"],
    isAdmin: role === "admin",
    isResident: role === "resident",
    allowedRegions: overrides.allowedRegions ?? [],
  };
}

beforeEach(() => {
  getUserId.mockReset().mockReturnValue("user-1");
  getUser.mockReset();
  getUserPermissions.mockReset().mockResolvedValue(undefined);
  getProperty.mockReset().mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Who is signed in
// ---------------------------------------------------------------------------

describe("loadAuthContext", () => {
  it("refuses a session pointing at a user who no longer exists", async () => {
    getUser.mockResolvedValue(undefined);
    expect(await loadAuthContext({} as never)).toBeNull();
  });

  it("refuses a deactivated account, which is what actually revokes access", async () => {
    // The session cookie survives deactivation until it expires, so this check
    // on the next request is the only thing that stops a disabled account.
    getUser.mockResolvedValue({ id: "user-1", email: "x@example.com", role: "admin", isActive: false });
    expect(await loadAuthContext({} as never)).toBeNull();
  });

  it("refuses an account whose active flag was never set", async () => {
    getUser.mockResolvedValue({ id: "user-1", email: "x@example.com", role: "admin", isActive: null });
    expect(await loadAuthContext({} as never)).toBeNull();
  });

  it("resolves role and regions for an active account", async () => {
    getUser.mockResolvedValue({
      id: "user-1",
      email: "boss@example.com",
      role: "admin",
      isActive: true,
    });
    getUserPermissions.mockResolvedValue({ allowedRegions: ["West Central"] });

    const ctx = await loadAuthContext({} as never);
    expect(ctx).not.toBeNull();
    expect(ctx!.isAdmin).toBe(true);
    expect(ctx!.isResident).toBe(false);
    expect(ctx!.allowedRegions).toEqual(["West Central"]);
  });

  it("treats a missing permissions row as no regions rather than crashing", async () => {
    getUser.mockResolvedValue({ id: "user-1", email: "a@example.com", role: "admin", isActive: true });
    getUserPermissions.mockResolvedValue(undefined);

    const ctx = await loadAuthContext({} as never);
    expect(ctx!.allowedRegions).toEqual([]);
    expect(ctx!.permissions).toBeUndefined();
  });
});

describe("requireActiveUser", () => {
  it("sends 403 and returns null for a deactivated account", async () => {
    getUser.mockResolvedValue({ id: "user-1", role: "admin", isActive: false });
    const res = response();

    expect(await requireActiveUser({} as never, res)).toBeNull();
    expect(res.sent.status).toBe(403);
  });

  it("returns the context and sends nothing for an active account", async () => {
    getUser.mockResolvedValue({ id: "user-1", email: "a@example.com", role: "admin", isActive: true });
    const res = response();

    expect(await requireActiveUser({} as never, res)).not.toBeNull();
    expect(res.sent.status).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

describe("hasPermission", () => {
  it("lets an admin through with no permissions row at all", () => {
    // The admin bypass. Without it, an administrator whose permissions row was
    // never created is locked out of the app they are supposed to administer.
    const ctx = context({ role: "admin", permissions: undefined });
    expect(hasPermission(ctx, "canManageUsers")).toBe(true);
    expect(hasPermission(ctx, "canViewBilling", "canManageBilling")).toBe(true);
  });

  it("lets an admin through even when every flag on their row is false", () => {
    const ctx = context({ role: "admin", permissions: { canManageUsers: false } });
    expect(hasPermission(ctx, "canManageUsers")).toBe(true);
  });

  it("refuses a non-admin with no permissions row", () => {
    expect(hasPermission(context({ permissions: undefined }), "canViewMaintenance")).toBe(false);
  });

  it("accepts any one of the named permissions", () => {
    const ctx = context({ permissions: { canManageMaintenance: true } });
    expect(hasPermission(ctx, "canViewMaintenance", "canManageMaintenance")).toBe(true);
  });

  it("refuses when none of the named permissions is granted", () => {
    const ctx = context({ permissions: { canViewAssets: true } });
    expect(hasPermission(ctx, "canViewMaintenance", "canManageMaintenance")).toBe(false);
  });

  it("does not accept a truthy non-true value as a grant", () => {
    const ctx = context({ permissions: { canViewMaintenance: 1 as unknown as boolean } });
    expect(hasPermission(ctx, "canViewMaintenance")).toBe(false);
  });
});

describe("requirePermission", () => {
  it("sends 403 when the permission is missing", () => {
    const res = response();
    expect(requirePermission(res, context(), "canViewBilling")).toBe(false);
    expect(res.sent.status).toBe(403);
  });

  it("sends nothing when the permission is held", () => {
    const res = response();
    const ctx = context({ permissions: { canViewBilling: true } });
    expect(requirePermission(res, ctx, "canViewBilling")).toBe(true);
    expect(res.sent.status).toBeUndefined();
  });
});

describe("the two flags added ahead of their features", () => {
  // canCompleteWalkthroughs and canManagePropertySetup gate surfaces that do
  // not exist yet. Nothing reads them, so nothing would fail if they were
  // wired up wrongly -- which is exactly why the wiring is asserted here and
  // not left until the feature arrives.

  it("grants neither flag to a staff account that was given no grant", () => {
    // The point of landing them early is that the features arrive gated. A
    // default of true anywhere would silently undo that.
    const ctx = context({ role: "regional_administrator", permissions: {} });
    expect(hasPermission(ctx, "canCompleteWalkthroughs")).toBe(false);
    expect(hasPermission(ctx, "canManagePropertySetup")).toBe(false);
  });

  it("grants neither flag to a resident account that was given no grant", () => {
    const ctx = context({ role: "resident", permissions: {} });
    expect(hasPermission(ctx, "canCompleteWalkthroughs")).toBe(false);
    expect(hasPermission(ctx, "canManagePropertySetup")).toBe(false);
  });

  it("honours an explicit grant, and only the one granted", () => {
    const ctx = context({ role: "resident", permissions: { canCompleteWalkthroughs: true } });
    expect(hasPermission(ctx, "canCompleteWalkthroughs")).toBe(true);
    expect(hasPermission(ctx, "canManagePropertySetup")).toBe(false);
  });

  it("applies the admin bypass, as every other flag does", () => {
    const ctx = context({ role: "admin", permissions: undefined });
    expect(hasPermission(ctx, "canCompleteWalkthroughs")).toBe(true);
    expect(hasPermission(ctx, "canManagePropertySetup")).toBe(true);
  });

  it("refuses through requirePermission with a 403, not a crash", () => {
    // The failure mode these replace: a check that reads the permissions row
    // directly returns a 500 for an admin who has no row.
    const res = response();
    expect(requirePermission(res, context({ role: "resident" }), "canCompleteWalkthroughs")).toBe(false);
    expect(res.sent.status).toBe(403);

    const adminRes = response();
    const admin = context({ role: "admin", permissions: undefined });
    expect(requirePermission(adminRes, admin, "canCompleteWalkthroughs")).toBe(true);
    expect(adminRes.sent.status).toBeUndefined();
  });

  it("grants no region reach by itself", () => {
    // canCompleteWalkthroughs is house-scoped by design. Holding it must not
    // widen what regions an account can reach, or the resident walkthrough
    // routes would inherit a region path they are not supposed to have.
    const ctx = context({
      role: "resident",
      permissions: { canCompleteWalkthroughs: true },
      allowedRegions: [],
    });
    expect(canAccessRegion(ctx, "West Central")).toBe(false);
    expect(filterByRegion(ctx, [{ region: "West Central" }])).toEqual([]);
  });
});

describe("requireStaff and requireAdmin", () => {
  it("requireStaff refuses a resident", () => {
    const res = response();
    expect(requireStaff(res, context({ role: "resident" }))).toBe(false);
    expect(res.sent.status).toBe(403);
  });

  it("requireStaff allows a regional administrator and an admin", () => {
    expect(requireStaff(response(), context({ role: "regional_administrator" }))).toBe(true);
    expect(requireStaff(response(), context({ role: "admin" }))).toBe(true);
  });

  it("requireAdmin refuses a regional administrator", () => {
    const res = response();
    expect(requireAdmin(res, context({ role: "regional_administrator" }))).toBe(false);
    expect(res.sent.status).toBe(403);
  });

  it("requireAdmin allows an admin", () => {
    expect(requireAdmin(response(), context({ role: "admin" }))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Regions
// ---------------------------------------------------------------------------

describe("canAccessRegion", () => {
  it("grants a regional administrator their assigned region", () => {
    expect(canAccessRegion(context({ allowedRegions: ["West Central"] }), "West Central")).toBe(true);
  });

  it("refuses a region they were not assigned", () => {
    expect(canAccessRegion(context({ allowedRegions: ["West Central"] }), "East Central")).toBe(false);
  });

  it("refuses everything when no regions are assigned", () => {
    // Fail closed: an empty list means "nothing", never "everything".
    expect(canAccessRegion(context({ allowedRegions: [] }), "West Central")).toBe(false);
  });

  it("refuses a record that has no region", () => {
    const ctx = context({ allowedRegions: ["West Central"] });
    expect(canAccessRegion(ctx, null)).toBe(false);
    expect(canAccessRegion(ctx, undefined)).toBe(false);
    expect(canAccessRegion(ctx, "")).toBe(false);
  });

  it("matches a legacy kebab-case assignment against a Title Case record", () => {
    // Rows written before regions were normalised still say "west-central".
    expect(canAccessRegion(context({ allowedRegions: ["west-central"] }), "West Central")).toBe(true);
  });

  it("honours the 'all' wildcard", () => {
    expect(canAccessRegion(context({ allowedRegions: ["all"] }), "South East")).toBe(true);
  });

  it("grants an admin any region, including none at all", () => {
    const admin = context({ role: "admin", allowedRegions: [] });
    expect(canAccessRegion(admin, "South East")).toBe(true);
    expect(canAccessRegion(admin, null)).toBe(true);
  });
});

describe("requireRegion", () => {
  it("sends 403 with a region-specific message", () => {
    const res = response();
    expect(requireRegion(res, context({ allowedRegions: ["West Central"] }), "East Central")).toBe(false);
    expect(res.sent.status).toBe(403);
    expect(res.sent.message).toMatch(/region/i);
  });
});

describe("requireRegionMove", () => {
  const ctx = () => context({ allowedRegions: ["West Central", "North West"] });

  it("allows a move between two regions the user can reach", () => {
    const res = response();
    expect(requireRegionMove(res, ctx(), "West Central", "North West")).toBe(true);
    expect(res.sent.status).toBeUndefined();
  });

  it("refuses moving a record into a region the user cannot reach", () => {
    // Otherwise a user could push a record somewhere they can no longer see it,
    // which looks exactly like the record having been deleted.
    const res = response();
    expect(requireRegionMove(res, ctx(), "West Central", "East Central")).toBe(false);
    expect(res.sent.status).toBe(403);
    expect(res.sent.message).toMatch(/cannot move/i);
  });

  it("refuses editing a record that is already outside their regions", () => {
    const res = response();
    expect(requireRegionMove(res, ctx(), "East Central", "West Central")).toBe(false);
    expect(res.sent.status).toBe(403);
  });

  it("allows an edit that does not change the region", () => {
    expect(requireRegionMove(response(), ctx(), "West Central", "West Central")).toBe(true);
  });

  it("allows an edit that does not mention the region at all", () => {
    expect(requireRegionMove(response(), ctx(), "West Central", undefined)).toBe(true);
  });

  it("lets an admin move a record anywhere", () => {
    const admin = context({ role: "admin" });
    expect(requireRegionMove(response(), admin, "East Central", "South East")).toBe(true);
  });
});

describe("filterByRegion", () => {
  const records = [
    { id: "1", region: "West Central" },
    { id: "2", region: "East Central" },
    { id: "3", region: null },
  ];

  it("returns only records in the assigned regions", () => {
    const result = filterByRegion(context({ allowedRegions: ["West Central"] }), records);
    expect(result.map((r) => r.id)).toEqual(["1"]);
  });

  it("returns nothing when no regions are assigned", () => {
    // The regression this guards: an empty list must not be read as "no filter".
    expect(filterByRegion(context({ allowedRegions: [] }), records)).toEqual([]);
  });

  it("drops records that carry no region", () => {
    const result = filterByRegion(context({ allowedRegions: ["all"] }), records);
    expect(result).toHaveLength(3); // 'all' is a wildcard and skips filtering
    const specific = filterByRegion(context({ allowedRegions: ["West Central", "East Central"] }), records);
    expect(specific.map((r) => r.id)).toEqual(["1", "2"]);
  });

  it("matches legacy kebab-case assignments", () => {
    const result = filterByRegion(context({ allowedRegions: ["east-central"] }), records);
    expect(result.map((r) => r.id)).toEqual(["2"]);
  });

  it("returns everything to an admin", () => {
    expect(filterByRegion(context({ role: "admin" }), records)).toHaveLength(3);
  });
});

describe("filterByRelatedRegion", () => {
  const photos = [
    { id: "p1", asset: { region: "West Central" } },
    { id: "p2", asset: { region: "East Central" } },
    { id: "p3", asset: undefined as { region: string } | undefined },
  ];
  const regionOf = (p: (typeof photos)[number]) => p.asset?.region;

  it("filters on the related record's region", () => {
    const result = filterByRelatedRegion(context({ allowedRegions: ["West Central"] }), photos, regionOf);
    expect(result.map((p) => p.id)).toEqual(["p1"]);
  });

  it("drops records whose related record has gone missing", () => {
    const result = filterByRelatedRegion(
      context({ allowedRegions: ["West Central", "East Central"] }),
      photos,
      regionOf,
    );
    expect(result.map((p) => p.id)).toEqual(["p1", "p2"]);
  });

  it("returns nothing when no regions are assigned", () => {
    expect(filterByRelatedRegion(context({ allowedRegions: [] }), photos, regionOf)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Resident ownership
// ---------------------------------------------------------------------------

describe("ownsRecord", () => {
  const ctx = context({ role: "resident", email: "Alice@Example.com" });

  it("matches regardless of case, since email case is not meaningful", () => {
    expect(ownsRecord(ctx, "alice@example.com")).toBe(true);
  });

  it("ignores surrounding whitespace", () => {
    expect(ownsRecord(ctx, "  alice@example.com  ")).toBe(true);
  });

  it("does not match a different address", () => {
    expect(ownsRecord(ctx, "bob@example.com")).toBe(false);
  });

  it("refuses when either side is missing, rather than matching empty to empty", () => {
    expect(ownsRecord(ctx, null)).toBe(false);
    expect(ownsRecord(ctx, "")).toBe(false);
    expect(ownsRecord(context({ role: "resident", email: "" }), "alice@example.com")).toBe(false);
  });

  it("does not match a user ID against the stored email", () => {
    // submittedBy holds an email. Comparing it to a user ID silently disables
    // the whole ownership gate, which is how this broke once before.
    expect(ownsRecord(ctx, "user-1")).toBe(false);
  });
});

describe("canReadMaintenanceRequest", () => {
  const resident = context({ role: "resident", email: "alice@example.com" });

  it("lets a resident read their own request, whatever region it is in", () => {
    expect(
      canReadMaintenanceRequest(resident, { region: "South East", submittedBy: "alice@example.com" }),
    ).toBe(true);
  });

  it("refuses a resident another resident's request", () => {
    expect(
      canReadMaintenanceRequest(resident, { region: "South East", submittedBy: "bob@example.com" }),
    ).toBe(false);
  });

  it("does not let a resident in the record's region read someone else's request", () => {
    // Residents are scoped by ownership only; a region assignment must not
    // become a second way in.
    const residentWithRegions = context({
      role: "resident",
      email: "alice@example.com",
      allowedRegions: ["South East"],
    });
    expect(
      canReadMaintenanceRequest(residentWithRegions, {
        region: "South East",
        submittedBy: "bob@example.com",
      }),
    ).toBe(false);
  });

  it("scopes staff by region rather than by ownership", () => {
    const staff = context({ allowedRegions: ["West Central"] });
    expect(canReadMaintenanceRequest(staff, { region: "West Central", submittedBy: "bob@example.com" })).toBe(true);
    expect(canReadMaintenanceRequest(staff, { region: "East Central", submittedBy: "bob@example.com" })).toBe(false);
  });

  it("lets an admin read anything", () => {
    expect(
      canReadMaintenanceRequest(context({ role: "admin" }), { region: null, submittedBy: null }),
    ).toBe(true);
  });
});

describe("canReadMaintenanceRequest — housemates", () => {
  // properties.address is unique and computed server-side, and both the
  // request's buildingAddress and the caller's resolved house come from that
  // same column, so the match is between two copies of one canonical string.
  const HOUSE_A = "123 Main St, Saint Paul, MN 55101";
  const HOUSE_B = "456 Oak Ave, Saint Paul, MN 55104";

  const resident = context({ role: "resident", email: "alice@example.com" });

  const bobsRequestAtHouseA = {
    region: "South East",
    submittedBy: "bob@example.com",
    buildingAddress: HOUSE_A,
  };

  it("lets a resident read a housemate's request for their own house", () => {
    expect(canReadMaintenanceRequest(resident, bobsRequestAtHouseA, HOUSE_A)).toBe(true);
  });

  it("refuses a request filed for a different house", () => {
    expect(canReadMaintenanceRequest(resident, bobsRequestAtHouseA, HOUSE_B)).toBe(false);
  });

  it("keeps the email match working even when no house is resolved", () => {
    // The house match is added alongside ownership, never in place of it: an
    // account with no property link still sees its own submissions.
    expect(
      canReadMaintenanceRequest(
        resident,
        { region: "South East", submittedBy: "alice@example.com", buildingAddress: HOUSE_A },
        null,
      ),
    ).toBe(true);
  });

  it("refuses a housemate claim when the account has no linked house", () => {
    expect(canReadMaintenanceRequest(resident, bobsRequestAtHouseA, null)).toBe(false);
  });

  it("refuses a request with no building address, rather than matching empty to empty", () => {
    expect(
      canReadMaintenanceRequest(
        resident,
        { region: "South East", submittedBy: "bob@example.com", buildingAddress: "" },
        "",
      ),
    ).toBe(false);
  });

  it("requires an exact match: case or whitespace drift never crosses houses", () => {
    // Unlike email, properties.address is only unique case-sensitively, so
    // "123 Main St" and "123 MAIN ST" can be two different houses. A folded
    // comparison would let one house read the other's history; drift between
    // two copies of the same house's address merely fails closed instead.
    expect(
      canReadMaintenanceRequest(resident, bobsRequestAtHouseA, HOUSE_A.toUpperCase()),
    ).toBe(false);
    expect(
      canReadMaintenanceRequest(resident, bobsRequestAtHouseA, `  ${HOUSE_A}  `),
    ).toBe(false);
  });

  it("does not widen staff access: a house match never overrides region scoping", () => {
    const staff = context({ allowedRegions: ["West Central"] });
    expect(
      canReadMaintenanceRequest(
        staff,
        { region: "East Central", submittedBy: "bob@example.com", buildingAddress: HOUSE_A },
        HOUSE_A,
      ),
    ).toBe(false);
  });
});

describe("residentHouseAddress", () => {
  const HOUSE_A = "123 Main St, Saint Paul, MN 55101";

  it("resolves the address of the property linked to a resident account", async () => {
    getProperty.mockResolvedValue({ id: "prop-a", address: HOUSE_A });
    const ctx = context({ role: "resident", propertyId: "prop-a" });
    expect(await residentHouseAddress(ctx)).toBe(HOUSE_A);
    expect(getProperty).toHaveBeenCalledWith("prop-a");
  });

  it("returns null for staff without touching storage", async () => {
    const ctx = context({ role: "regional_administrator", propertyId: "prop-a" });
    expect(await residentHouseAddress(ctx)).toBeNull();
    expect(getProperty).not.toHaveBeenCalled();
  });

  it("returns null for a resident account with no property link", async () => {
    const ctx = context({ role: "resident" });
    expect(await residentHouseAddress(ctx)).toBeNull();
    expect(getProperty).not.toHaveBeenCalled();
  });

  it("returns null when the linked property no longer exists", async () => {
    getProperty.mockResolvedValue(undefined);
    const ctx = context({ role: "resident", propertyId: "prop-gone" });
    expect(await residentHouseAddress(ctx)).toBeNull();
  });
});

describe("requireMaintenanceRequestAccess", () => {
  it("sends 403 when the read rule refuses", () => {
    const res = response();
    const resident = context({ role: "resident", email: "alice@example.com" });
    expect(requireMaintenanceRequestAccess(res, resident, { submittedBy: "bob@example.com" })).toBe(false);
    expect(res.sent.status).toBe(403);
  });
});
