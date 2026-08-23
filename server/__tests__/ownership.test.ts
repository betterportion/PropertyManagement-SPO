/**
 * Route-level tests for the resident ownership gate.
 *
 * These tests exercise the actual Express route handlers in routes.ts with
 * mocked storage and auth, so a refactor that removes or inverts the
 * ownership check will cause these tests to fail.
 *
 * Two endpoints are covered:
 *   GET /api/maintenance-requests/:id          (routes.ts ~line 284)
 *   GET /api/maintenance-requests/:id/contacts (routes.ts ~line 437)
 *
 * The ownership check compares request.submittedBy against currentUser.email.
 * "submittedBy" stores the creator's email at request-creation time, NOT a
 * user ID.  A future refactor that changes the stored value to a user ID would
 * silently break the gate — these tests will catch that regression too, because
 * the mocked data uses realistic email values.
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
  activeUserId,
} = vi.hoisted(() => ({
  mockGetUser: vi.fn(),
  mockGetPermissions: vi.fn(),
  mockGetRequest: vi.fn(),
  mockGetContacts: vi.fn(),
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
    // Stubs for other storage methods routes.ts may reference
    getAllMaintenanceRequests: vi.fn().mockResolvedValue([]),
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

const ALICE_ID = "user-alice";
const ALICE_EMAIL = "alice@example.com";

const BOB_ID = "user-bob";
const BOB_EMAIL = "bob@example.com";

const STAFF_ID = "user-staff";
const STAFF_EMAIL = "staff@example.com";

const ADMIN_ID = "user-admin";
const ADMIN_EMAIL = "admin@example.com";

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
  status: "open",
};

// Reset mock implementations before each test so leakage between tests is
// impossible.
beforeEach(() => {
  mockGetUser.mockReset();
  mockGetPermissions.mockReset();
  mockGetRequest.mockReset();
  mockGetContacts.mockReset();

  // Default: the request exists
  mockGetRequest.mockResolvedValue(alicesRequest);
  // Default: contacts are empty
  mockGetContacts.mockResolvedValue([]);
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
  it("returns 403 when a resident requests another resident's maintenance request", async () => {
    // Bob (resident) tries to read Alice's request.
    activeUserId.value = BOB_ID;
    mockGetUser.mockResolvedValue({
      id: BOB_ID,
      email: BOB_EMAIL,
      role: "resident",
      isActive: true,
    });
    mockGetPermissions.mockResolvedValue(canViewPerms);

    const { status } = await getJson("/api/maintenance-requests/req-1");
    expect(status).toBe(403);
  });

  it("returns 200 when a resident requests their own maintenance request", async () => {
    // Alice (resident) reads her own request.
    activeUserId.value = ALICE_ID;
    mockGetUser.mockResolvedValue({
      id: ALICE_ID,
      email: ALICE_EMAIL,
      role: "resident",
      isActive: true,
    });
    mockGetPermissions.mockResolvedValue(canViewPerms);

    const { status, body } = await getJson("/api/maintenance-requests/req-1");
    expect(status).toBe(200);
    expect((body as any).id).toBe("req-1");
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

  it("still returns 403 after a user is demoted from staff to resident and tries another user's request", async () => {
    // Carol was regional_administrator; now she is resident. The ownership
    // check should use the current role, not the role at creation time.
    const CAROL_ID = "user-carol";
    const CAROL_EMAIL = "carol@example.com";

    activeUserId.value = CAROL_ID;
    mockGetUser.mockResolvedValue({
      id: CAROL_ID,
      email: CAROL_EMAIL,
      role: "resident", // demoted
      isActive: true,
    });
    mockGetPermissions.mockResolvedValue(canViewPerms);

    // alicesRequest.submittedBy is alice@example.com, not carol@example.com
    const { status } = await getJson("/api/maintenance-requests/req-1");
    expect(status).toBe(403);
  });

  it("returns 200 after a resident is promoted to admin and reads another user's request", async () => {
    // Alice was resident; now she is admin. Ownership check is bypassed.
    activeUserId.value = ALICE_ID;
    mockGetUser.mockResolvedValue({
      id: ALICE_ID,
      email: ALICE_EMAIL,
      role: "admin", // promoted
      isActive: true,
    });
    mockGetPermissions.mockResolvedValue({ ...canViewPerms, allowedRegions: ["all"] });

    // Use Bob's imaginary request whose submittedBy is bob@example.com
    mockGetRequest.mockResolvedValue({
      id: "req-2",
      submittedBy: BOB_EMAIL,
      region: "West Central",
      status: "open",
    });

    const { status } = await getJson("/api/maintenance-requests/req-2");
    expect(status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// GET /api/maintenance-requests/:id/contacts — ownership gate
// ---------------------------------------------------------------------------

describe("GET /api/maintenance-requests/:id/contacts — ownership gate", () => {
  it("returns 403 when a resident requests contacts on another resident's request", async () => {
    activeUserId.value = BOB_ID;
    mockGetUser.mockResolvedValue({
      id: BOB_ID,
      email: BOB_EMAIL,
      role: "resident",
      isActive: true,
    });
    mockGetPermissions.mockResolvedValue(canViewPerms);

    const { status } = await getJson(
      "/api/maintenance-requests/req-1/contacts"
    );
    expect(status).toBe(403);
  });

  it("does not fetch contacts from storage when resident is blocked", async () => {
    activeUserId.value = BOB_ID;
    mockGetUser.mockResolvedValue({
      id: BOB_ID,
      email: BOB_EMAIL,
      role: "resident",
      isActive: true,
    });
    mockGetPermissions.mockResolvedValue(canViewPerms);

    await getJson("/api/maintenance-requests/req-1/contacts");

    // Storage.getRequestContacts must never be called — the route should 403
    // before it ever loads contact details.
    expect(mockGetContacts).not.toHaveBeenCalled();
  });

  it("returns 200 when a resident requests contacts on their own request", async () => {
    activeUserId.value = ALICE_ID;
    mockGetUser.mockResolvedValue({
      id: ALICE_ID,
      email: ALICE_EMAIL,
      role: "resident",
      isActive: true,
    });
    mockGetPermissions.mockResolvedValue(canViewPerms);

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

  it("returns 403 after a user is demoted to resident and tries contacts on another user's request", async () => {
    const CAROL_ID = "user-carol";
    const CAROL_EMAIL = "carol@example.com";

    activeUserId.value = CAROL_ID;
    mockGetUser.mockResolvedValue({
      id: CAROL_ID,
      email: CAROL_EMAIL,
      role: "resident",
      isActive: true,
    });
    mockGetPermissions.mockResolvedValue(canViewPerms);

    const { status } = await getJson(
      "/api/maintenance-requests/req-1/contacts"
    );
    expect(status).toBe(403);
  });
});
