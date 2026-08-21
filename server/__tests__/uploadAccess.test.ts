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

vi.mock("../storage", () => ({
  storage: {
    findUploadReferences: (...args: unknown[]) => findUploadReferences(...args),
    getAsset: (...args: unknown[]) => getAsset(...args),
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

const requestReference = (region: string, submittedBy: string): UploadReference => ({
  kind: "maintenanceRequest",
  record: { id: "req-1", region, submittedBy } as never,
});

beforeEach(() => {
  findUploadReferences.mockReset().mockResolvedValue([]);
  getAsset.mockReset();
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
