/**
 * Tests for who may download an uploaded file.
 *
 * These files include W-9s, certificates of insurance, contract invoices and
 * photographs of people's homes, so the rules are worth pinning down. The data
 * layer is replaced with a stub, so nothing here needs a database.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// The real modules reach for a database connection at import time, which would
// make this suite require credentials to do arithmetic on permission flags.
vi.mock("../db", () => ({ db: {}, pool: {} }));
vi.mock("../auth", () => ({ getUserId: vi.fn() }));

const findUploadReferences = vi.fn();
const getAsset = vi.fn();
const getProperty = vi.fn();
const getMaintenanceRequest = vi.fn();

vi.mock("../storage", () => ({
  storage: {
    findUploadReferences: (...args: unknown[]) => findUploadReferences(...args),
    getAsset: (...args: unknown[]) => getAsset(...args),
    getProperty: (...args: unknown[]) => getProperty(...args),
    getMaintenanceRequest: (...args: unknown[]) => getMaintenanceRequest(...args),
  },
}));

import { canReadUpload } from "../authz";
import type { AuthContext } from "../authz";
import type { UploadReference } from "../storage";
import type { Upload } from "@shared/schema";

const KEY = "0123456789abcdef0123456789abcdef.pdf";
const URL = `/uploads/${KEY}`;

function context(overrides: Partial<AuthContext> & { role?: string } = {}): AuthContext {
  const role = overrides.role ?? "staff";
  return {
    userId: overrides.userId ?? "user-1",
    user: {
      id: overrides.userId ?? "user-1",
      email: "staff@example.com",
      role,
      isActive: true,
    } as AuthContext["user"],
    permissions: undefined,
    isAdmin: role === "admin",
    isResident: role === "resident",
    allowedRegions: [],
    ...overrides,
  } as AuthContext;
}

function permissions(granted: Record<string, boolean>) {
  return granted as unknown as AuthContext["permissions"];
}

function uploadRow(uploadedBy: string): Upload {
  return {
    id: "upload-1",
    storageKey: KEY,
    originalName: "w9.pdf",
    contentType: "application/pdf",
    sizeBytes: 1024,
    uploadedBy,
    createdAt: new Date(),
  };
}

const billingReference = (region: string): UploadReference => ({
  kind: "billingRecord",
  record: { id: "billing-1", region } as UploadReference extends { kind: "billingRecord"; record: infer R } ? R : never,
});

const requestReference = (
  region: string,
  submittedBy: string,
  buildingAddress?: string,
): UploadReference => ({
  kind: "maintenanceRequest",
  // A repair: the type rule fails closed on a missing type.
  record: { id: "req-1", region, submittedBy, buildingAddress, type: "request" } as never,
});

const photoReference = (requestId: string): UploadReference => ({
  kind: "maintenanceRequestPhoto",
  record: { id: "photo-1", requestId } as never,
});

beforeEach(() => {
  findUploadReferences.mockReset().mockResolvedValue([]);
  getAsset.mockReset();
  getProperty.mockReset().mockResolvedValue(undefined);
  getMaintenanceRequest.mockReset().mockResolvedValue(undefined);
});

describe("canReadUpload", () => {
  it("lets an administrator read anything, without a lookup", async () => {
    expect(await canReadUpload(context({ role: "admin" }), KEY, undefined)).toBe(true);
    expect(findUploadReferences).not.toHaveBeenCalled();
  });

  it("lets the uploader read their own file before it is attached to anything", async () => {
    // The form shows a preview of the photo before the record is saved. At that
    // moment nothing references the file, so the uploader is the only claim.
    const ctx = context({ userId: "user-7" });
    expect(await canReadUpload(ctx, KEY, uploadRow("user-7"))).toBe(true);
  });

  it("stops honouring the uploader once a record points at the file", async () => {
    // Otherwise uploading a document would grant permanent personal access to
    // it, surviving every later change to the uploader's permissions.
    findUploadReferences.mockResolvedValue([billingReference("Twin Cities")]);
    const ctx = context({ userId: "user-7", allowedRegions: [] });
    expect(await canReadUpload(ctx, KEY, uploadRow("user-7"))).toBe(false);
  });

  it("revokes an uploader who is moved out of the region", async () => {
    findUploadReferences.mockResolvedValue([billingReference("Twin Cities")]);
    const before = context({
      userId: "user-7",
      permissions: permissions({ canViewBilling: true }),
      allowedRegions: ["Twin Cities"],
    });
    const after = context({
      userId: "user-7",
      permissions: permissions({ canViewBilling: true }),
      allowedRegions: ["Chicago"],
    });

    expect(await canReadUpload(before, KEY, uploadRow("user-7"))).toBe(true);
    expect(await canReadUpload(after, KEY, uploadRow("user-7"))).toBe(false);
  });

  it("revokes an uploader who loses the relevant permission", async () => {
    findUploadReferences.mockResolvedValue([billingReference("Twin Cities")]);
    const ctx = context({
      userId: "user-7",
      permissions: permissions({ canViewBilling: false, canViewAssets: true }),
      allowedRegions: ["Twin Cities"],
    });
    expect(await canReadUpload(ctx, KEY, uploadRow("user-7"))).toBe(false);
  });

  it("revokes an uploader who is demoted to a resident", async () => {
    findUploadReferences.mockResolvedValue([billingReference("Twin Cities")]);
    const ctx = context({
      userId: "user-7",
      role: "resident",
      permissions: permissions({ canViewBilling: true }),
      allowedRegions: ["Twin Cities"],
    });
    expect(await canReadUpload(ctx, KEY, uploadRow("user-7"))).toBe(false);
  });

  it("refuses a file nobody references and somebody else uploaded", async () => {
    const ctx = context({
      userId: "user-9",
      permissions: permissions({ canViewBilling: true }),
      allowedRegions: ["Twin Cities"],
    });
    expect(await canReadUpload(ctx, KEY, uploadRow("user-7"))).toBe(false);
  });

  it("refuses a file that does not exist at all", async () => {
    expect(await canReadUpload(context(), KEY, undefined)).toBe(false);
  });

  it("searches for records by the URL the application stores", async () => {
    await canReadUpload(context(), KEY, undefined);
    expect(findUploadReferences).toHaveBeenCalledWith(URL);
  });
});

describe("canReadUpload, through a billing record", () => {
  it("allows staff with billing access in the record's region", async () => {
    findUploadReferences.mockResolvedValue([billingReference("Twin Cities")]);
    const ctx = context({
      permissions: permissions({ canViewBilling: true }),
      allowedRegions: ["Twin Cities"],
    });
    expect(await canReadUpload(ctx, KEY, uploadRow("someone-else"))).toBe(true);
  });

  it("refuses staff whose regions do not cover the record", async () => {
    findUploadReferences.mockResolvedValue([billingReference("Twin Cities")]);
    const ctx = context({
      permissions: permissions({ canViewBilling: true }),
      allowedRegions: ["Chicago"],
    });
    expect(await canReadUpload(ctx, KEY, uploadRow("someone-else"))).toBe(false);
  });

  it("refuses staff who can reach the region but not billing", async () => {
    findUploadReferences.mockResolvedValue([billingReference("Twin Cities")]);
    const ctx = context({
      permissions: permissions({ canViewMaintenance: true }),
      allowedRegions: ["Twin Cities"],
    });
    expect(await canReadUpload(ctx, KEY, uploadRow("someone-else"))).toBe(false);
  });

  it("refuses a resident outright", async () => {
    // A resident has no business reading a vendor's tax form, whatever else
    // their account happens to be able to see.
    findUploadReferences.mockResolvedValue([billingReference("Twin Cities")]);
    const ctx = context({
      role: "resident",
      permissions: permissions({ canViewBilling: true }),
      allowedRegions: ["Twin Cities"],
    });
    expect(await canReadUpload(ctx, KEY, uploadRow("someone-else"))).toBe(false);
  });
});

describe("canReadUpload, through a maintenance request", () => {
  it("lets the resident who submitted it see the photo, regardless of region", async () => {
    findUploadReferences.mockResolvedValue([
      requestReference("Chicago", "staff@example.com"),
    ]);
    const ctx = context({ role: "resident" });
    expect(await canReadUpload(ctx, KEY, undefined)).toBe(true);
  });

  it("does not let a different resident see it", async () => {
    findUploadReferences.mockResolvedValue([
      requestReference("Chicago", "someone.else@example.com"),
    ]);
    const ctx = context({ role: "resident" });
    expect(await canReadUpload(ctx, KEY, undefined)).toBe(false);
  });

  it("lets the housemate see the photo on their house's request", async () => {
    // A photo inherits the visibility of the request, and the request is
    // visible to both resident accounts on the house — so the photo is too.
    const HOUSE_A = "123 Main St, Saint Paul, MN 55101";
    findUploadReferences.mockResolvedValue([
      requestReference("Chicago", "someone.else@example.com", HOUSE_A),
    ]);
    getProperty.mockResolvedValue({ id: "prop-a", address: HOUSE_A });

    const ctx = context({ role: "resident" });
    (ctx.user as { propertyId?: string }).propertyId = "prop-a";

    expect(await canReadUpload(ctx, KEY, undefined)).toBe(true);
    expect(getProperty).toHaveBeenCalledWith("prop-a");
  });

  it("does not let a resident of another house see it", async () => {
    findUploadReferences.mockResolvedValue([
      requestReference("Chicago", "someone.else@example.com", "123 Main St, Saint Paul, MN 55101"),
    ]);
    getProperty.mockResolvedValue({ id: "prop-b", address: "456 Oak Ave, Saint Paul, MN 55104" });

    const ctx = context({ role: "resident" });
    (ctx.user as { propertyId?: string }).propertyId = "prop-b";

    expect(await canReadUpload(ctx, KEY, undefined)).toBe(false);
  });
});

describe("canReadUpload, through a request photo row", () => {
  // Same house rule as the request itself: the photo row carries only a
  // requestId, so visibility is resolved through the request it belongs to.
  const HOUSE_A = "123 Main St, Saint Paul, MN 55101";

  it("lets the housemate see a photo attached to their house's request", async () => {
    findUploadReferences.mockResolvedValue([photoReference("req-1")]);
    getMaintenanceRequest.mockResolvedValue({
      id: "req-1",
      region: "Chicago",
      submittedBy: "someone.else@example.com",
      buildingAddress: HOUSE_A,
      type: "request",
    });
    getProperty.mockResolvedValue({ id: "prop-a", address: HOUSE_A });

    const ctx = context({ role: "resident" });
    (ctx.user as { propertyId?: string }).propertyId = "prop-a";

    expect(await canReadUpload(ctx, KEY, undefined)).toBe(true);
  });

  it("does not let a resident of another house see it", async () => {
    findUploadReferences.mockResolvedValue([photoReference("req-1")]);
    getMaintenanceRequest.mockResolvedValue({
      id: "req-1",
      region: "Chicago",
      submittedBy: "someone.else@example.com",
      buildingAddress: HOUSE_A,
      type: "request",
    });
    getProperty.mockResolvedValue({ id: "prop-b", address: "456 Oak Ave, Saint Paul, MN 55104" });

    const ctx = context({ role: "resident" });
    (ctx.user as { propertyId?: string }).propertyId = "prop-b";

    expect(await canReadUpload(ctx, KEY, undefined)).toBe(false);
  });

  it("refuses when the photo's request no longer exists", async () => {
    findUploadReferences.mockResolvedValue([photoReference("req-gone")]);
    const ctx = context({ role: "resident" });
    expect(await canReadUpload(ctx, KEY, undefined)).toBe(false);
  });
});

describe("canReadUpload, through a comment's attachment", () => {
  // The file inherits the COMMENT's visibility, not only the request's: the
  // request rule decides the house, the region and the 120-day window, and
  // the comment's own visibility decides the tier on top. That second half is
  // the whole point of this kind -- "he quoted $4,200" as a PDF on an internal
  // comment must be as invisible to the household as the words would be.
  const HOUSE_A = "123 Main St, Saint Paul, MN 55101";
  const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

  const commentReference = (isInternal: boolean, requestId = "req-1"): UploadReference => ({
    kind: "maintenanceRequestComment",
    record: { id: "c-1", requestId, isInternal, attachmentUrl: URL } as never,
  });

  const houseARequest = (overrides: Record<string, unknown> = {}) => ({
    id: "req-1",
    region: "Chicago",
    submittedBy: "someone.else@example.com",
    buildingAddress: HOUSE_A,
    status: "pending",
    type: "request",
    ...overrides,
  });

  const leaderOfHouseA = () => {
    getProperty.mockResolvedValue({ id: "prop-a", address: HOUSE_A });
    const ctx = context({ role: "resident", userId: "res-1" });
    (ctx.user as { propertyId?: string }).propertyId = "prop-a";
    return ctx;
  };

  it("lets a household leader fetch the file on a shared comment on their house's request", async () => {
    findUploadReferences.mockResolvedValue([commentReference(false)]);
    getMaintenanceRequest.mockResolvedValue(houseARequest());
    expect(await canReadUpload(leaderOfHouseA(), KEY, undefined)).toBe(true);
  });

  it("refuses that same leader the file on an internal comment on the same request", async () => {
    findUploadReferences.mockResolvedValue([commentReference(true)]);
    getMaintenanceRequest.mockResolvedValue(houseARequest());
    expect(await canReadUpload(leaderOfHouseA(), KEY, undefined)).toBe(false);
  });

  it("refuses a leader the file on a shared comment when the request is a project, even on their own house", async () => {
    // ADR-0001: a project's bid amounts and contract terms are staff-only,
    // whatever the comment's own visibility says. isRepair fails this before
    // either resident path (ownership or house) is ever reached.
    findUploadReferences.mockResolvedValue([commentReference(false)]);
    getMaintenanceRequest.mockResolvedValue(houseARequest({ type: "project" }));
    expect(await canReadUpload(leaderOfHouseA(), KEY, undefined)).toBe(false);
  });

  it("refuses a resident of another house the file on a shared comment", async () => {
    findUploadReferences.mockResolvedValue([commentReference(false)]);
    getMaintenanceRequest.mockResolvedValue(houseARequest());
    getProperty.mockResolvedValue({ id: "prop-b", address: "456 Oak Ave, Saint Paul, MN 55104" });
    const ctx = context({ role: "resident", userId: "res-2" });
    (ctx.user as { propertyId?: string }).propertyId = "prop-b";
    expect(await canReadUpload(ctx, KEY, undefined)).toBe(false);
  });

  it("refuses the leader once the request closed more than 120 days ago", async () => {
    // The window reaches the file through the request rule, and a closed
    // request with no close date fails closed exactly as it does on the page.
    findUploadReferences.mockResolvedValue([commentReference(false)]);
    getMaintenanceRequest.mockResolvedValue(houseARequest({ status: "completed", completedDate: daysAgo(121) }));
    expect(await canReadUpload(leaderOfHouseA(), KEY, undefined)).toBe(false);

    // Positive control for the window: closed inside it, the same file is served.
    getMaintenanceRequest.mockResolvedValue(houseARequest({ status: "completed", completedDate: daysAgo(119) }));
    expect(await canReadUpload(leaderOfHouseA(), KEY, undefined)).toBe(true);
  });

  it("lets staff covering the request's region fetch the file on either kind of comment", async () => {
    getMaintenanceRequest.mockResolvedValue(houseARequest());
    const ctx = context({
      permissions: permissions({ canViewMaintenance: true }),
      allowedRegions: ["Chicago"],
    });
    findUploadReferences.mockResolvedValue([commentReference(true)]);
    expect(await canReadUpload(ctx, KEY, undefined)).toBe(true);
    findUploadReferences.mockResolvedValue([commentReference(false)]);
    expect(await canReadUpload(ctx, KEY, undefined)).toBe(true);
  });

  it("refuses staff covering another region", async () => {
    findUploadReferences.mockResolvedValue([commentReference(false)]);
    getMaintenanceRequest.mockResolvedValue(houseARequest());
    const ctx = context({
      permissions: permissions({ canViewMaintenance: true }),
      allowedRegions: ["Twin Cities"],
    });
    expect(await canReadUpload(ctx, KEY, undefined)).toBe(false);
  });

  it("refuses when the comment's request no longer exists", async () => {
    findUploadReferences.mockResolvedValue([commentReference(false, "req-gone")]);
    expect(await canReadUpload(leaderOfHouseA(), KEY, undefined)).toBe(false);
  });
});

describe("canReadUpload, through an asset photo", () => {
  const assetPhotoReference: UploadReference = {
    kind: "assetPhoto",
    record: { id: "photo-1", assetId: "asset-1" } as never,
  };

  it("takes the region from the asset the photo belongs to", async () => {
    findUploadReferences.mockResolvedValue([assetPhotoReference]);
    getAsset.mockResolvedValue({ id: "asset-1", region: "Twin Cities" });

    const allowed = context({
      permissions: permissions({ canViewAssets: true }),
      allowedRegions: ["Twin Cities"],
    });
    const denied = context({
      permissions: permissions({ canViewAssets: true }),
      allowedRegions: ["Chicago"],
    });

    expect(await canReadUpload(allowed, KEY, undefined)).toBe(true);
    expect(await canReadUpload(denied, KEY, undefined)).toBe(false);
  });

  it("refuses when the asset has gone missing", async () => {
    // No asset means no region to check against, and an unknown region is
    // denied rather than waved through.
    findUploadReferences.mockResolvedValue([assetPhotoReference]);
    getAsset.mockResolvedValue(undefined);

    const ctx = context({
      permissions: permissions({ canViewAssets: true }),
      allowedRegions: ["Twin Cities"],
    });
    expect(await canReadUpload(ctx, KEY, undefined)).toBe(false);
  });
});

describe("canReadUpload, through a property's front-of-house photo", () => {
  const propertyReference: UploadReference = {
    kind: "property",
    record: { id: "prop-1", region: "Twin Cities", address: "1 Main St" } as never,
  };

  beforeEach(() => {
    findUploadReferences.mockResolvedValue([propertyReference]);
  });

  it("lets staff in their region see the house they cover", async () => {
    const ctx = context({
      permissions: permissions({ canViewProperties: true }),
      allowedRegions: ["Twin Cities"],
    });
    expect(await canReadUpload(ctx, KEY, undefined)).toBe(true);
  });

  it("refuses staff covering another region", async () => {
    const ctx = context({
      permissions: permissions({ canViewProperties: true }),
      allowedRegions: ["Chicago"],
    });
    expect(await canReadUpload(ctx, KEY, undefined)).toBe(false);
  });

  it("refuses staff holding no property permission, even in the right region", async () => {
    const ctx = context({
      permissions: permissions({ canViewMaintenance: true }),
      allowedRegions: ["Twin Cities"],
    });
    expect(await canReadUpload(ctx, KEY, undefined)).toBe(false);
  });

  it("refuses a resident, including one linked to that very house", async () => {
    // No resident surface shows a house photo yet, so nobody at that tier has
    // a reason to fetch one. The linked-to-this-house case is the one worth
    // pinning: it is the case a later change would be tempted to allow, and
    // when the resource hub needs it the rule to add is a house match, never
    // the region path their permissions row happens to name.
    getProperty.mockResolvedValue({ id: "prop-1", address: "1 Main St", region: "Twin Cities" });
    const ctx = context({
      role: "resident",
      userId: "res-1",
      permissions: permissions({ canViewProperties: true }),
      allowedRegions: ["Twin Cities"],
    });
    (ctx.user as { propertyId?: string }).propertyId = "prop-1";
    expect(await canReadUpload(ctx, KEY, undefined)).toBe(false);
  });
});

describe("canReadUpload, when several records share a file", () => {
  it("allows access as soon as one of them is readable", async () => {
    findUploadReferences.mockResolvedValue([
      billingReference("Chicago"),
      billingReference("Twin Cities"),
    ]);
    const ctx = context({
      permissions: permissions({ canViewBilling: true }),
      allowedRegions: ["Twin Cities"],
    });
    expect(await canReadUpload(ctx, KEY, undefined)).toBe(true);
  });

  it("refuses when none of them are", async () => {
    findUploadReferences.mockResolvedValue([
      billingReference("Chicago"),
      billingReference("Duluth"),
    ]);
    const ctx = context({
      permissions: permissions({ canViewBilling: true }),
      allowedRegions: ["Twin Cities"],
    });
    expect(await canReadUpload(ctx, KEY, undefined)).toBe(false);
  });
});

describe("canReadUpload, through a bid's document", () => {
  // A quote on a project is readable by whoever can read the project, and by
  // nobody else. The request's region decides that for staff. A resident is
  // refused by name rather than left to the request rule: the request rule
  // would let a leader through if the project were later turned back into a
  // repair, and the bids on it -- and their documents -- do not go anywhere
  // when that happens.
  const HOUSE_A = "123 Main St, Saint Paul, MN 55101";

  const bidReference = (requestId = "req-1"): UploadReference => ({
    kind: "maintenanceRequestBid",
    record: { id: "bid-1", requestId, documentUrl: URL } as never,
  });

  const houseAProject = (overrides: Record<string, unknown> = {}) => ({
    id: "req-1",
    region: "Chicago",
    submittedBy: "someone.else@example.com",
    buildingAddress: HOUSE_A,
    status: "pending",
    type: "project",
    ...overrides,
  });

  const leaderOfHouseA = () => {
    getProperty.mockResolvedValue({ id: "prop-a", address: HOUSE_A });
    const ctx = context({ role: "resident", userId: "res-1" });
    (ctx.user as { propertyId?: string }).propertyId = "prop-a";
    return ctx;
  };

  beforeEach(() => {
    findUploadReferences.mockResolvedValue([bidReference()]);
    getMaintenanceRequest.mockResolvedValue(houseAProject());
  });

  it("lets staff covering the request's region fetch it", async () => {
    const ctx = context({
      permissions: permissions({ canViewMaintenance: true }),
      allowedRegions: ["Chicago"],
    });
    expect(await canReadUpload(ctx, KEY, undefined)).toBe(true);
  });

  it("refuses staff covering another region", async () => {
    const ctx = context({
      permissions: permissions({ canViewMaintenance: true }),
      allowedRegions: ["Twin Cities"],
    });
    expect(await canReadUpload(ctx, KEY, undefined)).toBe(false);
  });

  it("refuses a household leader of that very house", async () => {
    expect(await canReadUpload(leaderOfHouseA(), KEY, undefined)).toBe(false);
  });

  it("refuses that leader even once the project has been turned back into a repair", async () => {
    // The request rule alone would say yes here. The bid rule does not.
    getMaintenanceRequest.mockResolvedValue(houseAProject({ type: "request" }));
    expect(await canReadUpload(leaderOfHouseA(), KEY, undefined)).toBe(false);
  });

  it("still lets staff covering the region fetch it once the project has been turned back into a repair", async () => {
    // The bid stays in its table across the demotion (a type change is not a
    // delete), so the document staff already had reach to must not vanish
    // out from under them the way it deliberately does for a resident.
    getMaintenanceRequest.mockResolvedValue(houseAProject({ type: "request" }));
    const ctx = context({
      permissions: permissions({ canViewMaintenance: true }),
      allowedRegions: ["Chicago"],
    });
    expect(await canReadUpload(ctx, KEY, undefined)).toBe(true);
  });

  it("refuses the resident who originally filed it, even after it became a project and was turned back into a repair", async () => {
    // canReadMaintenanceRequest alone would say yes here: a repair, and this
    // resident owns the submission. The explicit resident refusal on a bid
    // is what still says no -- this is the case it exists for.
    getMaintenanceRequest.mockResolvedValue(houseAProject({ type: "request", submittedBy: "staff@example.com" }));
    const ctx = context({ role: "resident", userId: "res-2" });
    expect(await canReadUpload(ctx, KEY, undefined)).toBe(false);
  });

  it("refuses when the bid's request no longer exists", async () => {
    getMaintenanceRequest.mockResolvedValue(undefined);
    const ctx = context({
      permissions: permissions({ canViewMaintenance: true }),
      allowedRegions: ["Chicago"],
    });
    expect(await canReadUpload(ctx, KEY, undefined)).toBe(false);
  });
});
