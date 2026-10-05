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
const getWalkthroughsByProperty = vi.fn();
const getResidentsByProperty = vi.fn();
vi.mock("../storage", () => ({
  storage: {
    getResidentsByProperty: (...args: unknown[]) => getResidentsByProperty(...args),
    getUser: (...args: unknown[]) => getUser(...args),
    getUserPermissions: (...args: unknown[]) => getUserPermissions(...args),
    getProperty: (...args: unknown[]) => getProperty(...args),
    getWalkthroughsByProperty: (...args: unknown[]) => getWalkthroughsByProperty(...args),
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
  RESIDENT_CLOSED_REQUEST_DAYS,
  requireMaintenanceRequestAccess,
  residentHouseAddress,
  rosterRowSpeaksFor,
  isCurrentRosterMember,
  canReadComment,
  canPostComment,
  canDeleteComment,
  hasWalkthroughPermission,
  requireWalkthroughPermission,
  canAccessWalkthrough,
  requireWalkthroughAccess,
  isCurrentWalkthrough,
  requireCurrentWalkthrough,
  visibleWalkthroughs,
  canSeeActionItemSource,
  canSeeTask,
  isLeaseDerivedTaskSourceKey,
  isRosterDerivedTaskSourceKey,
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
  getResidentsByProperty.mockReset().mockResolvedValue([]);
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

describe("the flags landed ahead of their features", () => {
  // canCompleteWalkthroughs now gates the resident walkthrough routes (see the
  // walkthrough blocks at the end of this file); canManagePropertySetup still
  // gates a surface that does not exist. These assertions are about the wiring
  // of the flags themselves -- default false, explicit grant honoured, admin
  // bypass applied, and no region reach acquired from either.

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

  // Every fixture a resident is expected to read says `type: "request"`
  // outright: the type rule fails closed on a missing type, so a fixture
  // that stayed silent about it would be refused for the wrong reason.
  // Changed by #267: "whatever region it is in" used to be the rule; the
  // request now has to be at the house the account is linked to.
  it("lets a resident read their own request at their own house", () => {
    expect(
      canReadMaintenanceRequest(
        resident,
        { region: "South East", submittedBy: "alice@example.com", buildingAddress: "1 Main St", type: "request" },
        "1 Main St",
      ),
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
    const staff = context({ allowedRegions: ["West Central"], permissions: { canViewMaintenance: true } });
    expect(canReadMaintenanceRequest(staff, { region: "West Central", submittedBy: "bob@example.com" })).toBe(true);
    expect(canReadMaintenanceRequest(staff, { region: "East Central", submittedBy: "bob@example.com" })).toBe(false);
  });

  // The region alone is not the grant: a staff account in the right region
  // without either maintenance flag reads no request, and so no thread, photo
  // or file that inherits the request rule.
  it("refuses staff in the region who hold neither maintenance flag", () => {
    const request = { region: "West Central", submittedBy: "bob@example.com" };
    expect(canReadMaintenanceRequest(context({ allowedRegions: ["West Central"] }), request)).toBe(false);
    expect(
      canReadMaintenanceRequest(context({ allowedRegions: ["West Central"], permissions: { canCompleteWalkthroughs: true } }), request),
    ).toBe(false);
    expect(
      canReadMaintenanceRequest(context({ allowedRegions: ["West Central"], permissions: { canManageMaintenance: true } }), request),
    ).toBe(true);
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
    type: "request",
  };

  it("lets a resident read a housemate's request for their own house", () => {
    expect(canReadMaintenanceRequest(resident, bobsRequestAtHouseA, HOUSE_A)).toBe(true);
  });

  it("refuses a request filed for a different house", () => {
    expect(canReadMaintenanceRequest(resident, bobsRequestAtHouseA, HOUSE_B)).toBe(false);
  });

  it("does not let the email match stand in for the house when none is resolved", () => {
    // Changed by #267. The email match used to work with no house at all, so
    // an account with no property link still read its own submissions
    // anywhere. Ownership now only lifts the 120-day window at the house the
    // account is linked to; with no house claim nothing is readable.
    expect(
      canReadMaintenanceRequest(
        resident,
        { region: "South East", submittedBy: "alice@example.com", buildingAddress: HOUSE_A, type: "request" },
        null,
      ),
    ).toBe(false);
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
    const staff = context({ allowedRegions: ["West Central"], permissions: { canViewMaintenance: true } });
    expect(
      canReadMaintenanceRequest(
        staff,
        { region: "East Central", submittedBy: "bob@example.com", buildingAddress: HOUSE_A },
        HOUSE_A,
      ),
    ).toBe(false);
  });
});

describe("canReadMaintenanceRequest — the closed-request window on the house path", () => {
  /**
   * A household leader sees their house's OPEN requests always, and a closed
   * one only for a while afterwards. Michael asked for less than the whole
   * history, and this is the narrowing.
   *
   * The time dimension applies to a housemate's request only. What somebody
   * filed themselves at their own house they can always read back — that is
   * their own report, not a housemate's history — and nothing here touches
   * staff at all.
   */
  const HOUSE_A = "123 Main St, Saint Paul, MN 55101";
  const NOW = new Date("2026-08-15T00:00:00Z");
  const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

  const resident = context({ role: "resident", email: "alice@example.com" });

  const housemateRequest = (over: Record<string, unknown> = {}) => ({
    region: "South East",
    submittedBy: "bob@example.com",
    buildingAddress: HOUSE_A,
    status: "pending" as string,
    completedDate: null as Date | null,
    type: "request",
    ...over,
  });

  it("shows an open request for their house however old it is", () => {
    expect(
      canReadMaintenanceRequest(resident, housemateRequest({ status: "pending" }), HOUSE_A, NOW),
    ).toBe(true);
    expect(
      canReadMaintenanceRequest(resident, housemateRequest({ status: "in_progress" }), HOUSE_A, NOW),
    ).toBe(true);
  });

  it("shows a request closed inside the window", () => {
    expect(
      canReadMaintenanceRequest(
        resident,
        housemateRequest({ status: "completed", completedDate: daysAgo(RESIDENT_CLOSED_REQUEST_DAYS - 1) }),
        HOUSE_A,
        NOW,
      ),
    ).toBe(true);
  });

  it("hides a request closed beyond the window", () => {
    expect(
      canReadMaintenanceRequest(
        resident,
        housemateRequest({ status: "completed", completedDate: daysAgo(RESIDENT_CLOSED_REQUEST_DAYS + 1) }),
        HOUSE_A,
        NOW,
      ),
    ).toBe(false);
  });

  it("treats a cancelled request as closed too", () => {
    // completedDate is the CLOSE date and is stamped for cancelled as well as
    // completed. A cancelled request is not open work.
    expect(
      canReadMaintenanceRequest(
        resident,
        housemateRequest({ status: "cancelled", completedDate: daysAgo(RESIDENT_CLOSED_REQUEST_DAYS + 1) }),
        HOUSE_A,
        NOW,
      ),
    ).toBe(false);
  });

  it("hides a closed request with no close date, failing closed", () => {
    // Requests closed before completedDate started being written have none,
    // and nothing can reconstruct when they closed. A guess would be worse
    // than no date once a visibility window depends on it.
    expect(
      canReadMaintenanceRequest(
        resident,
        housemateRequest({ status: "completed", completedDate: null }),
        HOUSE_A,
        NOW,
      ),
    ).toBe(false);
  });

  it("hides a closed request whose close date is unparseable", () => {
    expect(
      canReadMaintenanceRequest(
        resident,
        housemateRequest({ status: "completed", completedDate: "not-a-date" }),
        HOUSE_A,
        NOW,
      ),
    ).toBe(false);
  });

  it("still shows a resident their OWN old closed request", () => {
    // The window narrows the housemate path, not the ownership one. Somebody
    // must be able to read back what they themselves reported.
    expect(
      canReadMaintenanceRequest(
        resident,
        housemateRequest({
          submittedBy: "alice@example.com",
          status: "completed",
          completedDate: daysAgo(RESIDENT_CLOSED_REQUEST_DAYS * 5),
        }),
        HOUSE_A,
        NOW,
      ),
    ).toBe(true);
  });

  it("no longer shows a resident their own old request with no house link", () => {
    // Changed by #267: the exemption from the window is for their own filing
    // at their own house, not for an email match on its own.
    expect(
      canReadMaintenanceRequest(
        resident,
        housemateRequest({
          submittedBy: "alice@example.com",
          status: "completed",
          completedDate: daysAgo(RESIDENT_CLOSED_REQUEST_DAYS * 5),
        }),
        null,
        NOW,
      ),
    ).toBe(false);
  });

  it("leaves staff alone: full history, however old", () => {
    const staff = context({ allowedRegions: ["South East"], permissions: { canViewMaintenance: true } });
    expect(
      canReadMaintenanceRequest(
        staff,
        housemateRequest({ status: "completed", completedDate: daysAgo(RESIDENT_CLOSED_REQUEST_DAYS * 10) }),
        HOUSE_A,
        NOW,
      ),
    ).toBe(true);
  });

  it("leaves admins alone", () => {
    expect(
      canReadMaintenanceRequest(
        context({ role: "admin" }),
        housemateRequest({ status: "completed", completedDate: daysAgo(RESIDENT_CLOSED_REQUEST_DAYS * 10) }),
        HOUSE_A,
        NOW,
      ),
    ).toBe(true);
  });

  it("is 120 days, in one place", () => {
    // A named constant, so the server rule and anything describing it to a
    // resident cannot drift.
    expect(RESIDENT_CLOSED_REQUEST_DAYS).toBe(120);
  });
});

describe("canReadMaintenanceRequest — what a resident filed is theirs only at their own house (#267)", () => {
  /**
   * The ownership path used to be an email match alone, so a demoted RA kept
   * reading every repair they filed as staff, in every region, with its later
   * shared comments. It now needs the house match too: a request somebody
   * filed is readable back only while it is at the house their account is
   * linked to and a current roster row speaks for. The 120-day window stays
   * on the HOUSE path; their own request at their own house has no age limit.
   */
  const HOUSE_A = "123 Main St, Saint Paul, MN 55101";
  const HOUSE_B = "456 Oak Ave, Saint Paul, MN 55104";
  const NOW = new Date("2026-08-15T00:00:00Z");
  const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);
  const resident = context({ role: "resident", email: "alice@example.com" });

  const alicesRequest = (over: Record<string, unknown> = {}) => ({
    region: "South East",
    submittedBy: "alice@example.com",
    buildingAddress: HOUSE_A,
    status: "pending" as string,
    completedDate: null as Date | null,
    type: "request",
    ...over,
  });

  it("refuses a repair they filed at another house in another region", () => {
    const filedAsStaffElsewhere = alicesRequest({ region: "West Central", buildingAddress: HOUSE_B });
    expect(canReadMaintenanceRequest(resident, filedAsStaffElsewhere, HOUSE_A, NOW)).toBe(false);
  });

  it("refuses it even when the resident holds that region, which never was a way in", () => {
    const withRegion = context({ role: "resident", email: "alice@example.com", allowedRegions: ["West Central"] });
    const filedAsStaffElsewhere = alicesRequest({ region: "West Central", buildingAddress: HOUSE_B });
    expect(canReadMaintenanceRequest(withRegion, filedAsStaffElsewhere, HOUSE_A, NOW)).toBe(false);
  });

  it("still reads a repair they filed at their own house (positive control)", () => {
    expect(canReadMaintenanceRequest(resident, alicesRequest(), HOUSE_A, NOW)).toBe(true);
  });

  it("still reads their own request at their own house closed far beyond the window", () => {
    const old = alicesRequest({ status: "completed", completedDate: daysAgo(RESIDENT_CLOSED_REQUEST_DAYS * 5) });
    expect(canReadMaintenanceRequest(resident, old, HOUSE_A, NOW)).toBe(true);
  });

  it("still reads their own closed request at their own house with no close date", () => {
    const undated = alicesRequest({ status: "completed", completedDate: null });
    expect(canReadMaintenanceRequest(resident, undated, HOUSE_A, NOW)).toBe(true);
  });

  it("fails closed with no house claim: no link or no current roster row means no ownership read", () => {
    expect(canReadMaintenanceRequest(resident, alicesRequest(), null, NOW)).toBe(false);
  });

  it("fails closed on a request with no building address, rather than matching empty to empty", () => {
    expect(canReadMaintenanceRequest(resident, alicesRequest({ buildingAddress: "" }), "", NOW)).toBe(false);
    expect(canReadMaintenanceRequest(resident, alicesRequest({ buildingAddress: null }), HOUSE_A, NOW)).toBe(false);
  });

  it("applies the house match exactly: drift in case or whitespace never reads", () => {
    expect(canReadMaintenanceRequest(resident, alicesRequest(), HOUSE_A.toUpperCase(), NOW)).toBe(false);
    expect(canReadMaintenanceRequest(resident, alicesRequest(), `  ${HOUSE_A}  `, NOW)).toBe(false);
  });

  it("keeps the type rule above the ownership path", () => {
    expect(canReadMaintenanceRequest(resident, alicesRequest({ type: "project" }), HOUSE_A, NOW)).toBe(false);
  });

  it("leaves staff alone: a staff submitter reads by region, with or without a house", () => {
    const staff = context({ allowedRegions: ["West Central"], permissions: { canViewMaintenance: true } });
    const theirs = alicesRequest({ region: "West Central", buildingAddress: HOUSE_B });
    expect(canReadMaintenanceRequest(staff, theirs, null, NOW)).toBe(true);
    expect(canReadMaintenanceRequest(context({ role: "admin" }), theirs, null, NOW)).toBe(true);
  });

  it("carries to comments: no shared comment on such a request reads or posts", () => {
    const filedAsStaffElsewhere = alicesRequest({ region: "West Central", buildingAddress: HOUSE_B });
    expect(canReadComment(resident, filedAsStaffElsewhere, { isInternal: false }, HOUSE_A, NOW)).toBe(false);
    expect(canPostComment(resident, filedAsStaffElsewhere, { isInternal: false }, HOUSE_A, NOW)).toBe(false);
    // Positive control on the same two functions: at the own house they work.
    expect(canReadComment(resident, alicesRequest(), { isInternal: false }, HOUSE_A, NOW)).toBe(true);
    expect(canPostComment(resident, alicesRequest(), { isInternal: false }, HOUSE_A, NOW)).toBe(true);
  });
});

describe("canReadMaintenanceRequest — the type rule (residents see repairs only)", () => {
  /**
   * ADR-0001: projects and capital projects are a TYPE on maintenance
   * requests, so bid amounts and contract terms now sit in a table a
   * household leader can already read. The rule that keeps them out is the
   * first line of the resident branch -- before the own-submission check and
   * before the house match, because either of those is exactly what would
   * otherwise let a project on their own house through.
   */
  const HOUSE_A = "123 Main St, Saint Paul, MN 55101";
  const resident = context({ role: "resident", email: "alice@example.com" });

  const onOwnHouse = (over: Record<string, unknown> = {}) => ({
    region: "South East",
    submittedBy: "bob@example.com",
    buildingAddress: HOUSE_A,
    status: "pending" as string,
    completedDate: null as Date | null,
    type: "request" as string | null | undefined,
    ...over,
  });

  it("lets a resident read a repair on their own house (positive control)", () => {
    expect(canReadMaintenanceRequest(resident, onOwnHouse({ type: "request" }), HOUSE_A)).toBe(true);
  });

  it("refuses a resident a project on their own house, house match notwithstanding", () => {
    expect(canReadMaintenanceRequest(resident, onOwnHouse({ type: "project" }), HOUSE_A)).toBe(false);
  });

  it("refuses a resident a capital project on their own house", () => {
    expect(canReadMaintenanceRequest(resident, onOwnHouse({ type: "capex" }), HOUSE_A)).toBe(false);
  });

  it("refuses a project or capital project even when the resident is recorded as its submitter", () => {
    // The ownership path is the one that "breaks silently on both sides at
    // once": it runs before the house match and would let this through if
    // the type rule sat anywhere but first.
    expect(
      canReadMaintenanceRequest(resident, onOwnHouse({ type: "project", submittedBy: "alice@example.com" }), HOUSE_A),
    ).toBe(false);
    expect(
      canReadMaintenanceRequest(resident, onOwnHouse({ type: "capex", submittedBy: "alice@example.com" }), HOUSE_A),
    ).toBe(false);
    // And the same submitter on a repair still reads: the refusal above is
    // the type, not the submitter.
    expect(
      canReadMaintenanceRequest(resident, onOwnHouse({ type: "request", submittedBy: "alice@example.com" }), HOUSE_A),
    ).toBe(true);
  });

  it("fails closed on a missing type rather than treating it as a repair", () => {
    // Every real call site passes a storage row, which carries the column
    // (not null, default request). A caller that somehow does not is refused
    // for a resident, never widened.
    expect(canReadMaintenanceRequest(resident, onOwnHouse({ type: undefined }), HOUSE_A)).toBe(false);
    expect(canReadMaintenanceRequest(resident, onOwnHouse({ type: null }), HOUSE_A)).toBe(false);
  });

  it("is derived from the type column and nothing else: status and priority do not decide it", () => {
    // A wishlist repair is still a repair; a completed project is still a
    // project.
    expect(
      canReadMaintenanceRequest(resident, onOwnHouse({ type: "request", priority: "wishlist" }), HOUSE_A),
    ).toBe(true);
    expect(
      canReadMaintenanceRequest(resident, onOwnHouse({ type: "project", priority: "low", status: "pending" }), HOUSE_A),
    ).toBe(false);
  });

  it("leaves staff on the region rule: all three types read", () => {
    const staff = context({ allowedRegions: ["South East"], permissions: { canViewMaintenance: true } });
    for (const type of ["request", "project", "capex"]) {
      expect(canReadMaintenanceRequest(staff, onOwnHouse({ type }), null)).toBe(true);
    }
  });

  it("leaves admins alone: all three types read", () => {
    for (const type of ["request", "project", "capex"]) {
      expect(canReadMaintenanceRequest(context({ role: "admin" }), onOwnHouse({ type }), null)).toBe(true);
    }
  });
});

describe("residentHouseAddress", () => {
  const HOUSE_A = "123 Main St, Saint Paul, MN 55101";

  const onRoster = (patch: Record<string, unknown> = {}) => [
    { email: "staff@example.com", propertyId: "prop-a", isActive: true, moveOutDate: null, ...patch },
  ];

  it("resolves the house of a resident a current roster row there speaks for (positive control)", async () => {
    getProperty.mockResolvedValue({ id: "prop-a", address: HOUSE_A });
    getResidentsByProperty.mockResolvedValue(onRoster());
    const ctx = context({ role: "resident", propertyId: "prop-a" });
    expect(await residentHouseAddress(ctx)).toBe(HOUSE_A);
    expect(getProperty).toHaveBeenCalledWith("prop-a");
    expect(getResidentsByProperty).toHaveBeenCalledWith("prop-a");
  });

  it("gives no house to a linked login whose roster row is inactive, past its stop date, or missing", async () => {
    getProperty.mockResolvedValue({ id: "prop-a", address: HOUSE_A });
    const ctx = context({ role: "resident", propertyId: "prop-a" });
    getResidentsByProperty.mockResolvedValue(onRoster({ isActive: false }));
    expect(await residentHouseAddress(ctx)).toBeNull();
    getResidentsByProperty.mockResolvedValue(onRoster({ moveOutDate: new Date("2020-01-01T00:00:00Z") }));
    expect(await residentHouseAddress(ctx)).toBeNull();
    getResidentsByProperty.mockResolvedValue(onRoster({ email: "someone-else@example.com" }));
    expect(await residentHouseAddress(ctx)).toBeNull();
    getResidentsByProperty.mockResolvedValue([]);
    expect(await residentHouseAddress(ctx)).toBeNull();
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

describe("isCurrentRosterMember", () => {
  const LOGIN = { email: "Maria@spo.org", propertyId: "prop-1" };
  const ROW = { email: "maria@spo.org", propertyId: "prop-1", isActive: true, moveOutDate: null as Date | null };
  const NOW = new Date("2027-05-20T15:00:00Z");

  it("counts the stop day itself, and nothing after it", () => {
    expect(isCurrentRosterMember({ ...ROW, moveOutDate: new Date("2027-05-20T00:00:00Z") }, LOGIN, NOW)).toBe(true);
    expect(isCurrentRosterMember({ ...ROW, moveOutDate: new Date("2027-05-19T00:00:00Z") }, LOGIN, NOW)).toBe(false);
  });

  it("needs the row active and speaking for this login at this house", () => {
    expect(isCurrentRosterMember(ROW, LOGIN, NOW)).toBe(true);
    expect(isCurrentRosterMember({ ...ROW, isActive: false }, LOGIN, NOW)).toBe(false);
    expect(isCurrentRosterMember(ROW, { ...LOGIN, propertyId: "prop-2" }, NOW)).toBe(false);
  });
});

describe("rosterRowSpeaksFor", () => {
  const ROW = { email: "maria@spo.org", propertyId: "prop-1" };
  const LOGIN = { email: "maria@spo.org", propertyId: "prop-1" };

  it("matches a login linked to the row's house with the row's email, case aside", () => {
    expect(rosterRowSpeaksFor(ROW, LOGIN)).toBe(true);
    expect(rosterRowSpeaksFor(ROW, { ...LOGIN, email: "Maria@SPO.org" })).toBe(true);
  });

  it("refuses a login linked to another house, or to none", () => {
    expect(rosterRowSpeaksFor(ROW, { ...LOGIN, propertyId: "prop-2" })).toBe(false);
    expect(rosterRowSpeaksFor(ROW, { ...LOGIN, propertyId: null })).toBe(false);
  });

  it("refuses a row with no house, even against a login with no house", () => {
    expect(rosterRowSpeaksFor({ ...ROW, propertyId: null }, { ...LOGIN, propertyId: null })).toBe(false);
  });

  it("refuses an email that differs by more than case, or a login with no email", () => {
    expect(rosterRowSpeaksFor(ROW, { ...LOGIN, email: "maria.g@spo.org" })).toBe(false);
    expect(rosterRowSpeaksFor(ROW, { ...LOGIN, email: null })).toBe(false);
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

// ---------------------------------------------------------------------------
// Walkthroughs: the second way in
// ---------------------------------------------------------------------------

/**
 * These are the rules behind the resident walkthrough routes, and they are the
 * shape of both historic authorization gaps in this codebase: a second tier
 * reaching routes that previously had exactly one.
 *
 * The property under test throughout is that a resident-tier account never
 * acquires a region path. Everything it can reach it reaches through the one
 * house its login is linked to, and every way of failing to resolve that house
 * denies rather than widens.
 */
describe("hasWalkthroughPermission", () => {
  it("lets a household leader in on canCompleteWalkthroughs, for reading and for writing", () => {
    const leader = context({ role: "resident", permissions: { canCompleteWalkthroughs: true } });
    expect(hasWalkthroughPermission(leader, "view")).toBe(true);
    expect(hasWalkthroughPermission(leader, "manage")).toBe(true);
  });

  it("refuses a resident account that has not been granted the flag", () => {
    const resident = context({ role: "resident", permissions: {} });
    expect(hasWalkthroughPermission(resident, "view")).toBe(false);
    expect(hasWalkthroughPermission(resident, "manage")).toBe(false);
  });

  it("refuses a resident account with no permissions row at all", () => {
    const resident = context({ role: "resident" });
    expect(hasWalkthroughPermission(resident, "view")).toBe(false);
    expect(hasWalkthroughPermission(resident, "manage")).toBe(false);
  });

  it("will not accept a staff walkthrough flag on a resident account", () => {
    // The staff flags are region-scoped in intent. Honouring one here would
    // hand a resident-tier login the region path this whole section denies.
    const resident = context({
      role: "resident",
      permissions: { canViewWalkthroughs: true, canManageWalkthroughs: true },
      allowedRegions: ["West Central"],
    });
    expect(hasWalkthroughPermission(resident, "view")).toBe(false);
    expect(hasWalkthroughPermission(resident, "manage")).toBe(false);
  });

  it("will not accept canCompleteWalkthroughs on a staff account", () => {
    // The mirror of the rule above: the resident flag is a house grant, and it
    // must not stand in for the staff grants on the same routes.
    const staff = context({
      role: "regional_administrator",
      permissions: { canCompleteWalkthroughs: true },
      allowedRegions: ["West Central"],
    });
    expect(hasWalkthroughPermission(staff, "view")).toBe(false);
    expect(hasWalkthroughPermission(staff, "manage")).toBe(false);
  });

  it("keeps the staff view/manage split", () => {
    const viewer = context({ permissions: { canViewWalkthroughs: true } });
    expect(hasWalkthroughPermission(viewer, "view")).toBe(true);
    expect(hasWalkthroughPermission(viewer, "manage")).toBe(false);

    const manager = context({ permissions: { canManageWalkthroughs: true } });
    expect(hasWalkthroughPermission(manager, "view")).toBe(true);
    expect(hasWalkthroughPermission(manager, "manage")).toBe(true);
  });

  it("applies the admin bypass, row or no row", () => {
    const admin = context({ role: "admin", permissions: undefined });
    expect(hasWalkthroughPermission(admin, "view")).toBe(true);
    expect(hasWalkthroughPermission(admin, "manage")).toBe(true);
  });

  it("refuses through requireWalkthroughPermission with a 403", () => {
    const res = response();
    expect(requireWalkthroughPermission(res, context({ role: "resident" }), "view")).toBe(false);
    expect(res.sent.status).toBe(403);

    const ok = response();
    const leader = context({ role: "resident", permissions: { canCompleteWalkthroughs: true } });
    expect(requireWalkthroughPermission(ok, leader, "view")).toBe(true);
    expect(ok.sent.status).toBeUndefined();
  });
});

describe("canAccessWalkthrough", () => {
  const HOUSE_A = "123 Main St, Saint Paul, MN 55101";
  const HOUSE_B = "77 Cretin Ave, Saint Paul, MN 55105";

  const atHouseA = { region: "West Central", buildingAddress: HOUSE_A };
  const atHouseB = { region: "West Central", buildingAddress: HOUSE_B };

  const leader = () =>
    context({
      role: "resident",
      permissions: { canCompleteWalkthroughs: true },
      propertyId: "prop-a",
    });

  it("lets a household leader reach their own house", () => {
    expect(canAccessWalkthrough(leader(), atHouseA, HOUSE_A)).toBe(true);
  });

  it("refuses another house in the same region", () => {
    // The one that matters: same region, same permissions, different house.
    expect(canAccessWalkthrough(leader(), atHouseB, HOUSE_A)).toBe(false);
  });

  it("refuses a resident with no house claim, whatever regions they were given", () => {
    // No propertyId, a deleted property and a property with no address all
    // arrive here as a null house, and all three must deny.
    const stray = context({
      role: "resident",
      permissions: { canCompleteWalkthroughs: true },
      allowedRegions: ["West Central", "all"],
    });
    expect(canAccessWalkthrough(stray, atHouseA, null)).toBe(false);
    expect(canAccessWalkthrough(stray, atHouseA)).toBe(false);
  });

  it("refuses a walkthrough with no house recorded on it", () => {
    expect(canAccessWalkthrough(leader(), { region: "West Central" }, HOUSE_A)).toBe(false);
    expect(canAccessWalkthrough(leader(), { region: "West Central", buildingAddress: null }, HOUSE_A)).toBe(false);
  });

  it("never lets a resident through on region, even holding every region", () => {
    const stray = context({
      role: "resident",
      permissions: { canCompleteWalkthroughs: true },
      allowedRegions: ["all"],
      propertyId: "prop-a",
    });
    expect(canAccessWalkthrough(stray, atHouseB, HOUSE_A)).toBe(false);
  });

  it("compares houses exactly, as the maintenance house rule does", () => {
    // properties.address is unique case-sensitively, so two houses can differ
    // by case alone. Folding the comparison would let one read the other.
    expect(canAccessWalkthrough(leader(), atHouseA, HOUSE_A.toUpperCase())).toBe(false);
    expect(canAccessWalkthrough(leader(), atHouseA, ` ${HOUSE_A} `)).toBe(false);
  });

  it("keeps staff on the region rule, and ignores the house", () => {
    const west = context({ allowedRegions: ["West Central"] });
    expect(canAccessWalkthrough(west, atHouseA)).toBe(true);
    expect(canAccessWalkthrough(west, { region: "East Central", buildingAddress: HOUSE_A }, HOUSE_A)).toBe(false);
  });

  it("denies everyone but an admin when the walkthrough could not be resolved", () => {
    // A room with no walkthrough, or one whose walkthrough has been deleted.
    expect(canAccessWalkthrough(leader(), undefined, HOUSE_A)).toBe(false);
    expect(canAccessWalkthrough(context({ allowedRegions: ["all"] }), null)).toBe(false);
    expect(canAccessWalkthrough(context({ role: "admin" }), undefined)).toBe(true);
  });
});

describe("requireWalkthroughAccess", () => {
  const HOUSE_A = "123 Main St, Saint Paul, MN 55101";

  it("resolves the caller's house itself and allows their own", async () => {
    getProperty.mockResolvedValue({ id: "prop-a", address: HOUSE_A });
    getResidentsByProperty.mockResolvedValue([{ email: "staff@example.com", propertyId: "prop-a", isActive: true, moveOutDate: null }]);
    const res = response();
    const leader = context({
      role: "resident",
      permissions: { canCompleteWalkthroughs: true },
      propertyId: "prop-a",
    });

    expect(
      await requireWalkthroughAccess(res, leader, { region: "West Central", buildingAddress: HOUSE_A }),
    ).toBe(true);
    expect(res.sent.status).toBeUndefined();
  });

  it("sends 403 for a house that is not theirs", async () => {
    getProperty.mockResolvedValue({ id: "prop-a", address: HOUSE_A });
    const res = response();
    const leader = context({
      role: "resident",
      permissions: { canCompleteWalkthroughs: true },
      propertyId: "prop-a",
    });

    expect(
      await requireWalkthroughAccess(res, leader, { region: "West Central", buildingAddress: "77 Cretin Ave" }),
    ).toBe(false);
    expect(res.sent.status).toBe(403);
  });

  it("sends 403 when the linked property has been deleted", async () => {
    getProperty.mockResolvedValue(undefined);
    const res = response();
    const leader = context({
      role: "resident",
      permissions: { canCompleteWalkthroughs: true },
      propertyId: "prop-gone",
    });

    expect(
      await requireWalkthroughAccess(res, leader, { region: "West Central", buildingAddress: HOUSE_A }),
    ).toBe(false);
    expect(res.sent.status).toBe(403);
  });

  it("costs staff no property lookup", async () => {
    const res = response();
    const west = context({ allowedRegions: ["West Central"] });
    expect(await requireWalkthroughAccess(res, west, { region: "West Central" })).toBe(true);
    expect(getProperty).not.toHaveBeenCalled();
  });
});

describe("visibleWalkthroughs", () => {
  const HOUSE_A = "123 Main St, Saint Paul, MN 55101";
  const HOUSE_B = "77 Cretin Ave, Saint Paul, MN 55105";

  const WEST_A = { id: "wt-a", region: "West Central", buildingAddress: HOUSE_A };
  const WEST_B = { id: "wt-b", region: "West Central", buildingAddress: HOUSE_B };
  const EAST_B = { id: "wt-c", region: "East Central", buildingAddress: HOUSE_B };
  const ALL = [WEST_A, WEST_B, EAST_B];

  it("gives a household leader their own house and nothing else", () => {
    const leader = context({ role: "resident", permissions: { canCompleteWalkthroughs: true } });
    expect(visibleWalkthroughs(leader, ALL, HOUSE_A).map((w) => w.id)).toEqual(["wt-a"]);
  });

  it("gives a resident with no house claim an empty list, never the region list", () => {
    const stray = context({
      role: "resident",
      permissions: { canCompleteWalkthroughs: true },
      allowedRegions: ["West Central"],
    });
    expect(visibleWalkthroughs(stray, ALL, null)).toEqual([]);
    expect(visibleWalkthroughs(stray, ALL)).toEqual([]);
  });

  it("keeps staff on the region rule", () => {
    const west = context({ allowedRegions: ["West Central"] });
    expect(visibleWalkthroughs(west, ALL).map((w) => w.id)).toEqual(["wt-a", "wt-b"]);
  });

  it("gives an unassigned staff account nothing", () => {
    expect(visibleWalkthroughs(context({ allowedRegions: [] }), ALL)).toEqual([]);
  });

  it("gives an admin everything", () => {
    expect(visibleWalkthroughs(context({ role: "admin" }), ALL)).toHaveLength(3);
  });
});

describe("isCurrentWalkthrough", () => {
  const dated = (walkthroughDate: string | Date | null) => ({ walkthroughDate });

  const LAST_YEAR = dated("2025-09-01T00:00:00.000Z");
  const THIS_YEAR = dated("2026-09-01T00:00:00.000Z");

  it("says yes to the newest inspection of the house", () => {
    expect(isCurrentWalkthrough(THIS_YEAR, [THIS_YEAR, LAST_YEAR])).toBe(true);
  });

  it("says no to a prior year", () => {
    // The whole point: last year's walkthrough is readable and not writable.
    expect(isCurrentWalkthrough(LAST_YEAR, [THIS_YEAR, LAST_YEAR])).toBe(false);
  });

  it("says yes to the only one there is", () => {
    expect(isCurrentWalkthrough(THIS_YEAR, [THIS_YEAR])).toBe(true);
    expect(isCurrentWalkthrough(THIS_YEAR, [])).toBe(true);
  });

  it("lets a tie through, so a move-in and a move-out on one day both work", () => {
    const moveOut = dated("2026-09-01T00:00:00.000Z");
    expect(isCurrentWalkthrough(THIS_YEAR, [THIS_YEAR, moveOut])).toBe(true);
    expect(isCurrentWalkthrough(moveOut, [THIS_YEAR, moveOut])).toBe(true);
  });

  it("accepts a Date as readily as a string", () => {
    const asDate = dated(new Date("2026-09-01T00:00:00.000Z"));
    expect(isCurrentWalkthrough(asDate, [LAST_YEAR])).toBe(true);
    expect(isCurrentWalkthrough(LAST_YEAR, [asDate])).toBe(false);
  });

  it("treats an undated or unparseable walkthrough as read-only", () => {
    // Fails closed rather than comparing as epoch zero, which would make an
    // undated record the oldest one there is and read as writable by accident
    // only when it stood alone.
    expect(isCurrentWalkthrough(dated(null), [])).toBe(false);
    expect(isCurrentWalkthrough(dated("not a date"), [])).toBe(false);
  });

  it("ignores an undated sibling rather than letting it win the comparison", () => {
    expect(isCurrentWalkthrough(THIS_YEAR, [THIS_YEAR, dated(null), dated("nonsense")])).toBe(true);
  });
});

describe("requireCurrentWalkthrough", () => {
  const HOUSE_WALKTHROUGHS = [
    { id: "wt-new", walkthroughDate: "2026-09-01T00:00:00.000Z" },
    { id: "wt-old", walkthroughDate: "2025-09-01T00:00:00.000Z" },
  ];

  const leader = () =>
    context({ role: "resident", permissions: { canCompleteWalkthroughs: true }, propertyId: "prop-a" });

  beforeEach(() => {
    getWalkthroughsByProperty.mockReset().mockResolvedValue(HOUSE_WALKTHROUGHS);
  });

  it("lets a leader write to the current inspection", async () => {
    const res = response();
    const current = { propertyId: "prop-a", walkthroughDate: "2026-09-01T00:00:00.000Z" };
    expect(await requireCurrentWalkthrough(res, leader(), current)).toBe(true);
    expect(res.sent.status).toBeUndefined();
  });

  it("refuses a leader on a prior year, and says why", async () => {
    const res = response();
    const prior = { propertyId: "prop-a", walkthroughDate: "2025-09-01T00:00:00.000Z" };
    expect(await requireCurrentWalkthrough(res, leader(), prior)).toBe(false);
    expect(res.sent.status).toBe(403);
    expect(res.sent.message).toContain("read-only");
  });

  it("does not restrict staff, who correct any year", async () => {
    const prior = { propertyId: "prop-a", walkthroughDate: "2025-09-01T00:00:00.000Z" };
    expect(await requireCurrentWalkthrough(response(), context({ allowedRegions: ["all"] }), prior)).toBe(true);
    expect(await requireCurrentWalkthrough(response(), context({ role: "admin" }), prior)).toBe(true);
    // And costs them no history lookup at all.
    expect(getWalkthroughsByProperty).not.toHaveBeenCalled();
  });

  it("refuses a leader when the walkthrough could not be resolved", async () => {
    const res = response();
    expect(await requireCurrentWalkthrough(res, leader(), undefined)).toBe(false);
    expect(res.sent.status).toBe(403);
    expect(getWalkthroughsByProperty).not.toHaveBeenCalled();
  });

  it("refuses a leader when the walkthrough belongs to no property", async () => {
    const res = response();
    expect(await requireCurrentWalkthrough(res, leader(), { walkthroughDate: "2026-09-01T00:00:00.000Z" })).toBe(false);
    expect(res.sent.status).toBe(403);
  });

  it("reads the history of the walkthrough's own house", async () => {
    await requireCurrentWalkthrough(response(), leader(), {
      propertyId: "prop-a",
      walkthroughDate: "2026-09-01T00:00:00.000Z",
    });
    expect(getWalkthroughsByProperty).toHaveBeenCalledWith("prop-a");
  });
});

// ---------------------------------------------------------------------------
// Request threads
// ---------------------------------------------------------------------------

/**
 * Thread access is request access, then a tier gate on top: whoever may read
 * the request may read its shared comments, and only staff may read (or post)
 * an internal one. Everything about who may read the request -- ownership,
 * house, region, the 120-day window -- is canReadMaintenanceRequest's, and
 * these tests lean on it rather than re-checking every branch of it.
 */
describe("canReadComment", () => {
  const HOUSE_A = "123 Main St, Saint Paul, MN 55101";
  const HOUSE_B = "456 Oak Ave, Saint Paul, MN 55104";
  const NOW = new Date("2026-08-15T00:00:00Z");
  const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

  const INTERNAL = { isInternal: true };
  const SHARED = { isInternal: false };

  const housemateRequest = {
    region: "West Central",
    submittedBy: "bob@example.com",
    buildingAddress: HOUSE_A,
    status: "pending",
    type: "request",
  };

  const staff = context({ allowedRegions: ["West Central"], permissions: { canViewMaintenance: true } });
  const household = context({ role: "resident", email: "alice@example.com", propertyId: "prop-a" });
  const unlinked = context({ role: "resident", email: "alice@example.com" });

  it("lets staff read both kinds on a request in their region", () => {
    expect(canReadComment(staff, housemateRequest, INTERNAL)).toBe(true);
    expect(canReadComment(staff, housemateRequest, SHARED)).toBe(true);
  });

  it("refuses staff both kinds on a request outside their regions", () => {
    const eastRequest = { ...housemateRequest, region: "East Central" };
    expect(canReadComment(staff, eastRequest, INTERNAL)).toBe(false);
    expect(canReadComment(staff, eastRequest, SHARED)).toBe(false);
  });

  it("lets an admin read everything", () => {
    const admin = context({ role: "admin" });
    expect(canReadComment(admin, { ...housemateRequest, region: "East Central" }, INTERNAL)).toBe(true);
  });

  it("lets a household account read a shared comment on its own house's request", () => {
    expect(canReadComment(household, housemateRequest, SHARED, HOUSE_A)).toBe(true);
  });

  it("never lets a household account read an internal comment, even on its own house", () => {
    expect(canReadComment(household, housemateRequest, INTERNAL, HOUSE_A)).toBe(false);
  });

  it("refuses a household account a shared comment on another house's request", () => {
    expect(canReadComment(household, housemateRequest, SHARED, HOUSE_B)).toBe(false);
  });

  it("refuses an unlinked resident everything on a housemate's request", () => {
    expect(canReadComment(unlinked, housemateRequest, SHARED, null)).toBe(false);
    expect(canReadComment(unlinked, housemateRequest, INTERNAL, null)).toBe(false);
  });

  // Changed by #267: ownership no longer stands in for the house, so the
  // tier rule on a resident's own submission is asserted on a linked account
  // at its own house, and the unlinked account is refused outright.
  it("lets a household account read shared, and only shared, on its own submission at its own house", () => {
    const ownRequest = { ...housemateRequest, submittedBy: "alice@example.com" };
    expect(canReadComment(household, ownRequest, SHARED, HOUSE_A)).toBe(true);
    expect(canReadComment(household, ownRequest, INTERNAL, HOUSE_A)).toBe(false);
  });

  it("refuses an unlinked resident everything on their own submission too", () => {
    const ownRequest = { ...housemateRequest, submittedBy: "alice@example.com" };
    expect(canReadComment(unlinked, ownRequest, SHARED, null)).toBe(false);
    expect(canReadComment(unlinked, ownRequest, INTERNAL, null)).toBe(false);
  });

  it("closes the thread to a household when the request closed more than 120 days ago", () => {
    const longClosed = { ...housemateRequest, status: "completed", completedDate: daysAgo(121) };
    expect(canReadComment(household, longClosed, SHARED, HOUSE_A, NOW)).toBe(false);
  });

  // The positive control for the window: the date is what refused above.
  it("keeps the thread open to a household while the request closed inside the window", () => {
    const recentlyClosed = { ...housemateRequest, status: "completed", completedDate: daysAgo(119) };
    expect(canReadComment(household, recentlyClosed, SHARED, HOUSE_A, NOW)).toBe(true);
  });

  it("does not subject staff to the window", () => {
    const longClosed = { ...housemateRequest, status: "completed", completedDate: daysAgo(400) };
    expect(canReadComment(staff, longClosed, INTERNAL, null, NOW)).toBe(true);
  });
});

describe("canPostComment", () => {
  const HOUSE_A = "123 Main St, Saint Paul, MN 55101";
  const HOUSE_B = "456 Oak Ave, Saint Paul, MN 55104";
  const NOW = new Date("2026-08-15T00:00:00Z");
  const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

  const INTERNAL = { isInternal: true };
  const SHARED = { isInternal: false };

  const housemateRequest = {
    region: "West Central",
    submittedBy: "bob@example.com",
    buildingAddress: HOUSE_A,
    status: "pending",
    type: "request",
  };

  const staff = context({ allowedRegions: ["West Central"], permissions: { canViewMaintenance: true } });
  const household = context({ role: "resident", email: "alice@example.com", propertyId: "prop-a" });
  const unlinked = context({ role: "resident", email: "alice@example.com" });

  it("lets staff post either way on a request in their region", () => {
    expect(canPostComment(staff, housemateRequest, INTERNAL)).toBe(true);
    expect(canPostComment(staff, housemateRequest, SHARED)).toBe(true);
  });

  it("refuses staff either way outside their regions", () => {
    const eastRequest = { ...housemateRequest, region: "East Central" };
    expect(canPostComment(staff, eastRequest, INTERNAL)).toBe(false);
    expect(canPostComment(staff, eastRequest, SHARED)).toBe(false);
  });

  it("lets a household account post shared, and only shared, on its own house's request", () => {
    expect(canPostComment(household, housemateRequest, SHARED, HOUSE_A)).toBe(true);
    expect(canPostComment(household, housemateRequest, INTERNAL, HOUSE_A)).toBe(false);
  });

  it("refuses a household account another house's request", () => {
    expect(canPostComment(household, housemateRequest, SHARED, HOUSE_B)).toBe(false);
  });

  // Changed by #267: an unlinked resident no longer posts on their own
  // submission (ownership alone is not a way in); a linked one does, shared
  // only, at their own house.
  it("refuses an unlinked resident a housemate's request and their own submission alike", () => {
    expect(canPostComment(unlinked, housemateRequest, SHARED, null)).toBe(false);
    const ownRequest = { ...housemateRequest, submittedBy: "alice@example.com" };
    expect(canPostComment(unlinked, ownRequest, SHARED, null)).toBe(false);
    expect(canPostComment(unlinked, ownRequest, INTERNAL, null)).toBe(false);
  });

  it("lets a household account post shared, and only shared, on its own submission at its own house", () => {
    const ownRequest = { ...housemateRequest, submittedBy: "alice@example.com" };
    expect(canPostComment(household, ownRequest, SHARED, HOUSE_A)).toBe(true);
    expect(canPostComment(household, ownRequest, INTERNAL, HOUSE_A)).toBe(false);
  });

  it("refuses a household account once the request closed more than 120 days ago", () => {
    const longClosed = { ...housemateRequest, status: "completed", completedDate: daysAgo(121) };
    expect(canPostComment(household, longClosed, SHARED, HOUSE_A, NOW)).toBe(false);
    const recentlyClosed = { ...longClosed, completedDate: daysAgo(119) };
    expect(canPostComment(household, recentlyClosed, SHARED, HOUSE_A, NOW)).toBe(true);
  });

  // The post rule is the read rule plus "shared only", so the repairs-only
  // type rule (ADR-0001) reaches posting with nothing implemented twice: a
  // household may not read a project on its own house, so it may not post
  // on one either -- not even shared, not even as its submitter.
  it("refuses a household account a project or capital project on its own house, shared or not", () => {
    for (const type of ["project", "capex"]) {
      expect(canPostComment(household, { ...housemateRequest, type }, SHARED, HOUSE_A)).toBe(false);
      expect(canPostComment(household, { ...housemateRequest, type }, INTERNAL, HOUSE_A)).toBe(false);
      expect(canPostComment(household, { ...housemateRequest, type, submittedBy: "alice@example.com" }, SHARED, HOUSE_A)).toBe(false);
    }
    // Positive control: the same house, the same submitter, a repair.
    expect(canPostComment(household, { ...housemateRequest, submittedBy: "alice@example.com" }, SHARED, HOUSE_A)).toBe(true);
  });

  it("leaves staff posting on every type in their regions", () => {
    for (const type of ["request", "project", "capex"]) {
      expect(canPostComment(staff, { ...housemateRequest, type }, INTERNAL)).toBe(true);
    }
  });
});

describe("canDeleteComment", () => {
  const authored = { authorUserId: "user-1" };
  const somebodyElses = { authorUserId: "user-2" };
  const orphaned = { authorUserId: null };

  it("lets the author delete their own comment", () => {
    expect(canDeleteComment(context(), authored)).toBe(true);
  });

  it("refuses another staff member", () => {
    expect(canDeleteComment(context(), somebodyElses)).toBe(false);
  });

  it("lets an admin delete anybody's", () => {
    expect(canDeleteComment(context({ role: "admin" }), somebodyElses)).toBe(true);
  });

  it("treats a comment whose author account is gone as nobody's but an admin's", () => {
    // authorUserId is set null when the account is deleted. Nothing about the
    // caller can match a null, so only an admin may take it down.
    expect(canDeleteComment(context(), orphaned)).toBe(false);
    expect(canDeleteComment(context({ role: "admin" }), orphaned)).toBe(true);
  });

  // The rule is authorship, not tier: a resident is not a second bypass
  // alongside the admin one. Nothing above exercises a resident context, so
  // these are what would have caught a resident-wide bypass on their own.
  it("lets a resident delete their own comment", () => {
    expect(canDeleteComment(context({ role: "resident" }), authored)).toBe(true);
  });

  it("refuses a resident deleting somebody else's comment", () => {
    expect(canDeleteComment(context({ role: "resident" }), somebodyElses)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Dashboard action items follow the flag of the list they come from (#158)
// ---------------------------------------------------------------------------

describe("canSeeActionItemSource", () => {
  const sees = (ctx: AuthContext) =>
    (["schedule", "maintenance", "lease", "setup", "asset", "rent", "deposit", "task"] as const).filter((source) =>
      canSeeActionItemSource(ctx, source),
    );

  it("gives staff with no flags their tasks and nothing else", () => {
    // The account the sweep found: staff tier, holding only a resident-tier grant.
    expect(sees(context({ permissions: { canCompleteWalkthroughs: true } }))).toEqual(["task"]);
  });

  it("gives each item to the flag its own list asks for", () => {
    expect(sees(context({ permissions: { canViewMaintenance: true } }))).toEqual(["schedule", "maintenance", "task"]);
    expect(sees(context({ permissions: { canManageMaintenance: true } }))).toEqual(["schedule", "maintenance", "task"]);
    expect(sees(context({ permissions: { canViewProperties: true } }))).toEqual(["lease", "setup", "task"]);
    expect(sees(context({ permissions: { canManagePropertySetup: true } }))).toEqual(["setup", "task"]);
    expect(sees(context({ permissions: { canViewAssets: true } }))).toEqual(["asset", "task"]);
    expect(sees(context({ permissions: { canViewFinancials: true } }))).toEqual(["rent", "deposit", "task"]);
  });

  it("gives an admin every item, with or without a permissions row", () => {
    expect(sees(context({ role: "admin", permissions: undefined }))).toEqual([
      "schedule", "maintenance", "lease", "setup", "asset", "rent", "deposit", "task",
    ]);
  });

  it("gives a resident nothing, even holding every staff flag", () => {
    // The route is requireStaff already; the rule does not lean on that.
    const everything = {
      canViewMaintenance: true, canViewProperties: true, canViewAssets: true, canViewFinancials: true,
    };
    expect(sees(context({ role: "resident", permissions: everything }))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// A lease-derived task additionally needs the properties flag (#170)
// ---------------------------------------------------------------------------

describe("isLeaseDerivedTaskSourceKey", () => {
  it("is true only for the two lease-derived prefixes", () => {
    expect(isLeaseDerivedTaskSourceKey("lease-renewal:prop-1:2026-10-01")).toBe(true);
    expect(isLeaseDerivedTaskSourceKey("utilities-lease:prop-1:2026-10-01")).toBe(true);
  });

  it("is false for null, other prefixes, and an unrelated string", () => {
    expect(isLeaseDerivedTaskSourceKey(null)).toBe(false);
    expect(isLeaseDerivedTaskSourceKey(undefined)).toBe(false);
    expect(isLeaseDerivedTaskSourceKey("walkthrough:apr:West Central:2026")).toBe(false);
    expect(isLeaseDerivedTaskSourceKey("utilities-summer:West Central:2026")).toBe(false);
    expect(isLeaseDerivedTaskSourceKey("something-else")).toBe(false);
  });
});

describe("canSeeTask", () => {
  const leaseTask = (overrides: Partial<{
    region: string | null;
    assignedToUserId: string | null;
    createdBy: string | null;
    sourceKey: string | null;
  }> = {}) => ({
    region: "West Central",
    assignedToUserId: null,
    createdBy: null,
    sourceKey: "lease-renewal:prop-1:2026-10-01",
    ...overrides,
  });

  it("hides a lease-derived task from staff without the properties flag, even in their own region", () => {
    const ctx = context({ allowedRegions: ["West Central"], permissions: { canViewMaintenance: true } });
    expect(canSeeTask(ctx, leaseTask())).toBe(false);
  });

  it("hides a lease-derived task from its own assignee when the flag is missing -- the rule is the rule", () => {
    const ctx = context({ allowedRegions: ["West Central"], permissions: {} });
    expect(canSeeTask(ctx, leaseTask({ assignedToUserId: "user-1", createdBy: "user-1" }))).toBe(false);
  });

  it("shows a lease-derived task to staff holding canViewProperties or canManageProperties", () => {
    const viewer = context({ allowedRegions: ["West Central"], permissions: { canViewProperties: true } });
    expect(canSeeTask(viewer, leaseTask())).toBe(true);

    const manager = context({ allowedRegions: ["West Central"], permissions: { canManageProperties: true } });
    expect(canSeeTask(manager, leaseTask())).toBe(true);
  });

  it("applies the same rule to a move-out reminder, which names a resident and their leaving date", () => {
    expect(isRosterDerivedTaskSourceKey("move-out:r-1:2027-05-20")).toBe(true);
    expect(isRosterDerivedTaskSourceKey("lease-renewal:prop-1:2026-10-01")).toBe(false);
    const moveOut = leaseTask({ sourceKey: "move-out:r-1:2027-05-20", assignedToUserId: "user-1" });
    expect(canSeeTask(context({ allowedRegions: ["West Central"], permissions: {} }), moveOut)).toBe(false);
    expect(canSeeTask(context({ allowedRegions: ["West Central"], permissions: { canViewProperties: true } }), moveOut)).toBe(true);
  });

  it("shows a lease-derived task to an admin with no permissions row at all", () => {
    const ctx = context({ role: "admin", permissions: undefined });
    expect(canSeeTask(ctx, leaseTask())).toBe(true);
  });

  it("leaves an ordinary task's visibility unaffected -- no sourceKey, or a walkthrough/utilities-summer one", () => {
    const ctx = context({ allowedRegions: ["West Central"], permissions: {} });
    expect(canSeeTask(ctx, leaseTask({ sourceKey: null }))).toBe(true);
    expect(canSeeTask(ctx, leaseTask({ sourceKey: "walkthrough:apr:West Central:2026" }))).toBe(true);
    expect(canSeeTask(ctx, leaseTask({ sourceKey: "utilities-summer:West Central:2026" }))).toBe(true);
  });

  // A personal task has no region, and once its owner's account is deleted
  // both user columns go null -- which would otherwise read as an all-regions
  // broadcast to every staff member.
  const orphanedPersonal = { region: null, assignedToUserId: null, createdBy: null, sourceKey: null };

  it("keeps a personal task whose owner's account is gone to admins", () => {
    const everywhere = context({ allowedRegions: ["all"], permissions: { canViewProperties: true } });
    expect(canSeeTask(everywhere, orphanedPersonal)).toBe(false);
    expect(canSeeTask(context({ role: "admin", permissions: undefined }), orphanedPersonal)).toBe(true);
  });

  it("still shows staff an all-regions broadcast whose author is alive, and a generated one with no author", () => {
    const ctx = context({ allowedRegions: ["West Central"], permissions: {} });
    expect(canSeeTask(ctx, { ...orphanedPersonal, createdBy: "admin-1" })).toBe(true);
    expect(canSeeTask(ctx, { ...orphanedPersonal, sourceKey: "walkthrough:apr:all:2026" })).toBe(true);
  });

  it("still shows a region broadcast whose author is gone to that region's leads, and only them", () => {
    const orphanedBroadcast = { ...orphanedPersonal, region: "West Central" };
    expect(canSeeTask(context({ allowedRegions: ["West Central"], permissions: {} }), orphanedBroadcast)).toBe(true);
    expect(canSeeTask(context({ allowedRegions: ["East Central"], permissions: {} }), orphanedBroadcast)).toBe(false);
  });
});
