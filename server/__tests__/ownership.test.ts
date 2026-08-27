/**
 * Route-level tests for the resident ownership gate.
 *
 * These tests exercise the actual Express route handlers in routes.ts with
 * mocked storage and auth, so a refactor that removes or inverts the
 * ownership check will cause these tests to fail.
 *
 * Three endpoints are covered:
 *   GET /api/maintenance-requests              (list, same rule as detail)
 *   GET /api/maintenance-requests/:id
 *   GET /api/maintenance-requests/:id/contacts
 *
 * The ownership check compares request.submittedBy against currentUser.email.
 * "submittedBy" stores the creator's email at request-creation time, NOT a
 * user ID.  A future refactor that changes the stored value to a user ID would
 * silently break the gate — these tests will catch that regression too, because
 * the mocked data uses realistic email values.
 *
 * Alongside the email match, a resident account linked to a property (via
 * users.propertyId) may read every request filed for that house, so the two
 * resident accounts on a property share one repair history. The house match
 * is additive: it never replaces the email comparison, and an account with no
 * property link falls back to email-only.
 */

import {
  vi,
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import express from "express";
import type { Server } from "node:http";

// ---------------------------------------------------------------------------
// Hoist the mock implementations so they are available inside vi.mock factory
// functions, which vitest lifts to the top of the module before imports.
// ---------------------------------------------------------------------------

const {
  mockGetUser,
  mockGetPermissions,
  mockGetRequest,
  mockGetContacts,
  mockGetProperty,
  mockGetAllRequests,
  mockGetAllRequestPhotos,
  mockGetRequestPhoto,
  mockDeleteRequestPhoto,
  activeUserId,
} = vi.hoisted(() => ({
  mockGetUser: vi.fn(),
  mockGetPermissions: vi.fn(),
  mockGetRequest: vi.fn(),
  mockGetContacts: vi.fn(),
  mockGetProperty: vi.fn(),
  mockGetAllRequests: vi.fn(),
  mockGetAllRequestPhotos: vi.fn(),
  mockGetRequestPhoto: vi.fn(),
  mockDeleteRequestPhoto: vi.fn(),
  /** Mutable box — tests change .value to switch which user is "logged in". */
  activeUserId: { value: "resident-1" },
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// routes.ts reaches the real database module through authz.ts → migrateRegions,
// and db.ts throws at import when DATABASE_URL is unset. Storage is already
// mocked below, so the database itself is never used here.
vi.mock("../db", () => ({ db: {}, pool: {} }));

vi.mock("../storage", () => ({
  storage: {
    getUser: mockGetUser,
    getUserPermissions: mockGetPermissions,
    getMaintenanceRequest: mockGetRequest,
    getRequestContacts: mockGetContacts,
    getProperty: mockGetProperty,
    getAllMaintenanceRequestPhotos: mockGetAllRequestPhotos,
    getMaintenanceRequestPhoto: mockGetRequestPhoto,
    deleteMaintenanceRequestPhoto: mockDeleteRequestPhoto,
    // Stubs for other storage methods routes.ts may reference
    getAllMaintenanceRequests: mockGetAllRequests,
    createMaintenanceRequest: vi.fn(),
    updateMaintenanceRequest: vi.fn(),
    deleteMaintenanceRequest: vi.fn(),
    getAllWalkthroughRooms: vi.fn().mockResolvedValue([]),
    getAllAssets: vi.fn().mockResolvedValue([]),
    getAllInvoices: vi.fn().mockResolvedValue([]),
    getAllBillingRecords: vi.fn().mockResolvedValue([]),
    getAllProperties: vi.fn().mockResolvedValue([]),
    getAllUsers: vi.fn().mockResolvedValue([]),
    getUser: mockGetUser,
  },
}));

vi.mock("../auth", () => ({
  /** No-op during test setup — we don't need OIDC or session middleware. */
  setupAuth: vi.fn().mockResolvedValue(undefined),
  /**
   * Bypass auth check; the real session/cookie machinery is not needed here
   * because we are testing authorization logic, not authentication.
   */
  isAuthenticated: (_req: any, _res: any, next: any) => next(),
  /** Always returns the currently active test user ID. */
  getUserId: () => activeUserId.value,
}));

vi.mock("../objectStorage", () => ({
  generateStorageKey: vi.fn(),
  isSafeStorageKey: vi.fn(() => true),
  putUpload: vi.fn(),
  uploadExists: vi.fn(),
  removeUpload: vi.fn(),
  openUploadStream: vi.fn(),
  createUploadSignedUrl: vi.fn(),
  contentTypeFor: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import and start the test server
// ---------------------------------------------------------------------------

import { registerRoutes } from "../routes";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // registerRoutes registers all routes on `app` and returns an http.Server.
  // setupAuth is mocked to a no-op so no OIDC/session setup runs.
  server = await registerRoutes(app);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve())
  );
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(
  () =>
    new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    )
);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Two houses. `properties.address` is unique and computed server-side, and a
// request's buildingAddress is copied from it at creation, so the route-level
// house match is between two copies of the same canonical string.
const PROPERTY_A = {
  id: "prop-a",
  address: "123 Main St, Saint Paul, MN 55101",
  region: "West Central",
};
const PROPERTY_B = {
  id: "prop-b",
  address: "456 Oak Ave, Saint Paul, MN 55104",
  region: "West Central",
};

// Alice and Bob are the two resident accounts on property A — steward and
// household leader. Carol lives at property B. Dave is a resident account
// nobody has linked to a house yet.
const ALICE_ID = "user-alice";
const ALICE_EMAIL = "alice@example.com";

const BOB_ID = "user-bob";
const BOB_EMAIL = "bob@example.com";

const CAROL_ID = "user-carol";
const CAROL_EMAIL = "carol@example.com";

const DAVE_ID = "user-dave";
const DAVE_EMAIL = "dave@example.com";

const STAFF_ID = "user-staff";
const STAFF_EMAIL = "staff@example.com";

const ADMIN_ID = "user-admin";
const ADMIN_EMAIL = "admin@example.com";

/** Signs in a resident account, optionally linked to a property. */
function actAsResident(id: string, email: string, propertyId: string | null) {
  activeUserId.value = id;
  mockGetUser.mockResolvedValue({
    id,
    email,
    role: "resident",
    isActive: true,
    propertyId,
  });
  mockGetPermissions.mockResolvedValue(canViewPerms);
}

/** Permissions that give a user read access to maintenance requests. */
const canViewPerms = {
  canViewMaintenance: true,
  canManageMaintenance: false,
  allowedRegions: ["all"],
};

/** A maintenance request submitted by Alice (email stored, not user ID). */
const alicesRequest = {
  id: "req-1",
  title: "Leaky faucet",
  submittedBy: ALICE_EMAIL, // key field — must be email, not user ID
  region: "West Central",
  buildingAddress: PROPERTY_A.address,
  status: "open",
};

// Reset mock implementations before each test so leakage between tests is
// impossible.
beforeEach(() => {
  mockGetUser.mockReset();
  mockGetPermissions.mockReset();
  mockGetRequest.mockReset();
  mockGetContacts.mockReset();
  mockGetProperty.mockReset();
  mockGetAllRequests.mockReset();
  mockGetAllRequestPhotos.mockReset().mockResolvedValue([]);
  mockGetRequestPhoto.mockReset();
  mockDeleteRequestPhoto.mockReset();

  // Default: the request exists
  mockGetRequest.mockResolvedValue(alicesRequest);
  // Default: contacts are empty
  mockGetContacts.mockResolvedValue([]);
  // Default: the list holds only Alice's request
  mockGetAllRequests.mockResolvedValue([alicesRequest]);
  // Property lookups resolve by id, like the real storage layer
  mockGetProperty.mockImplementation(async (id: string) =>
    id === PROPERTY_A.id ? PROPERTY_A : id === PROPERTY_B.id ? PROPERTY_B : undefined,
  );
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

async function getJson(
  path: string
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${path}`);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// GET /api/maintenance-requests/:id — ownership gate
// ---------------------------------------------------------------------------

describe("GET /api/maintenance-requests/:id — ownership gate", () => {
  it("returns 403 when a resident of another house requests it", async () => {
    // Carol (property B) tries to read Alice's request (property A).
    actAsResident(CAROL_ID, CAROL_EMAIL, PROPERTY_B.id);

    const { status } = await getJson("/api/maintenance-requests/req-1");
    expect(status).toBe(403);
  });

  it("returns 403 for a resident account with no linked house", async () => {
    // Dave has an account but nobody has linked it to a property. No link
    // means no house claim — the gate falls back to email-only ownership.
    actAsResident(DAVE_ID, DAVE_EMAIL, null);

    const { status } = await getJson("/api/maintenance-requests/req-1");
    expect(status).toBe(403);
  });

  it("returns 200 when a resident requests their own maintenance request", async () => {
    // Alice (resident) reads her own request.
    actAsResident(ALICE_ID, ALICE_EMAIL, PROPERTY_A.id);

    const { status, body } = await getJson("/api/maintenance-requests/req-1");
    expect(status).toBe(200);
    expect((body as any).id).toBe("req-1");
  });

  it("returns 200 when the other resident account on the same house requests it", async () => {
    // Bob shares property A with Alice. The house shares one repair history,
    // so he can read the request she filed.
    actAsResident(BOB_ID, BOB_EMAIL, PROPERTY_A.id);

    const { status, body } = await getJson("/api/maintenance-requests/req-1");
    expect(status).toBe(200);
    expect((body as any).id).toBe("req-1");
  });

  it("returns 403 for the housemate when their linked property no longer exists", async () => {
    // A deleted property leaves propertyId dangling; the lookup fails closed.
    actAsResident(BOB_ID, BOB_EMAIL, "prop-deleted");

    const { status } = await getJson("/api/maintenance-requests/req-1");
    expect(status).toBe(403);
  });

  it("returns 200 when an admin reads another user's maintenance request", async () => {
    activeUserId.value = ADMIN_ID;
    mockGetUser.mockResolvedValue({
      id: ADMIN_ID,
      email: ADMIN_EMAIL,
      role: "admin",
      isActive: true,
    });
    mockGetPermissions.mockResolvedValue({ ...canViewPerms, allowedRegions: ["all"] });

    const { status } = await getJson("/api/maintenance-requests/req-1");
    expect(status).toBe(200);
  });

  it("returns 200 when a regional_administrator reads a request in their region", async () => {
    activeUserId.value = STAFF_ID;
    mockGetUser.mockResolvedValue({
      id: STAFF_ID,
      email: STAFF_EMAIL,
      role: "regional_administrator",
      isActive: true,
    });
    mockGetPermissions.mockResolvedValue({
      ...canViewPerms,
      allowedRegions: ["West Central"],
    });

    const { status } = await getJson("/api/maintenance-requests/req-1");
    expect(status).toBe(200);
  });

});

// ---------------------------------------------------------------------------
// GET /api/maintenance-requests/:id/contacts — ownership gate
// ---------------------------------------------------------------------------

describe("GET /api/maintenance-requests/:id/contacts — ownership gate", () => {
  it("returns 403 when a resident of another house requests contacts", async () => {
    actAsResident(CAROL_ID, CAROL_EMAIL, PROPERTY_B.id);

    const { status } = await getJson(
      "/api/maintenance-requests/req-1/contacts"
    );
    expect(status).toBe(403);
  });

  it("does not fetch contacts from storage when the resident is blocked", async () => {
    actAsResident(CAROL_ID, CAROL_EMAIL, PROPERTY_B.id);

    await getJson("/api/maintenance-requests/req-1/contacts");

    // Storage.getRequestContacts must never be called — the route should 403
    // before it ever loads contact details.
    expect(mockGetContacts).not.toHaveBeenCalled();
  });

  it("returns 200 when a resident requests contacts on their own request", async () => {
    actAsResident(ALICE_ID, ALICE_EMAIL, PROPERTY_A.id);

    const { status, body } = await getJson(
      "/api/maintenance-requests/req-1/contacts"
    );
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
  });

  it("returns 200 when the housemate requests contacts on the house's request", async () => {
    actAsResident(BOB_ID, BOB_EMAIL, PROPERTY_A.id);

    const { status, body } = await getJson(
      "/api/maintenance-requests/req-1/contacts"
    );
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
  });

  it("returns 200 when an admin requests contacts on any request", async () => {
    activeUserId.value = ADMIN_ID;
    mockGetUser.mockResolvedValue({
      id: ADMIN_ID,
      email: ADMIN_EMAIL,
      role: "admin",
      isActive: true,
    });
    mockGetPermissions.mockResolvedValue({ ...canViewPerms, allowedRegions: ["all"] });

    const { status } = await getJson(
      "/api/maintenance-requests/req-1/contacts"
    );
    expect(status).toBe(200);
  });

  it("returns 200 when a regional_administrator requests contacts on any request", async () => {
    activeUserId.value = STAFF_ID;
    mockGetUser.mockResolvedValue({
      id: STAFF_ID,
      email: STAFF_EMAIL,
      role: "regional_administrator",
      isActive: true,
    });
    mockGetPermissions.mockResolvedValue({
      ...canViewPerms,
      allowedRegions: ["West Central"],
    });

    const { status } = await getJson(
      "/api/maintenance-requests/req-1/contacts"
    );
    expect(status).toBe(200);
  });

});

// ---------------------------------------------------------------------------
// GET /api/maintenance-requests — the list applies the same rule
// ---------------------------------------------------------------------------

describe("GET /api/maintenance-requests — ownership filter", () => {
  it("includes the house's requests for the housemate who did not file them", async () => {
    actAsResident(BOB_ID, BOB_EMAIL, PROPERTY_A.id);

    const { status, body } = await getJson("/api/maintenance-requests");
    expect(status).toBe(200);
    expect((body as any[]).map((r) => r.id)).toEqual(["req-1"]);
  });

  it("returns an empty list to a resident of another house", async () => {
    actAsResident(CAROL_ID, CAROL_EMAIL, PROPERTY_B.id);

    const { status, body } = await getJson("/api/maintenance-requests");
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it("returns an empty list to a resident with no linked house and no submissions", async () => {
    actAsResident(DAVE_ID, DAVE_EMAIL, null);

    const { status, body } = await getJson("/api/maintenance-requests");
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it("applies the same house rule to the request-photos list", async () => {
    // The photo list inherits each request's visibility, so the housemate who
    // did not file the request still sees the photos attached to it — and a
    // resident of another house sees none.
    const photo = { id: "photo-1", requestId: "req-1", imageUrl: "/uploads/abc.jpg" };
    mockGetAllRequestPhotos.mockResolvedValue([photo]);

    actAsResident(BOB_ID, BOB_EMAIL, PROPERTY_A.id);
    const housemate = await getJson("/api/maintenance-request-photos");
    expect(housemate.status).toBe(200);
    expect((housemate.body as any[]).map((p) => p.id)).toEqual(["photo-1"]);

    actAsResident(CAROL_ID, CAROL_EMAIL, PROPERTY_B.id);
    const stranger = await getJson("/api/maintenance-request-photos");
    expect(stranger.status).toBe(200);
    expect(stranger.body).toEqual([]);
  });

  it("still refuses the housemate deleting a photo they did not upload", async () => {
    // Visibility widened; deletion did not. A resident may remove only the
    // photos they added themselves, housemate or not.
    mockGetRequestPhoto.mockResolvedValue({
      id: "photo-1",
      requestId: "req-1",
      uploadedBy: ALICE_EMAIL,
    });
    actAsResident(BOB_ID, BOB_EMAIL, PROPERTY_A.id);

    const res = await fetch(`${baseUrl}/api/maintenance-request-photos/photo-1`, {
      method: "DELETE",
    });
    expect(res.status).toBe(403);
    expect(mockDeleteRequestPhoto).not.toHaveBeenCalled();
  });

  it("does not look the property up more than once for the whole list", async () => {
    // The house is resolved once per request, not once per row — a resident
    // with a long history must not trigger one property query per row.
    mockGetAllRequests.mockResolvedValue([
      alicesRequest,
      { ...alicesRequest, id: "req-2" },
      { ...alicesRequest, id: "req-3" },
    ]);
    actAsResident(BOB_ID, BOB_EMAIL, PROPERTY_A.id);

    const { status, body } = await getJson("/api/maintenance-requests");
    expect(status).toBe(200);
    expect((body as any[]).length).toBe(3);
    expect(mockGetProperty).toHaveBeenCalledTimes(1);
  });
});
