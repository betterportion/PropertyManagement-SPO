/**
 * End-to-end access-control tests over real HTTP.
 *
 * Unlike the other suites, this one does NOT stub the authentication guard.
 * The real `isAuthenticated` from server/auth.ts runs, the real authorization
 * helpers run, and the real route handlers run; only the database and the file
 * store are replaced. That is the point: a change that removes a guard from a
 * route, or reorders the checks so authorization happens after the work, fails
 * here.
 *
 * What is simulated is only the session itself — the object Passport would
 * have put on the request after a successful OIDC login. Everything downstream
 * of that is production code.
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import express from "express";
import { Readable } from "node:stream";
import type { Server } from "node:http";
import { getTableColumns } from "drizzle-orm";
import { userPermissions } from "@shared/schema";

// ---------------------------------------------------------------------------
// Doubles for everything that would otherwise need a database or a bucket
// ---------------------------------------------------------------------------

vi.mock("../db", () => ({ db: {}, pool: {} }));

/**
 * A storage stand-in that grows a fresh mock the first time each method is
 * asked for. Routes touch a wide spread of methods and this suite is about
 * access control, not about data access — spelling out every method would add
 * noise without adding a single assertion.
 */
const { storageMock, storageFns } = vi.hoisted(() => {
  const fns = new Map<string, ReturnType<typeof vi.fn>>();
  const proxy = new Proxy({} as Record<string, ReturnType<typeof vi.fn>>, {
    get(_target, property) {
      if (typeof property !== "string") return undefined;
      if (!fns.has(property)) fns.set(property, vi.fn());
      return fns.get(property);
    },
  });
  return { storageMock: proxy, storageFns: fns };
});

vi.mock("../storage", () => ({ storage: storageMock }));

const { fileStoreMock } = vi.hoisted(() => ({
  fileStoreMock: {
    putUpload: vi.fn(),
    uploadExists: vi.fn(),
    removeUpload: vi.fn(),
    openUploadStream: vi.fn(),
    createUploadSignedUrl: vi.fn(),
  },
}));

// Only the calls that reach a bucket are replaced. generateStorageKey,
// isSafeStorageKey and contentTypeFor stay real, because the path-traversal
// tests below are testing the real key check.
vi.mock("../objectStorage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../objectStorage")>();
  return { ...actual, ...fileStoreMock };
});

/**
 * Records every entry into the multipart parsing stage.
 *
 * Asserting that `putUpload` was not called only proves nothing was *stored*.
 * The requirement is stronger than that: a refused upload must be turned away
 * before the request body is read at all, so a rejected caller cannot push
 * megabytes through the server. This spy sits on the multer middleware itself,
 * which is the first thing that touches the body, so the tests below can prove
 * the guard runs ahead of it rather than behind it.
 */
const { multerEntered } = vi.hoisted(() => ({ multerEntered: vi.fn() }));

vi.mock("multer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("multer")>();
  const realMulter = actual.default;

  const instrumented = (options?: unknown) => {
    const instance = (realMulter as (o?: unknown) => any)(options);
    return new Proxy(instance, {
      get(target, property, receiver) {
        if (property === "single") {
          return (field: string) => {
            const middleware = target.single(field);
            return (req: any, res: any, next: any) => {
              multerEntered(req.path);
              return middleware(req, res, next);
            };
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
  };
  // Carries over memoryStorage, diskStorage and MulterError.
  Object.assign(instrumented, realMulter);

  return { ...actual, default: instrumented };
});

/**
 * The mail provider is replaced at the one seam every send goes through.
 * A route that emails somebody is asserted on WHO it addressed -- the list
 * of To lines -- never on whether a message left, because that is the
 * provider's business and email is deliberately optional.
 */
const { sendEmailMock } = vi.hoisted(() => ({ sendEmailMock: vi.fn() }));

vi.mock("../email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../email")>();
  return { ...actual, sendEmail: sendEmailMock };
});

/**
 * QuickBooks is replaced at the one seam everything reaches it through, so
 * these tests can say which calls to Intuit a refused request never made.
 */
const { qbApi } = vi.hoisted(() => ({
  qbApi: {
    authorizeUrl: vi.fn(),
    exchangeCode: vi.fn(),
    refresh: vi.fn(),
    revoke: vi.fn(),
    companyName: vi.fn(),
    listClasses: vi.fn(),
    listExpenseAccounts: vi.fn(),
    profitAndLossByClass: vi.fn(),
  },
}));

vi.mock("../quickbooks/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../quickbooks/api")>();
  return { ...actual, createQuickBooksApi: () => qbApi };
});

// The real isAuthenticated and getUserId are kept. Only setupAuth is replaced,
// because it performs OIDC discovery against a live identity provider.
vi.mock("../auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth")>();
  return { ...actual, setupAuth: vi.fn().mockResolvedValue(undefined) };
});

import { registerRoutes } from "../routes";
import { errorHandler } from "../errors";
import { DOCUMENT_UPLOAD_MAX_BYTES } from "../uploadLimits";
import { decryptToken, encryptToken } from "../quickbooks/crypto";

// ---------------------------------------------------------------------------
// The simulated session
// ---------------------------------------------------------------------------

interface SessionUser {
  claims?: { sub?: string };
  expires_at?: number;
  access_token?: string;
  refresh_token?: string;
}

/** Mutable box; tests set `.user` to choose who (if anyone) is signed in. */
const session: { user: SessionUser | null } = { user: null };

/** The rest of the session (what express-session would keep between requests). */
let sessionData: Record<string, unknown> = {};

const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;
const anHourAgo = () => Math.floor(Date.now() / 1000) - 3600;

/** A well-formed, unexpired session for the given user ID. */
function signIn(userId: string) {
  session.user = {
    claims: { sub: userId },
    expires_at: inAnHour(),
    access_token: "access-token",
    refresh_token: "refresh-token",
  };
}

// ---------------------------------------------------------------------------
// Accounts used across the tests
// ---------------------------------------------------------------------------

const ADMIN = { id: "u-admin", email: "admin@example.com", role: "admin", isActive: true };
const STAFF = { id: "u-staff", email: "staff@example.com", role: "regional_administrator", isActive: true };
const ALICE = { id: "u-alice", email: "alice@example.com", role: "resident", isActive: true };
const BOB = { id: "u-bob", email: "bob@example.com", role: "resident", isActive: true };
const DISABLED = { id: "u-gone", email: "gone@example.com", role: "regional_administrator", isActive: false };

const ALL_MAINTENANCE = { canViewMaintenance: true, canManageMaintenance: true };

/** Signs in as `user`, with the permissions row (if any) they hold. */
function actAs(
  user: { id: string; email: string; role: string; isActive: boolean },
  permissions?: Record<string, unknown>,
) {
  signIn(user.id);
  storageMock.getUser.mockResolvedValue(user);
  storageMock.getUserPermissions.mockResolvedValue(permissions);
}

// Every request a resident is expected to read says `type: "request"`
// outright. The type rule in canReadMaintenanceRequest fails closed on a
// missing type, so a fixture that stayed silent about it would be refused
// for the wrong reason and a negative test would pass vacuously.
const WEST_REQUEST = {
  id: "req-west",
  title: "Leaky tap",
  region: "West Central",
  submittedBy: ALICE.email,
  status: "pending",
  type: "request",
};

const EAST_REQUEST = {
  id: "req-east",
  title: "Broken window",
  region: "East Central",
  submittedBy: BOB.email,
  status: "pending",
  type: "request",
};

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());

  // Stands in for Passport: exposes exactly the two things the real
  // isAuthenticated reads off the request.
  app.use((req, _res, next) => {
    (req as unknown as { isAuthenticated: () => boolean }).isAuthenticated = () => session.user !== null;
    (req as unknown as { user?: SessionUser }).user = session.user ?? undefined;
    (req as unknown as { session: Record<string, unknown> }).session = sessionData;
    next();
  });

  server = await registerRoutes(app);
  app.use(errorHandler);

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(
  () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
);

beforeEach(() => {
  session.user = null;
  sessionData = {};
  for (const fn of storageFns.values()) fn.mockReset();
  for (const fn of Object.values(qbApi)) fn.mockReset();
  for (const fn of Object.values(fileStoreMock)) fn.mockReset();
  multerEntered.mockReset();

  // Defaults that keep handlers on their normal path; individual tests override.
  storageMock.getUserPermissions.mockResolvedValue(undefined);
  storageMock.getAllMaintenanceRequests.mockResolvedValue([WEST_REQUEST, EAST_REQUEST]);
  storageMock.getMaintenanceRequest.mockResolvedValue(undefined);
  storageMock.getRequestContacts.mockResolvedValue([]);
  storageMock.findUploadReferences.mockResolvedValue([]);
  storageMock.getUploadByStorageKey.mockResolvedValue(undefined);
  storageMock.createAuditEvent.mockResolvedValue({ id: "evt" });
  storageMock.updateMaintenanceRequest.mockImplementation(async (_id, patch) => ({ ...WEST_REQUEST, ...patch }));
  fileStoreMock.uploadExists.mockResolvedValue(true);
  fileStoreMock.createUploadSignedUrl.mockResolvedValue(null);
  fileStoreMock.openUploadStream.mockResolvedValue(Readable.from([Buffer.from("file-bytes")]));
  storageMock.getAllUsersWithPermissions.mockResolvedValue([]);
  // By default a signed-in resident is on their own house's roster, so the
  // house rule (isCurrentRosterMember) is what the older tests assumed; the
  // departed-resident tests replace this with an inactive or past row.
  storageMock.getResidentsByProperty.mockImplementation(async (propertyId: string) => {
    const user = await storageMock.getUser();
    return user?.role === "resident" && user.propertyId === propertyId
      ? [{ id: "roster-self", email: user.email, propertyId, isActive: true, moveOutDate: null }]
      : [];
  });
  storageMock.getAllRepairBudgets.mockResolvedValue([]);
  storageMock.getAllPropertySpend.mockResolvedValue([]);
  storageMock.getAllPropertyQuickbooksLinks.mockResolvedValue([]);
  storageMock.getRecentRosterSyncRuns.mockResolvedValue([]);
  storageMock.getLastSuccessfulRosterSyncRun.mockResolvedValue(undefined);
  storageMock.getRosterReviewItems.mockResolvedValue([]);
  storageMock.getEmailLogSince.mockResolvedValue([]);
  sendEmailMock.mockReset();
  sendEmailMock.mockResolvedValue({ sent: false, reason: "not_configured" });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function request(
  method: string,
  path: string,
  options: { body?: unknown; rawBody?: string; redirect?: RequestRedirect } = {},
) {
  const init: RequestInit = { method, redirect: options.redirect ?? "manual" };
  if (options.rawBody !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = options.rawBody;
  } else if (options.body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(options.body);
  }
  const res = await fetch(`${baseUrl}${path}`, init);
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body, headers: res.headers };
}

const get = (path: string, options?: Parameters<typeof request>[2]) => request("GET", path, options);

// ---------------------------------------------------------------------------
// 1. Nobody signed in
// ---------------------------------------------------------------------------

describe("requests with no session", () => {
  const protectedEndpoints: [string, string][] = [
    ["GET", "/api/auth/user"],
    ["GET", "/api/users"],
    ["GET", "/api/audit-log"],
    ["GET", "/api/maintenance-requests/req-west/comments"],
    ["POST", "/api/maintenance-requests/req-west/comments"],
    ["DELETE", "/api/maintenance-request-comments/c-1"],
    ["GET", "/api/maintenance-requests"],
    ["GET", "/api/maintenance-requests/req-west"],
    ["GET", "/api/maintenance-requests/req-west/contacts"],
    ["GET", "/api/maintenance-requests/req-west/bids"],
    ["POST", "/api/maintenance-requests/req-west/bids"],
    ["POST", "/api/maintenance-requests/req-west/bid-documents"],
    ["PATCH", "/api/maintenance-request-bids/bid-1"],
    ["DELETE", "/api/maintenance-request-bids/bid-1"],
    ["POST", "/api/maintenance-request-bids/bid-1/accept"],
    ["GET", "/api/walkthrough-rooms"],
    ["GET", "/api/assets"],
    ["GET", "/api/contacts"],
    ["GET", "/api/invoices"],
    ["GET", "/api/billing"],
    ["GET", "/api/properties"],
    ["POST", "/api/upload"],
    ["POST", "/api/upload-doc"],
    ["GET", "/uploads/0123456789abcdef0123456789abcdef.pdf"],
  ];

  it.each(protectedEndpoints)("refuses %s %s with 401", async (method, path) => {
    const { status } = await request(method, path);
    expect(status).toBe(401);
  });

  it("does not even look the user up, so authentication runs before authorization", async () => {
    await get("/api/maintenance-requests");
    expect(storageMock.getUser).not.toHaveBeenCalled();
  });

  it("does not touch the file store on an anonymous download attempt", async () => {
    await get("/uploads/0123456789abcdef0123456789abcdef.pdf");
    expect(fileStoreMock.openUploadStream).not.toHaveBeenCalled();
    expect(fileStoreMock.createUploadSignedUrl).not.toHaveBeenCalled();
  });
});

describe("requests with a broken or stale session", () => {
  it("refuses a session carrying no subject claim", async () => {
    session.user = { claims: {}, expires_at: inAnHour() };
    expect((await get("/api/maintenance-requests")).status).toBe(401);
  });

  it("refuses a session with no expiry", async () => {
    session.user = { claims: { sub: ADMIN.id } };
    expect((await get("/api/maintenance-requests")).status).toBe(401);
  });

  it("refuses an expired session that cannot be refreshed", async () => {
    session.user = { claims: { sub: ADMIN.id }, expires_at: anHourAgo() };
    expect((await get("/api/maintenance-requests")).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// 2. Accounts that no longer exist or have been switched off
// ---------------------------------------------------------------------------

describe("accounts that should no longer have access", () => {
  it("refuses a session whose user row has been deleted", async () => {
    signIn("u-deleted");
    storageMock.getUser.mockResolvedValue(undefined);
    expect((await get("/api/maintenance-requests")).status).toBe(403);
  });

  it("refuses a deactivated account even though its cookie is still valid", async () => {
    // Deactivation cannot reach into an issued cookie, so this check on the
    // next request is what actually revokes access.
    actAs(DISABLED, ALL_MAINTENANCE);
    expect((await get("/api/maintenance-requests")).status).toBe(403);
  });

  it("refuses a deactivated account a file download", async () => {
    actAs(DISABLED, ALL_MAINTENANCE);
    const { status } = await get("/uploads/0123456789abcdef0123456789abcdef.pdf");
    expect(status).toBe(403);
    expect(fileStoreMock.openUploadStream).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. The admin bypass
// ---------------------------------------------------------------------------

describe("an administrator with no permissions row", () => {
  it("can still list maintenance requests", async () => {
    // The row is genuinely absent, not merely empty — this is the state an
    // admin created outside the settings screen ends up in.
    actAs(ADMIN, undefined);
    const { status, body } = await get("/api/maintenance-requests");
    expect(status).toBe(200);
    expect(body).toHaveLength(2);
  });

  it("can read a request in any region", async () => {
    actAs(ADMIN, undefined);
    storageMock.getMaintenanceRequest.mockResolvedValue(EAST_REQUEST);
    expect((await get("/api/maintenance-requests/req-east")).status).toBe(200);
  });

  it("can update a request in any region", async () => {
    actAs(ADMIN, undefined);
    storageMock.getMaintenanceRequest.mockResolvedValue(EAST_REQUEST);
    const { status } = await request("PATCH", "/api/maintenance-requests/req-east", {
      body: { status: "completed" },
    });
    expect(status).toBe(200);
  });

  it("is not locked out when every flag on their row is false", async () => {
    actAs(ADMIN, { canViewMaintenance: false, canManageMaintenance: false, allowedRegions: [] });
    expect((await get("/api/maintenance-requests")).status).toBe(200);
  });

  it("reads their own missing row as null, not a 404 every staff page logs", async () => {
    actAs(ADMIN, undefined);
    const { status, body } = await get(`/api/users/${ADMIN.id}/permissions`);
    expect(status).toBe(200);
    expect(body).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. Regional scoping
// ---------------------------------------------------------------------------

describe("a regional administrator", () => {
  const westOnly = { ...ALL_MAINTENANCE, allowedRegions: ["West Central"] };

  it("reads a request in a region they are assigned", async () => {
    actAs(STAFF, westOnly);
    storageMock.getMaintenanceRequest.mockResolvedValue(WEST_REQUEST);
    expect((await get("/api/maintenance-requests/req-west")).status).toBe(200);
  });

  it("is refused a request in a region they are not assigned", async () => {
    actAs(STAFF, westOnly);
    storageMock.getMaintenanceRequest.mockResolvedValue(EAST_REQUEST);
    expect((await get("/api/maintenance-requests/req-east")).status).toBe(403);
  });

  it("sees only their own regions in a list", async () => {
    actAs(STAFF, westOnly);
    const { body } = await get("/api/maintenance-requests");
    expect(body.map((r: { id: string }) => r.id)).toEqual(["req-west"]);
  });

  it("is still scoped when their assignment is stored in the legacy format", async () => {
    actAs(STAFF, { ...ALL_MAINTENANCE, allowedRegions: ["west-central"] });
    const { body } = await get("/api/maintenance-requests");
    expect(body.map((r: { id: string }) => r.id)).toEqual(["req-west"]);
  });
});

describe("a staff account assigned no regions at all", () => {
  const noRegions = { ...ALL_MAINTENANCE, allowedRegions: [] };

  it("receives an empty list, not the full one", async () => {
    // The failure mode worth guarding: reading "no regions" as "no filter".
    actAs(STAFF, noRegions);
    const { status, body } = await get("/api/maintenance-requests");
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it("is refused every individual record", async () => {
    actAs(STAFF, noRegions);
    storageMock.getMaintenanceRequest.mockResolvedValue(WEST_REQUEST);
    expect((await get("/api/maintenance-requests/req-west")).status).toBe(403);
  });
});

describe("moving a record between regions", () => {
  const westOnly = { ...ALL_MAINTENANCE, allowedRegions: ["West Central"] };

  it("refuses a move into a region the user cannot reach", async () => {
    actAs(STAFF, westOnly);
    storageMock.getMaintenanceRequest.mockResolvedValue(WEST_REQUEST);

    const { status, body } = await request("PATCH", "/api/maintenance-requests/req-west", {
      body: { region: "East Central" },
    });

    expect(status).toBe(403);
    expect(body.message).toMatch(/cannot move/i);
  });

  it("does not write anything when the move is refused", async () => {
    actAs(STAFF, westOnly);
    storageMock.getMaintenanceRequest.mockResolvedValue(WEST_REQUEST);

    await request("PATCH", "/api/maintenance-requests/req-west", { body: { region: "East Central" } });

    expect(storageMock.updateMaintenanceRequest).not.toHaveBeenCalled();
  });

  it("refuses editing a record that already sits outside their regions", async () => {
    actAs(STAFF, westOnly);
    storageMock.getMaintenanceRequest.mockResolvedValue(EAST_REQUEST);

    const { status } = await request("PATCH", "/api/maintenance-requests/req-east", {
      body: { status: "completed" },
    });

    expect(status).toBe(403);
    expect(storageMock.updateMaintenanceRequest).not.toHaveBeenCalled();
  });

  it("allows a move between two regions the user can reach", async () => {
    actAs(STAFF, { ...ALL_MAINTENANCE, allowedRegions: ["West Central", "North West"] });
    storageMock.getMaintenanceRequest.mockResolvedValue(WEST_REQUEST);

    const { status } = await request("PATCH", "/api/maintenance-requests/req-west", {
      body: { region: "North West" },
    });

    expect(status).toBe(200);
    expect(storageMock.updateMaintenanceRequest).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 5. Child resources reached by guessing an ID
// ---------------------------------------------------------------------------

describe("maintenance child resources reached by guessing an ID", () => {
  const westOnly = { ...ALL_MAINTENANCE, allowedRegions: ["West Central"] };

  it("refuses the contacts of a request outside the caller's regions", async () => {
    actAs(STAFF, westOnly);
    storageMock.getMaintenanceRequest.mockResolvedValue(EAST_REQUEST);
    expect((await get("/api/maintenance-requests/req-east/contacts")).status).toBe(403);
  });

  it("does not load the contacts before deciding", async () => {
    // Vendor names, phone numbers and addresses must not be fetched at all for
    // a caller who is about to be refused.
    actAs(STAFF, westOnly);
    storageMock.getMaintenanceRequest.mockResolvedValue(EAST_REQUEST);
    await get("/api/maintenance-requests/req-east/contacts");
    expect(storageMock.getRequestContacts).not.toHaveBeenCalled();
  });

  it("refuses linking a contact from another region onto a reachable request", async () => {
    // Both sides are checked: linking an out-of-region contact would expose its
    // details to everyone who can read the request.
    actAs(STAFF, westOnly);
    storageMock.getMaintenanceRequest.mockResolvedValue(WEST_REQUEST);
    storageMock.getMaintenanceContact.mockResolvedValue({ id: "c-1", region: "East Central" });

    const { status } = await request("POST", "/api/maintenance-requests/req-west/contacts/c-1");

    expect(status).toBe(403);
    expect(storageMock.linkContactToRequest).not.toHaveBeenCalled();
  });

  it("refuses unlinking a contact through a request outside the caller's regions", async () => {
    actAs(STAFF, westOnly);
    storageMock.getMaintenanceRequest.mockResolvedValue(EAST_REQUEST);
    storageMock.getMaintenanceContact.mockResolvedValue({ id: "c-1", region: "East Central" });

    const { status } = await request("DELETE", "/api/maintenance-requests/req-east/contacts/c-1");

    expect(status).toBe(403);
    expect(storageMock.unlinkContactFromRequest).not.toHaveBeenCalled();
  });

  it("refuses a resident the contacts on someone else's request", async () => {
    actAs(BOB, ALL_MAINTENANCE);
    storageMock.getMaintenanceRequest.mockResolvedValue(WEST_REQUEST); // Alice's
    const { status } = await get("/api/maintenance-requests/req-west/contacts");
    expect(status).toBe(403);
    expect(storageMock.getRequestContacts).not.toHaveBeenCalled();
  });

  it("refuses a resident any linking at all, since it is a staff action", async () => {
    actAs(ALICE, ALL_MAINTENANCE);
    storageMock.getMaintenanceRequest.mockResolvedValue(WEST_REQUEST); // her own
    const { status } = await request("POST", "/api/maintenance-requests/req-west/contacts/c-1");
    expect(status).toBe(403);
    expect(storageMock.linkContactToRequest).not.toHaveBeenCalled();
  });
});

describe("one resident reading another resident's request", () => {
  it("is refused", async () => {
    actAs(BOB, ALL_MAINTENANCE);
    storageMock.getMaintenanceRequest.mockResolvedValue(WEST_REQUEST); // Alice's
    expect((await get("/api/maintenance-requests/req-west")).status).toBe(403);
  });

  it("is refused even when the resident holds manage permissions", async () => {
    actAs(BOB, { canViewMaintenance: true, canManageMaintenance: true, allowedRegions: ["all"] });
    storageMock.getMaintenanceRequest.mockResolvedValue(WEST_REQUEST);
    expect((await get("/api/maintenance-requests/req-west")).status).toBe(403);
  });

  it("still lets them read their own", async () => {
    actAs(BOB, ALL_MAINTENANCE);
    storageMock.getMaintenanceRequest.mockResolvedValue(EAST_REQUEST); // Bob's
    expect((await get("/api/maintenance-requests/req-east")).status).toBe(200);
  });

  it("filters the list down to their own requests", async () => {
    actAs(ALICE, ALL_MAINTENANCE);
    const { body } = await get("/api/maintenance-requests");
    expect(body.map((r: { id: string }) => r.id)).toEqual(["req-west"]);
  });
});

/**
 * The request page's data route, opened by a household leader.
 *
 * The page at /maintenance/:id decides nothing about access: it fetches this
 * route and shows whatever comes back, so the house rule and the 120-day
 * window in canReadMaintenanceRequest are the only thing between a leader and
 * a housemate's history. These cases pin that rule where the page reads it.
 */
describe("a household leader opening a request from its page", () => {
  const HOUSE_A = "1 Main St";
  const HOUSE_B = "2 River Rd";
  const PROPERTY_A = { id: "prop-a", name: "Cleveland House", region: "West Central", address: HOUSE_A };

  const DAY_MS = 24 * 60 * 60 * 1000;
  const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString();

  /** A housemate's open request on the leader's own house. */
  const OWN_HOUSE_OPEN = {
    id: "req-own-open",
    title: "Blinds fell down",
    region: "West Central",
    buildingAddress: HOUSE_A,
    submittedBy: BOB.email,
    status: "pending",
    type: "request",
  };
  /** Another house's open request, in the same region as the leader's. */
  const OTHER_HOUSE_OPEN = { ...OWN_HOUSE_OPEN, id: "req-other-open", buildingAddress: HOUSE_B };
  /** A housemate's request on the leader's house, closed well outside the window. */
  const OWN_HOUSE_LONG_CLOSED = {
    ...OWN_HOUSE_OPEN,
    id: "req-own-old",
    status: "completed",
    completedDate: daysAgo(121),
  };
  /** The same, but closed inside the window: the positive control for the date rule. */
  const OWN_HOUSE_RECENTLY_CLOSED = {
    ...OWN_HOUSE_LONG_CLOSED,
    id: "req-own-recent",
    completedDate: daysAgo(119),
  };

  /** Alice leads house A: a resident login linked to that property. */
  const leaderOfHouseA = () => {
    actAs({ ...ALICE, propertyId: "prop-a" } as typeof ALICE, ALL_MAINTENANCE);
    storageMock.getProperty.mockResolvedValue(PROPERTY_A);
  };

  it("opens their own house's open request", async () => {
    leaderOfHouseA();
    storageMock.getMaintenanceRequest.mockResolvedValue(OWN_HOUSE_OPEN);
    const { status, body } = await get("/api/maintenance-requests/req-own-open");
    expect(status).toBe(200);
    expect(body.id).toBe("req-own-open");
  });

  it("refuses their old house's request once their roster row there is past its stop date", async () => {
    leaderOfHouseA();
    storageMock.getResidentsByProperty.mockResolvedValue([
      { id: "r-alice", email: ALICE.email, propertyId: "prop-a", isActive: true, moveOutDate: new Date("2020-01-01T00:00:00Z") },
    ]);
    storageMock.getMaintenanceRequest.mockResolvedValue(OWN_HOUSE_OPEN);
    const { status, body } = await get("/api/maintenance-requests/req-own-open");
    expect(status).toBe(403);
    expect(body).not.toHaveProperty("title");
  });

  it("refuses another house's request, and never sends its contents", async () => {
    leaderOfHouseA();
    storageMock.getMaintenanceRequest.mockResolvedValue(OTHER_HOUSE_OPEN);
    const { status, body } = await get("/api/maintenance-requests/req-other-open");
    expect(status).toBe(403);
    expect(body).not.toHaveProperty("title");
  });

  it("refuses their own house's request once it has been closed for more than 120 days", async () => {
    leaderOfHouseA();
    storageMock.getMaintenanceRequest.mockResolvedValue(OWN_HOUSE_LONG_CLOSED);
    const { status, body } = await get("/api/maintenance-requests/req-own-old");
    expect(status).toBe(403);
    expect(body).not.toHaveProperty("title");
  });

  // Positive control for the date rule: without it, the refusal above would
  // also pass if every closed request were refused outright.
  it("still opens their own house's request closed inside the window", async () => {
    leaderOfHouseA();
    storageMock.getMaintenanceRequest.mockResolvedValue(OWN_HOUSE_RECENTLY_CLOSED);
    const { status, body } = await get("/api/maintenance-requests/req-own-recent");
    expect(status).toBe(200);
    expect(body.id).toBe("req-own-recent");
  });

  // The page also fetches the contractors on the request, through the same
  // rule. Refusal there must happen before the vendor details are loaded.
  it("is refused the contractors on another house's request before they are loaded", async () => {
    leaderOfHouseA();
    storageMock.getMaintenanceRequest.mockResolvedValue(OTHER_HOUSE_OPEN);
    expect((await get("/api/maintenance-requests/req-other-open/contacts")).status).toBe(403);
    expect(storageMock.getRequestContacts).not.toHaveBeenCalled();
  });

  it("reads the contractors on their own house's request", async () => {
    leaderOfHouseA();
    storageMock.getMaintenanceRequest.mockResolvedValue(OWN_HOUSE_OPEN);
    storageMock.getRequestContacts.mockResolvedValue([{ id: "c-1", name: "Dave", company: "Dave's Plumbing" }]);
    const { status, body } = await get("/api/maintenance-requests/req-own-open/contacts");
    expect(status).toBe(200);
    expect(storageMock.getRequestContacts).toHaveBeenCalledWith("req-own-open");
    expect(body.map((c: { id: string }) => c.id)).toEqual(["c-1"]);
  });

  // The page's other data route, /api/maintenance-request-photos, applies the
  // same rule from the opposite direction: it fetches every photo on every
  // request and filters per-photo by canReadMaintenanceRequest, so the house
  // match has to hold there too or a leader would see a housemate's photos
  // through the list even though the detail route above refuses the request
  // itself.
  it("shows a leader photos on their own house's request but not another house's", async () => {
    leaderOfHouseA();
    storageMock.getAllMaintenanceRequests.mockResolvedValue([OWN_HOUSE_OPEN, OTHER_HOUSE_OPEN]);
    storageMock.getAllMaintenanceRequestPhotos.mockResolvedValue([
      { id: "ph-own", requestId: OWN_HOUSE_OPEN.id, imageUrl: "/uploads/own.png" },
      { id: "ph-other", requestId: OTHER_HOUSE_OPEN.id, imageUrl: "/uploads/other.png" },
    ]);
    const { status, body } = await get("/api/maintenance-request-photos");
    expect(status).toBe(200);
    expect(body.map((p: { id: string }) => p.id)).toEqual(["ph-own"]);
  });

  // The 120-day window applies on this route too, not just on the detail
  // route: the photo list has no window logic of its own, so this is really
  // proving canReadMaintenanceRequest is the one thing both routes share.
  it("hides photos on their own house's request once it has been closed for more than 120 days", async () => {
    leaderOfHouseA();
    storageMock.getAllMaintenanceRequests.mockResolvedValue([OWN_HOUSE_LONG_CLOSED, OWN_HOUSE_RECENTLY_CLOSED]);
    storageMock.getAllMaintenanceRequestPhotos.mockResolvedValue([
      { id: "ph-old", requestId: OWN_HOUSE_LONG_CLOSED.id, imageUrl: "/uploads/old.png" },
      { id: "ph-recent", requestId: OWN_HOUSE_RECENTLY_CLOSED.id, imageUrl: "/uploads/recent.png" },
    ]);
    const { status, body } = await get("/api/maintenance-request-photos");
    expect(status).toBe(200);
    expect(body.map((p: { id: string }) => p.id)).toEqual(["ph-recent"]);
  });
});

// ---------------------------------------------------------------------------
// Request threads
// ---------------------------------------------------------------------------

describe("the thread on a request", () => {
  const HOUSE_A = "1 Main St";
  const HOUSE_B = "2 River Rd";
  const PROPERTY_A = { id: "prop-a", name: "Cleveland House", region: "West Central", address: HOUSE_A };
  const westOnly = { ...ALL_MAINTENANCE, allowedRegions: ["West Central"] };

  const OWN_HOUSE_OPEN = {
    id: "req-own-open",
    title: "Blinds fell down",
    region: "West Central",
    buildingAddress: HOUSE_A,
    submittedBy: BOB.email,
    status: "pending",
    type: "request",
  };
  const OTHER_HOUSE_OPEN = { ...OWN_HOUSE_OPEN, id: "req-other-open", buildingAddress: HOUSE_B };
  const EAST_OPEN = { ...OWN_HOUSE_OPEN, id: "req-east-open", region: "East Central" };

  const INTERNAL_COMMENT = {
    id: "c-internal",
    requestId: OWN_HOUSE_OPEN.id,
    body: "He quoted $4,200 for the lot.",
    isInternal: true,
    authorUserId: STAFF.id,
  };
  const SHARED_COMMENT = {
    id: "c-shared",
    requestId: OWN_HOUSE_OPEN.id,
    body: "Plumber is coming Thursday at 9.",
    isInternal: false,
    authorUserId: STAFF.id,
  };

  const leaderOfHouseA = () => {
    actAs({ ...ALICE, propertyId: "prop-a" } as typeof ALICE, ALL_MAINTENANCE);
    storageMock.getProperty.mockResolvedValue(PROPERTY_A);
  };

  const post = (path: string, body: unknown) => request("POST", path, { body });
  const del = (path: string) => request("DELETE", path);

  // -- reading ----------------------------------------------------------------

  it("sends a household leader only the shared comments on their own house's request", async () => {
    leaderOfHouseA();
    storageMock.getMaintenanceRequest.mockResolvedValue(OWN_HOUSE_OPEN);
    storageMock.getMaintenanceRequestComments.mockResolvedValue([INTERNAL_COMMENT, SHARED_COMMENT]);
    const { status, body } = await get("/api/maintenance-requests/req-own-open/comments");
    expect(status).toBe(200);
    expect(body.map((c: { id: string }) => c.id)).toEqual(["c-shared"]);
    expect(JSON.stringify(body)).not.toContain("$4,200");
  });

  it("refuses a household leader another house's thread before the comments are loaded", async () => {
    leaderOfHouseA();
    storageMock.getMaintenanceRequest.mockResolvedValue(OTHER_HOUSE_OPEN);
    expect((await get("/api/maintenance-requests/req-other-open/comments")).status).toBe(403);
    expect(storageMock.getMaintenanceRequestComments).not.toHaveBeenCalled();
  });

  // Positive control for the filter: staff get both halves of the same thread.
  it("sends staff both kinds on a request in their region", async () => {
    actAs(STAFF, westOnly);
    storageMock.getMaintenanceRequest.mockResolvedValue(OWN_HOUSE_OPEN);
    storageMock.getMaintenanceRequestComments.mockResolvedValue([INTERNAL_COMMENT, SHARED_COMMENT]);
    const { status, body } = await get("/api/maintenance-requests/req-own-open/comments");
    expect(status).toBe(200);
    expect(body.map((c: { id: string }) => c.id)).toEqual(["c-internal", "c-shared"]);
  });

  it("refuses staff a thread outside their regions", async () => {
    actAs(STAFF, westOnly);
    storageMock.getMaintenanceRequest.mockResolvedValue(EAST_OPEN);
    expect((await get("/api/maintenance-requests/req-east-open/comments")).status).toBe(403);
    expect(storageMock.getMaintenanceRequestComments).not.toHaveBeenCalled();
  });

  // -- posting ----------------------------------------------------------------

  it("posts a staff comment as internal unless told otherwise, with the author from the session", async () => {
    actAs({ ...STAFF, firstName: "Sarah", lastName: "Lee" } as typeof STAFF, westOnly);
    storageMock.getMaintenanceRequest.mockResolvedValue(OWN_HOUSE_OPEN);
    storageMock.createMaintenanceRequestComment.mockImplementation(async (c: unknown) => ({ id: "c-new", ...(c as object) }));
    const { status, body } = await post("/api/maintenance-requests/req-own-open/comments", {
      body: "He quoted $4,200 for the lot.",
      // A client claiming to be somebody else is ignored, not honoured.
      authorUserId: ADMIN.id,
      authorEmail: ADMIN.email,
    });
    expect(status).toBe(201);
    expect(storageMock.createMaintenanceRequestComment).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "req-own-open",
        isInternal: true,
        authorUserId: STAFF.id,
        authorEmail: STAFF.email,
        authorName: "Sarah Lee",
      }),
    );
    expect(body.id).toBe("c-new");
  });

  it("posts a shared, relayed comment when asked to", async () => {
    actAs(STAFF, westOnly);
    storageMock.getMaintenanceRequest.mockResolvedValue(OWN_HOUSE_OPEN);
    storageMock.createMaintenanceRequestComment.mockImplementation(async (c: unknown) => ({ id: "c-new", ...(c as object) }));
    // The relayed contractor is on file, in the caller's region.
    storageMock.getMaintenanceContact.mockResolvedValue({ id: "contact-dave", name: "Dave", region: "West Central" });
    const { status } = await post("/api/maintenance-requests/req-own-open/comments", {
      body: "Coming Thursday at 9.",
      isInternal: false,
      relaySource: "Dave (handyman)",
      relayContactId: "contact-dave",
    });
    expect(status).toBe(201);
    expect(storageMock.createMaintenanceRequestComment).toHaveBeenCalledWith(
      expect.objectContaining({ isInternal: false, relaySource: "Dave (handyman)", relayContactId: "contact-dave" }),
    );
  });

  // A comment is neither access, money nor a document. Logging every one
  // would bury the events the audit log exists for.
  it("records no audit event for a comment", async () => {
    actAs(STAFF, westOnly);
    storageMock.getMaintenanceRequest.mockResolvedValue(OWN_HOUSE_OPEN);
    storageMock.createMaintenanceRequestComment.mockResolvedValue({ id: "c-new" });
    expect((await post("/api/maintenance-requests/req-own-open/comments", { body: "Noted." })).status).toBe(201);
    expect(storageMock.createAuditEvent).not.toHaveBeenCalled();
  });

  // -- a household posting (#120) ---------------------------------------------
  //
  // A new write path for a resident account, which is the shape of both
  // historic authorization gaps here. The rule is the read rule plus
  // "shared only" and nothing more, so every refusal below pairs with the
  // refused write never reaching storage.

  it("posts a household leader's comment on their own house's open request as shared, with the author from the session", async () => {
    leaderOfHouseA();
    storageMock.getMaintenanceRequest.mockResolvedValue(OWN_HOUSE_OPEN);
    storageMock.createMaintenanceRequestComment.mockImplementation(async (c: unknown) => ({ id: "c-new", ...(c as object) }));
    const { status, body } = await post("/api/maintenance-requests/req-own-open/comments", {
      body: "Still leaking, worse than last week.",
      isInternal: false,
      authorUserId: STAFF.id,
    });
    expect(status).toBe(201);
    expect(storageMock.createMaintenanceRequestComment).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "req-own-open",
        isInternal: false,
        authorUserId: ALICE.id,
        authorEmail: ALICE.email,
      }),
    );
    expect(body.id).toBe("c-new");
  });

  // The household composer has no visibility control, so a body marked
  // internal from that tier is a client mistake, not a grant: it is stored
  // shared, never refused and never stored internal.
  it("stores a household leader's comment as shared even when the body says internal", async () => {
    leaderOfHouseA();
    storageMock.getMaintenanceRequest.mockResolvedValue(OWN_HOUSE_OPEN);
    storageMock.createMaintenanceRequestComment.mockImplementation(async (c: unknown) => ({ id: "c-new", ...(c as object) }));
    const { status } = await post("/api/maintenance-requests/req-own-open/comments", { body: "Still leaking.", isInternal: true });
    expect(status).toBe(201);
    expect(storageMock.createMaintenanceRequestComment).toHaveBeenCalledTimes(1);
    expect(storageMock.createMaintenanceRequestComment).toHaveBeenCalledWith(expect.objectContaining({ isInternal: false }));
  });

  it("refuses a household leader posting on another house's request, and writes nothing", async () => {
    leaderOfHouseA();
    storageMock.getMaintenanceRequest.mockResolvedValue(OTHER_HOUSE_OPEN);
    const { status } = await post("/api/maintenance-requests/req-other-open/comments", { body: "Still leaking.", isInternal: false });
    expect(status).toBe(403);
    expect(storageMock.createMaintenanceRequestComment).not.toHaveBeenCalled();
  });

  // The unlinked-ownership path, through the route rather than only the
  // unit: an account with no house link at all, recorded as the request's
  // own submitter on a house that is not theirs. Ownership carries the
  // post exactly as it carries the read, and the "always shared" rule for
  // this tier still applies on top of it.
  it("posts an unlinked resident's own submission on another house as shared, even when the body says internal", async () => {
    const EVE = { id: "u-eve", email: "eve@example.com", role: "resident", isActive: true };
    actAs(EVE);
    storageMock.getMaintenanceRequest.mockResolvedValue({ ...OTHER_HOUSE_OPEN, submittedBy: EVE.email });
    storageMock.createMaintenanceRequestComment.mockImplementation(async (c: unknown) => ({ id: "c-new", ...(c as object) }));
    const { status } = await post("/api/maintenance-requests/req-other-open/comments", { body: "My own report.", isInternal: true });
    expect(status).toBe(201);
    expect(storageMock.createMaintenanceRequestComment).toHaveBeenCalledWith(
      expect.objectContaining({ isInternal: false, authorUserId: EVE.id }),
    );
  });

  // The positive control's mirror: the same unlinked account gets nothing on
  // a house's request it neither lives at nor filed.
  it("refuses that same unlinked resident a house's request it did not submit, and writes nothing", async () => {
    const EVE = { id: "u-eve", email: "eve@example.com", role: "resident", isActive: true };
    actAs(EVE);
    storageMock.getMaintenanceRequest.mockResolvedValue(OTHER_HOUSE_OPEN);
    const { status } = await post("/api/maintenance-requests/req-other-open/comments", { body: "Not mine." });
    expect(status).toBe(403);
    expect(storageMock.createMaintenanceRequestComment).not.toHaveBeenCalled();
  });

  it("refuses a household leader posting on their own house's request closed more than 120 days ago, and writes nothing", async () => {
    const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);
    leaderOfHouseA();
    storageMock.getMaintenanceRequest.mockResolvedValue({ ...OWN_HOUSE_OPEN, status: "completed", completedDate: daysAgo(121) });
    const { status } = await post("/api/maintenance-requests/req-own-open/comments", { body: "Still leaking.", isInternal: false });
    expect(status).toBe(403);
    expect(storageMock.createMaintenanceRequestComment).not.toHaveBeenCalled();

    // Positive control for the window: closed inside it, the same post lands.
    storageMock.getMaintenanceRequest.mockResolvedValue({ ...OWN_HOUSE_OPEN, status: "completed", completedDate: daysAgo(119) });
    storageMock.createMaintenanceRequestComment.mockResolvedValue({ id: "c-new" });
    expect((await post("/api/maintenance-requests/req-own-open/comments", { body: "Still leaking.", isInternal: false })).status).toBe(201);
    expect(storageMock.createMaintenanceRequestComment).toHaveBeenCalledTimes(1);
  });

  // The repairs-only type rule reaches posting through the read rule: a
  // capital project on the household's own house is not theirs to comment on.
  it("refuses a household leader posting on a capital project on their own house, and writes nothing", async () => {
    leaderOfHouseA();
    storageMock.getMaintenanceRequest.mockResolvedValue({ ...OWN_HOUSE_OPEN, type: "capex" });
    const { status } = await post("/api/maintenance-requests/req-own-open/comments", { body: "When does this start?", isInternal: false });
    expect(status).toBe(403);
    expect(storageMock.createMaintenanceRequestComment).not.toHaveBeenCalled();
  });

  // Both non-repair types, not only capex: a household may not read a
  // project on its own house, so it may not post on one either.
  it("refuses a household leader posting on an ordinary project on their own house, and writes nothing", async () => {
    leaderOfHouseA();
    storageMock.getMaintenanceRequest.mockResolvedValue({ ...OWN_HOUSE_OPEN, type: "project" });
    const { status } = await post("/api/maintenance-requests/req-own-open/comments", { body: "When does this start?", isInternal: false });
    expect(status).toBe(403);
    expect(storageMock.createMaintenanceRequestComment).not.toHaveBeenCalled();
  });

  it("refuses staff posting on a request outside their regions, and writes nothing", async () => {
    actAs(STAFF, westOnly);
    storageMock.getMaintenanceRequest.mockResolvedValue(EAST_OPEN);
    const { status } = await post("/api/maintenance-requests/req-east-open/comments", { body: "Noted." });
    expect(status).toBe(403);
    expect(storageMock.createMaintenanceRequestComment).not.toHaveBeenCalled();
  });

  it("refuses a body over 4,000 characters as a 400, and writes nothing", async () => {
    actAs(STAFF, westOnly);
    storageMock.getMaintenanceRequest.mockResolvedValue(OWN_HOUSE_OPEN);
    const { status, body } = await post("/api/maintenance-requests/req-own-open/comments", { body: "x".repeat(4001) });
    expect(status).toBe(400);
    expect(body.message).toContain("4,000");
    expect(storageMock.createMaintenanceRequestComment).not.toHaveBeenCalled();
  });

  // Positive control for the cap: exactly 4,000 is written.
  it("accepts a body of exactly 4,000 characters", async () => {
    actAs(STAFF, westOnly);
    storageMock.getMaintenanceRequest.mockResolvedValue(OWN_HOUSE_OPEN);
    storageMock.createMaintenanceRequestComment.mockResolvedValue({ id: "c-new" });
    expect((await post("/api/maintenance-requests/req-own-open/comments", { body: "x".repeat(4000) })).status).toBe(201);
    expect(storageMock.createMaintenanceRequestComment).toHaveBeenCalled();
  });

  it("refuses an empty body", async () => {
    actAs(STAFF, westOnly);
    storageMock.getMaintenanceRequest.mockResolvedValue(OWN_HOUSE_OPEN);
    expect((await post("/api/maintenance-requests/req-own-open/comments", { body: "   " })).status).toBe(400);
    expect(storageMock.createMaintenanceRequestComment).not.toHaveBeenCalled();
  });

  // The 4,000-character cap is validated before any role branch, but a
  // household leader is the tier the plan calls out by name -- prove it
  // holds for that tier too, not only for staff.
  it("refuses a household leader's body over 4,000 characters as a 400, and writes nothing", async () => {
    leaderOfHouseA();
    storageMock.getMaintenanceRequest.mockResolvedValue(OWN_HOUSE_OPEN);
    const { status, body } = await post("/api/maintenance-requests/req-own-open/comments", { body: "x".repeat(4001), isInternal: false });
    expect(status).toBe(400);
    expect(body.message).toContain("4,000");
    expect(storageMock.createMaintenanceRequestComment).not.toHaveBeenCalled();
  });

  // -- deleting ---------------------------------------------------------------

  it("stores a resident's comment as their own words, whatever relay fields the body carries", async () => {
    leaderOfHouseA();
    storageMock.getMaintenanceRequest.mockResolvedValue(OWN_HOUSE_OPEN);
    storageMock.createMaintenanceRequestComment.mockImplementation(async (c: unknown) => ({ id: "c-new", ...(c as object) }));
    const { status } = await post("/api/maintenance-requests/req-own-open/comments", {
      body: "Dave said Thursday.",
      relaySource: "Dave (handyman)",
      relayContactId: "contact-dave",
    });
    expect(status).toBe(201);
    expect(storageMock.createMaintenanceRequestComment).toHaveBeenCalledWith(
      expect.objectContaining({ relaySource: null, relayContactId: null, authorUserId: ALICE.id }),
    );
  });

  it("lets the author delete their own comment", async () => {
    actAs(STAFF, westOnly);
    storageMock.getMaintenanceRequestComment.mockResolvedValue(INTERNAL_COMMENT);
    storageMock.getMaintenanceRequest.mockResolvedValue(OWN_HOUSE_OPEN);
    expect((await del("/api/maintenance-request-comments/c-internal")).status).toBe(200);
    expect(storageMock.deleteMaintenanceRequestComment).toHaveBeenCalledWith("c-internal");
  });

  it("refuses staff deleting somebody else's comment, and deletes nothing", async () => {
    actAs({ ...STAFF, id: "u-other-staff", email: "other@example.com" }, westOnly);
    storageMock.getMaintenanceRequestComment.mockResolvedValue(INTERNAL_COMMENT);
    storageMock.getMaintenanceRequest.mockResolvedValue(OWN_HOUSE_OPEN);
    expect((await del("/api/maintenance-request-comments/c-internal")).status).toBe(403);
    expect(storageMock.deleteMaintenanceRequestComment).not.toHaveBeenCalled();
  });

  it("lets an admin delete anybody's comment", async () => {
    actAs(ADMIN);
    storageMock.getMaintenanceRequestComment.mockResolvedValue(INTERNAL_COMMENT);
    storageMock.getMaintenanceRequest.mockResolvedValue(OWN_HOUSE_OPEN);
    expect((await del("/api/maintenance-request-comments/c-internal")).status).toBe(200);
    expect(storageMock.deleteMaintenanceRequestComment).toHaveBeenCalledWith("c-internal");
  });

  it("lets a household leader delete their own comment", async () => {
    leaderOfHouseA();
    storageMock.getMaintenanceRequestComment.mockResolvedValue({ ...SHARED_COMMENT, id: "c-alice", authorUserId: ALICE.id });
    storageMock.getMaintenanceRequest.mockResolvedValue(OWN_HOUSE_OPEN);
    expect((await del("/api/maintenance-request-comments/c-alice")).status).toBe(200);
    expect(storageMock.deleteMaintenanceRequestComment).toHaveBeenCalledWith("c-alice");
  });

  it("refuses a household leader deleting a staff comment on their house, and deletes nothing", async () => {
    leaderOfHouseA();
    storageMock.getMaintenanceRequestComment.mockResolvedValue(SHARED_COMMENT);
    storageMock.getMaintenanceRequest.mockResolvedValue(OWN_HOUSE_OPEN);
    expect((await del("/api/maintenance-request-comments/c-shared")).status).toBe(403);
    expect(storageMock.deleteMaintenanceRequestComment).not.toHaveBeenCalled();
  });

  // An internal comment is invisible to a resident, so its id is not
  // something they can act on either -- the read rule runs before the
  // author rule, and this stays 403 even if the author column were theirs.
  it("refuses a household leader an internal comment even if it carried their own id", async () => {
    leaderOfHouseA();
    storageMock.getMaintenanceRequestComment.mockResolvedValue({ ...INTERNAL_COMMENT, authorUserId: ALICE.id });
    storageMock.getMaintenanceRequest.mockResolvedValue(OWN_HOUSE_OPEN);
    expect((await del("/api/maintenance-request-comments/c-internal")).status).toBe(403);
    expect(storageMock.deleteMaintenanceRequestComment).not.toHaveBeenCalled();
  });

  // Deleting is reading plus authorship: once the request itself has aged
  // out of the resident's 120-day window, the thread is closed to them too,
  // and that holds even for a comment they wrote themselves.
  it("refuses a household leader deleting their own comment once the request closed more than 120 days ago", async () => {
    const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);
    leaderOfHouseA();
    storageMock.getMaintenanceRequestComment.mockResolvedValue({ ...SHARED_COMMENT, id: "c-alice", authorUserId: ALICE.id });
    storageMock.getMaintenanceRequest.mockResolvedValue({ ...OWN_HOUSE_OPEN, status: "completed", completedDate: daysAgo(121) });
    expect((await del("/api/maintenance-request-comments/c-alice")).status).toBe(403);
    expect(storageMock.deleteMaintenanceRequestComment).not.toHaveBeenCalled();

    // Positive control for the window: closed inside it, the same delete lands.
    storageMock.getMaintenanceRequest.mockResolvedValue({ ...OWN_HOUSE_OPEN, status: "completed", completedDate: daysAgo(119) });
    expect((await del("/api/maintenance-request-comments/c-alice")).status).toBe(200);
    expect(storageMock.deleteMaintenanceRequestComment).toHaveBeenCalledWith("c-alice");
  });

  // -- emailing the thread ----------------------------------------------------

  describe("emailing the people who can see a new comment", () => {
    // The house's two accounts (Bob also filed the request), the author, a
    // colleague covering the region, and an admin who has never posted.
    const TOM = { id: "u-tom", email: "tom@example.com", role: "regional_administrator", isActive: true };
    const on = { commentEmailsEnabled: true };
    const candidates = [
      { user: { ...ALICE, propertyId: "prop-a", ...on }, permissions: null },
      { user: { ...BOB, propertyId: "prop-a", ...on }, permissions: null },
      { user: { ...STAFF, ...on }, permissions: westOnly },
      { user: { ...TOM, ...on }, permissions: { canViewMaintenance: true, allowedRegions: ["West Central"] } },
      { user: { ...ADMIN, ...on }, permissions: null },
    ];

    const addressed = () => sendEmailMock.mock.calls.map(([message]) => message.to).sort();

    beforeEach(() => {
      actAs(STAFF, westOnly);
      storageMock.getMaintenanceRequest.mockResolvedValue(OWN_HOUSE_OPEN);
      storageMock.getAllUsersWithPermissions.mockResolvedValue(candidates);
      storageMock.getAllProperties.mockResolvedValue([PROPERTY_A]);
      // Both house accounts are on the house's roster today.
      storageMock.getAllResidents.mockResolvedValue([
        { id: "r-alice", email: ALICE.email, propertyId: "prop-a", isActive: true, moveOutDate: null },
        { id: "r-bob", email: BOB.email, propertyId: "prop-a", isActive: true, moveOutDate: null },
      ]);
      // The author has posted before; nobody else has.
      storageMock.getMaintenanceRequestComments.mockResolvedValue([INTERNAL_COMMENT]);
      storageMock.createMaintenanceRequestComment.mockImplementation(async (c: unknown) => ({ id: "c-new", ...(c as object) }));
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("stops emailing a housemate who has left the roster, though their login is still linked", async () => {
      storageMock.getAllResidents.mockResolvedValue([
        { id: "r-alice", email: ALICE.email, propertyId: "prop-a", isActive: false, moveOutDate: new Date("2026-05-20") },
        { id: "r-bob", email: BOB.email, propertyId: "prop-a", isActive: true, moveOutDate: null },
      ]);
      await post("/api/maintenance-requests/req-own-open/comments", { body: "Thursday at 9.", isInternal: false });
      // Bob still hears: he filed it, and is on the roster. Alice does not.
      expect(addressed()).toEqual(["bob@example.com", "tom@example.com"]);
    });

    it("emails a shared comment to both house accounts and the covering colleague, one message each, never the author", async () => {
      const { status } = await post("/api/maintenance-requests/req-own-open/comments", { body: "Thursday at 9.", isInternal: false });
      expect(status).toBe(201);
      expect(addressed()).toEqual(["alice@example.com", "bob@example.com", "tom@example.com"]);
      for (const [message] of sendEmailMock.mock.calls) {
        expect(message.text).toContain("Thursday at 9.");
        expect(message.to).not.toContain(",");
      }
    });

    // A household's own comment flows through the same rule: the housemate,
    // the staff member already in the thread and the colleague covering the
    // region hear about it; the author does not, and neither does the admin
    // who has never posted here.
    it("emails a household leader's comment to the housemate and to staff, never the author", async () => {
      leaderOfHouseA();
      const { status } = await post("/api/maintenance-requests/req-own-open/comments", { body: "Still leaking.", isInternal: false });
      expect(status).toBe(201);
      expect(addressed()).toEqual(["bob@example.com", "staff@example.com", "tom@example.com"]);
    });

    it("emails an internal comment to staff and to no resident address", async () => {
      const { status } = await post("/api/maintenance-requests/req-own-open/comments", { body: "He quoted $4,200." });
      expect(status).toBe(201);
      expect(addressed()).toEqual(["tom@example.com"]);
    });

    // The unlinked submitter: an account with no propertyId who filed the
    // request itself. Reachable through ownsRecord, not the house match, so
    // she must hear about a shared comment and never an internal one --
    // exactly the EVE case commentRecipients.test.ts proves at the pure-
    // function level, here through the real route.
    it("emails a resident who submitted the request but has no house link, on a shared comment only", async () => {
      const EVE = { id: "u-eve", email: "eve@example.com", role: "resident", isActive: true, propertyId: null, ...on };
      storageMock.getMaintenanceRequest.mockResolvedValue({ ...OWN_HOUSE_OPEN, submittedBy: EVE.email });
      storageMock.getAllUsersWithPermissions.mockResolvedValue([...candidates, { user: EVE, permissions: null }]);

      const shared = await post("/api/maintenance-requests/req-own-open/comments", { body: "Shared note.", isInternal: false });
      expect(shared.status).toBe(201);
      expect(addressed()).toContain("eve@example.com");

      sendEmailMock.mockClear();
      const internal = await post("/api/maintenance-requests/req-own-open/comments", { body: "Internal note." });
      expect(internal.status).toBe(201);
      expect(addressed()).not.toContain("eve@example.com");
    });

    it("links to the request when APP_URL is set, and goes without a link when it is not", async () => {
      await post("/api/maintenance-requests/req-own-open/comments", { body: "No link." });
      expect(sendEmailMock.mock.calls[0][0].text).not.toContain("/maintenance/");

      sendEmailMock.mockClear();
      vi.stubEnv("APP_URL", "https://housing.spo.org/");
      await post("/api/maintenance-requests/req-own-open/comments", { body: "With link." });
      expect(sendEmailMock.mock.calls[0][0].text).toContain("https://housing.spo.org/maintenance/req-own-open");
    });

    it("does not hold the response for the sends", async () => {
      // A send that never settles: the comment is still posted and answered.
      sendEmailMock.mockReturnValue(new Promise(() => {}));
      const { status, body } = await post("/api/maintenance-requests/req-own-open/comments", { body: "Noted." });
      expect(status).toBe(201);
      expect(body.id).toBe("c-new");
      expect(sendEmailMock).toHaveBeenCalled();
    });

    it("still posts the comment when every send fails", async () => {
      sendEmailMock.mockResolvedValue({ sent: false, reason: "send_failed" });
      const { status, body } = await post("/api/maintenance-requests/req-own-open/comments", { body: "Noted." });
      expect(status).toBe(201);
      expect(body.id).toBe("c-new");
      expect(storageMock.createMaintenanceRequestComment).toHaveBeenCalledTimes(1);
    });

    it("still posts the comment when working out who to email fails", async () => {
      storageMock.getAllUsersWithPermissions.mockRejectedValue(new Error("database gone"));
      const { status, body } = await post("/api/maintenance-requests/req-own-open/comments", { body: "Noted." });
      expect(status).toBe(201);
      expect(body.id).toBe("c-new");
      expect(storageMock.createMaintenanceRequestComment).toHaveBeenCalledTimes(1);
      expect(sendEmailMock).not.toHaveBeenCalled();
    });

    it("emails nobody when the comment was refused", async () => {
      actAs(STAFF, westOnly);
      storageMock.getMaintenanceRequest.mockResolvedValue(EAST_OPEN);
      expect((await post("/api/maintenance-requests/req-east-open/comments", { body: "Noted." })).status).toBe(403);
      expect(sendEmailMock).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// The comment email off switch
// ---------------------------------------------------------------------------

describe("switching comment email off", () => {
  const off = { commentEmailsEnabled: false };

  beforeEach(() => {
    storageMock.updateUserCommentEmails.mockImplementation(async (id: string, enabled: boolean) => ({
      id,
      commentEmailsEnabled: enabled,
    }));
  });

  it("refuses an anonymous caller", async () => {
    expect((await request("PATCH", "/api/auth/me/notifications", { body: off })).status).toBe(401);
    expect((await request("PATCH", `/api/users/${BOB.id}/notifications`, { body: off })).status).toBe(401);
    expect(storageMock.updateUserCommentEmails).not.toHaveBeenCalled();
  });

  it("lets anybody flip their own switch, on whichever tier", async () => {
    actAs(ALICE);
    const { status, body } = await request("PATCH", "/api/auth/me/notifications", { body: off });
    expect(status).toBe(200);
    expect(body.commentEmailsEnabled).toBe(false);
    expect(storageMock.updateUserCommentEmails).toHaveBeenCalledWith(ALICE.id, false);

    actAs(STAFF);
    await request("PATCH", "/api/auth/me/notifications", { body: { commentEmailsEnabled: true } });
    expect(storageMock.updateUserCommentEmails).toHaveBeenLastCalledWith(STAFF.id, true);
  });

  // The self-service route reads the actor off the session, never the body --
  // the same shape as every other "for oneself" write in this file. Another
  // user's id riding along in the body must change nothing.
  it("ignores another user's id carried in the body of the self-service route", async () => {
    actAs(ALICE);
    const { status } = await request("PATCH", "/api/auth/me/notifications", { body: { ...off, userId: BOB.id, id: BOB.id } });
    expect(status).toBe(200);
    expect(storageMock.updateUserCommentEmails).toHaveBeenCalledWith(ALICE.id, false);
    expect(storageMock.updateUserCommentEmails).not.toHaveBeenCalledWith(BOB.id, expect.anything());
  });

  it("refuses a deactivated account, and writes nothing", async () => {
    actAs(DISABLED);
    expect((await request("PATCH", "/api/auth/me/notifications", { body: off })).status).toBe(403);
    expect(storageMock.updateUserCommentEmails).not.toHaveBeenCalled();
  });

  it("refuses a resident flipping somebody else's switch, and writes nothing", async () => {
    actAs(ALICE);
    expect((await request("PATCH", `/api/users/${BOB.id}/notifications`, { body: off })).status).toBe(403);
    expect(storageMock.updateUserCommentEmails).not.toHaveBeenCalled();
  });

  it("refuses a regional administrator flipping somebody else's switch, and writes nothing", async () => {
    actAs(STAFF, { canManageUsers: true, allowedRegions: ["West Central"] });
    expect((await request("PATCH", `/api/users/${BOB.id}/notifications`, { body: off })).status).toBe(403);
    expect(storageMock.updateUserCommentEmails).not.toHaveBeenCalled();
  });

  // The positive control: the account change is an admin's, like every other.
  it("lets an admin flip anybody's switch, without an audit event", async () => {
    actAs(ADMIN);
    const { status } = await request("PATCH", `/api/users/${BOB.id}/notifications`, { body: off });
    expect(status).toBe(200);
    expect(storageMock.updateUserCommentEmails).toHaveBeenCalledWith(BOB.id, false);
    // A preference, not access, money or a document.
    expect(storageMock.createAuditEvent).not.toHaveBeenCalled();
  });

  it("refuses a value that is not a boolean, and writes nothing", async () => {
    actAs(ALICE);
    expect((await request("PATCH", "/api/auth/me/notifications", { body: { commentEmailsEnabled: "no" } })).status).toBe(400);
    actAs(ADMIN);
    expect((await request("PATCH", `/api/users/${BOB.id}/notifications`, { body: {} })).status).toBe(400);
    expect(storageMock.updateUserCommentEmails).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Request types: residents see repairs only
// ---------------------------------------------------------------------------

/**
 * ADR-0001 made projects and capital projects a TYPE on maintenance
 * requests, which puts bid amounts and contract terms in a table a household
 * leader can already read. The rule that keeps them out lives in
 * canReadMaintenanceRequest; these cases pin it at every route a resident
 * reads a request through, on the one case the house match would otherwise
 * let through -- their own house.
 */
describe("a file on a comment", () => {
  // The attachment route is a resident-reachable upload -- the first one
  // that stores a document rather than a photo -- and the create route is a
  // body that names a stored file. Both are the shape of the historic gaps:
  // a refused caller must not have their body read, and a comment must not
  // be able to point at a file its author never uploaded, because a file
  // inherits every reference's visibility and one readable reference is
  // enough to serve it.
  const HOUSE_A = "1 Main St";
  const HOUSE_B = "2 River Rd";
  const PROPERTY_A = { id: "prop-a", name: "Cleveland House", region: "West Central", address: HOUSE_A };
  const westOnly = { ...ALL_MAINTENANCE, allowedRegions: ["West Central"] };
  const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

  const OWN_HOUSE_OPEN = {
    id: "req-own-open",
    title: "Blinds fell down",
    region: "West Central",
    buildingAddress: HOUSE_A,
    submittedBy: BOB.email,
    status: "pending",
    type: "request",
  };
  const OTHER_HOUSE_OPEN = { ...OWN_HOUSE_OPEN, id: "req-other-open", buildingAddress: HOUSE_B };
  const EAST_OPEN = { ...OWN_HOUSE_OPEN, id: "req-east-open", region: "East Central" };

  const KEY = "0123456789abcdef0123456789abcdef.pdf";
  const UPLOAD_URL = `/uploads/${KEY}`;
  const uploadRow = (uploadedBy: string) => ({
    id: "upload-1",
    storageKey: KEY,
    originalName: "quote.pdf",
    contentType: "application/pdf",
    sizeBytes: 1024,
    uploadedBy,
  });

  const leaderOfHouseA = () => {
    actAs({ ...ALICE, propertyId: "prop-a" } as typeof ALICE, ALL_MAINTENANCE);
    storageMock.getProperty.mockResolvedValue(PROPERTY_A);
  };

  const ATTACH = (id: string) => `/api/maintenance-requests/${id}/attachments`;

  /** A real (if tiny) PDF: the magic-byte check is the same one the other upload routes apply. */
  const aQuote = () => {
    const form = new FormData();
    form.append("file", new Blob([new TextEncoder().encode("%PDF-1.4\n%quote\n")], { type: "application/pdf" }), "quote.pdf");
    return form;
  };

  /** Bigger than the 20MB document limit, so the route's own size cap has to catch it. */
  const aHugeQuote = () => {
    const form = new FormData();
    const oversized = new Uint8Array(DOCUMENT_UPLOAD_MAX_BYTES + 512 * 1024);
    form.append("file", new Blob([oversized], { type: "application/pdf" }), "quote.pdf");
    return form;
  };

  /** An executable renamed to .pdf, with a matching Content-Type header: the same
   * disguise bufferMatchesExtension exists to catch on every other upload route. */
  const aRenamedExecutable = () => {
    const form = new FormData();
    const exe = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00]);
    form.append("file", new Blob([exe], { type: "application/pdf" }), "quote.pdf");
    return form;
  };

  async function postForm(path: string, form: FormData) {
    const res = await fetch(`${baseUrl}${path}`, { method: "POST", body: form });
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  }

  const postFile = (path: string) => postForm(path, aQuote());

  const post = (path: string, body: unknown) => request("POST", path, { body });
  const del = (path: string) => request("DELETE", path);

  // -- uploading ----------------------------------------------------------------

  it("stores a household leader's file for their own house's request, under the session's account, and says what it was called", async () => {
    // The positive control for every "not read" assertion below: the same
    // account, the same file, a request it may post on -- and the parser
    // does run, the file is written, and the row names who stored it.
    leaderOfHouseA();
    storageMock.getMaintenanceRequest.mockResolvedValue(OWN_HOUSE_OPEN);
    const { status, body } = await postFile(ATTACH("req-own-open"));
    expect(status).toBe(200);
    expect(body.url).toMatch(/^\/uploads\/[0-9a-f]{32}\.pdf$/);
    expect(body.name).toBe("quote.pdf");
    expect(multerEntered).toHaveBeenCalledWith(ATTACH("req-own-open"));
    expect(fileStoreMock.putUpload).toHaveBeenCalled();
    expect(storageMock.createUpload).toHaveBeenCalledWith(expect.objectContaining({ uploadedBy: ALICE.id, originalName: "quote.pdf" }));
  });

  it("refuses a household leader another house's request before the parser reads a byte, and stores nothing", async () => {
    leaderOfHouseA();
    storageMock.getMaintenanceRequest.mockResolvedValue(OTHER_HOUSE_OPEN);
    const { status } = await postFile(ATTACH("req-other-open"));
    expect(status).toBe(403);
    expect(multerEntered).not.toHaveBeenCalled();
    expect(fileStoreMock.putUpload).not.toHaveBeenCalled();
    expect(storageMock.createUpload).not.toHaveBeenCalled();
  });

  it("refuses a household leader once the request closed more than 120 days ago, before the parser reads a byte", async () => {
    leaderOfHouseA();
    storageMock.getMaintenanceRequest.mockResolvedValue({ ...OWN_HOUSE_OPEN, status: "completed", completedDate: daysAgo(121) });
    const { status } = await postFile(ATTACH("req-own-open"));
    expect(status).toBe(403);
    expect(multerEntered).not.toHaveBeenCalled();
    expect(fileStoreMock.putUpload).not.toHaveBeenCalled();
  });

  it("refuses staff a request outside their regions before the parser reads a byte, and stores nothing", async () => {
    actAs(STAFF, westOnly);
    storageMock.getMaintenanceRequest.mockResolvedValue(EAST_OPEN);
    const { status } = await postFile(ATTACH("req-east-open"));
    expect(status).toBe(403);
    expect(multerEntered).not.toHaveBeenCalled();
    expect(fileStoreMock.putUpload).not.toHaveBeenCalled();
  });

  it("refuses an anonymous caller before the parser reads a byte", async () => {
    storageMock.getMaintenanceRequest.mockResolvedValue(OWN_HOUSE_OPEN);
    const { status } = await postFile(ATTACH("req-own-open"));
    expect(status).toBe(401);
    expect(multerEntered).not.toHaveBeenCalled();
    expect(fileStoreMock.putUpload).not.toHaveBeenCalled();
  });

  it("answers 404 for a request that does not exist, before the parser reads a byte", async () => {
    actAs(STAFF, westOnly);
    storageMock.getMaintenanceRequest.mockResolvedValue(undefined);
    const { status } = await postFile(ATTACH("req-nope"));
    expect(status).toBe(404);
    expect(multerEntered).not.toHaveBeenCalled();
    expect(fileStoreMock.putUpload).not.toHaveBeenCalled();
  });

  it("lets staff in the request's region store a file", async () => {
    actAs(STAFF, westOnly);
    storageMock.getMaintenanceRequest.mockResolvedValue(OWN_HOUSE_OPEN);
    const { status, body } = await postFile(ATTACH("req-own-open"));
    expect(status).toBe(200);
    expect(body.name).toBe("quote.pdf");
    expect(storageMock.createUpload).toHaveBeenCalledWith(expect.objectContaining({ uploadedBy: STAFF.id }));
  });

  // The upload layer records every document stored; this route goes through
  // the same layer, so the event fires without this route adding one.
  it("records the document upload in the audit log, as the other upload routes do", async () => {
    leaderOfHouseA();
    storageMock.getMaintenanceRequest.mockResolvedValue(OWN_HOUSE_OPEN);
    const { status } = await postFile(ATTACH("req-own-open"));
    expect(status).toBe(200);
    expect(storageMock.createAuditEvent).toHaveBeenCalledTimes(1);
    expect(storageMock.createAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: "document.uploaded", entityType: "upload", actorId: ALICE.id, summary: "Uploaded quote.pdf" }),
    );
  });

  it("refuses a file over the 20MB document limit with a 413 naming that limit, and stores nothing", async () => {
    leaderOfHouseA();
    storageMock.getMaintenanceRequest.mockResolvedValue(OWN_HOUSE_OPEN);
    const { status, body } = await postForm(ATTACH("req-own-open"), aHugeQuote());
    expect(status).toBe(413);
    expect(body.message).toContain("20MB");
    expect(fileStoreMock.putUpload).not.toHaveBeenCalled();
    expect(storageMock.createUpload).not.toHaveBeenCalled();
  });

  it("refuses an executable renamed to .pdf, the same magic-byte check /api/upload-doc applies, and stores nothing", async () => {
    leaderOfHouseA();
    storageMock.getMaintenanceRequest.mockResolvedValue(OWN_HOUSE_OPEN);
    const { status, body } = await postForm(ATTACH("req-own-open"), aRenamedExecutable());
    expect(status).toBe(400);
    expect(body.message).toMatch(/do not match/i);
    expect(fileStoreMock.putUpload).not.toHaveBeenCalled();
    expect(storageMock.createUpload).not.toHaveBeenCalled();
  });

  // -- posting the comment that names the file --------------------------------

  it("stores the attachment on the comment when it points at a file the author uploaded", async () => {
    actAs(STAFF, westOnly);
    storageMock.getMaintenanceRequest.mockResolvedValue(OWN_HOUSE_OPEN);
    storageMock.getUploadByStorageKey.mockResolvedValue(uploadRow(STAFF.id));
    storageMock.createMaintenanceRequestComment.mockImplementation(async (c: unknown) => ({ id: "c-new", ...(c as object) }));
    const { status, body } = await post("/api/maintenance-requests/req-own-open/comments", {
      body: "His quote is attached.",
      attachmentUrl: UPLOAD_URL,
      attachmentName: "Dave's quote.pdf",
    });
    expect(status).toBe(201);
    expect(storageMock.getUploadByStorageKey).toHaveBeenCalledWith(KEY);
    expect(storageMock.createMaintenanceRequestComment).toHaveBeenCalledWith(
      expect.objectContaining({ attachmentUrl: UPLOAD_URL, attachmentName: "Dave's quote.pdf" }),
    );
    expect(body.attachmentUrl).toBe(UPLOAD_URL);
  });

  it("names the file as it was stored when the body gives no name", async () => {
    leaderOfHouseA();
    storageMock.getMaintenanceRequest.mockResolvedValue(OWN_HOUSE_OPEN);
    storageMock.getUploadByStorageKey.mockResolvedValue(uploadRow(ALICE.id));
    storageMock.createMaintenanceRequestComment.mockImplementation(async (c: unknown) => ({ id: "c-new", ...(c as object) }));
    const { status } = await post("/api/maintenance-requests/req-own-open/comments", { body: "Photo attached.", attachmentUrl: UPLOAD_URL });
    expect(status).toBe(201);
    expect(storageMock.createMaintenanceRequestComment).toHaveBeenCalledWith(
      expect.objectContaining({ attachmentUrl: UPLOAD_URL, attachmentName: "quote.pdf" }),
    );
  });

  it("stores no attachment at all when the body gives a name but no file", async () => {
    actAs(STAFF, westOnly);
    storageMock.getMaintenanceRequest.mockResolvedValue(OWN_HOUSE_OPEN);
    storageMock.createMaintenanceRequestComment.mockImplementation(async (c: unknown) => ({ id: "c-new", ...(c as object) }));
    const { status } = await post("/api/maintenance-requests/req-own-open/comments", { body: "Noted.", attachmentName: "quote.pdf" });
    expect(status).toBe(201);
    expect(storageMock.getUploadByStorageKey).not.toHaveBeenCalled();
    expect(storageMock.createMaintenanceRequestComment).toHaveBeenCalledWith(
      expect.objectContaining({ attachmentUrl: null, attachmentName: null }),
    );
  });

  it("refuses an attachment URL on another origin as a 400, and writes nothing", async () => {
    actAs(STAFF, westOnly);
    storageMock.getMaintenanceRequest.mockResolvedValue(OWN_HOUSE_OPEN);
    const { status } = await post("/api/maintenance-requests/req-own-open/comments", {
      body: "See link.",
      attachmentUrl: "https://evil.example/x.pdf",
      attachmentName: "x.pdf",
    });
    expect(status).toBe(400);
    expect(storageMock.getUploadByStorageKey).not.toHaveBeenCalled();
    expect(storageMock.createMaintenanceRequestComment).not.toHaveBeenCalled();
  });

  it("refuses an attachment URL that climbs out of the uploads area as a 400, and writes nothing", async () => {
    actAs(STAFF, westOnly);
    storageMock.getMaintenanceRequest.mockResolvedValue(OWN_HOUSE_OPEN);
    for (const attachmentUrl of ["/uploads/../etc/passwd", "/uploads/..", "/uploads/.hidden", "/uploads/", "javascript:alert(1)"]) {
      const { status } = await post("/api/maintenance-requests/req-own-open/comments", { body: "See file.", attachmentUrl });
      expect(status, attachmentUrl).toBe(400);
    }
    expect(storageMock.getUploadByStorageKey).not.toHaveBeenCalled();
    expect(storageMock.createMaintenanceRequestComment).not.toHaveBeenCalled();
  });

  it("refuses an attachment name over 255 characters as a 400, and writes nothing", async () => {
    actAs(STAFF, westOnly);
    storageMock.getMaintenanceRequest.mockResolvedValue(OWN_HOUSE_OPEN);
    storageMock.getUploadByStorageKey.mockResolvedValue(uploadRow(STAFF.id));
    const { status } = await post("/api/maintenance-requests/req-own-open/comments", {
      body: "See file.",
      attachmentUrl: UPLOAD_URL,
      attachmentName: "a".repeat(256),
    });
    expect(status).toBe(400);
    expect(storageMock.createMaintenanceRequestComment).not.toHaveBeenCalled();
  });

  // A file inherits the visibility of every record that points at it, and
  // one readable reference is enough to serve it. So a comment on a house's
  // repair that named a vendor's W-9 would hand that W-9 to the household.
  it("refuses an attachment pointing at a file somebody else uploaded, and writes nothing", async () => {
    leaderOfHouseA();
    storageMock.getMaintenanceRequest.mockResolvedValue(OWN_HOUSE_OPEN);
    storageMock.getUploadByStorageKey.mockResolvedValue(uploadRow(STAFF.id));
    const { status } = await post("/api/maintenance-requests/req-own-open/comments", { body: "See file.", attachmentUrl: UPLOAD_URL });
    expect(status).toBe(400);
    expect(storageMock.createMaintenanceRequestComment).not.toHaveBeenCalled();
  });

  it("refuses an attachment pointing at a file that was never stored, and writes nothing", async () => {
    actAs(STAFF, westOnly);
    storageMock.getMaintenanceRequest.mockResolvedValue(OWN_HOUSE_OPEN);
    storageMock.getUploadByStorageKey.mockResolvedValue(undefined);
    const { status } = await post("/api/maintenance-requests/req-own-open/comments", { body: "See file.", attachmentUrl: UPLOAD_URL });
    expect(status).toBe(400);
    expect(storageMock.createMaintenanceRequestComment).not.toHaveBeenCalled();
  });

  // -- deleting -----------------------------------------------------------------

  const COMMENT_WITH_FILE = {
    id: "c-file",
    requestId: OWN_HOUSE_OPEN.id,
    body: "His quote is attached.",
    isInternal: true,
    authorUserId: STAFF.id,
    attachmentUrl: UPLOAD_URL,
    attachmentName: "quote.pdf",
  };

  it("removes the comment and its file", async () => {
    // Known issue 1, closed for comments (JR, 2026-09-28): the confirmation
    // says the file goes too.
    actAs(STAFF, westOnly);
    storageMock.getMaintenanceRequestComment.mockResolvedValue(COMMENT_WITH_FILE);
    storageMock.getMaintenanceRequest.mockResolvedValue(OWN_HOUSE_OPEN);
    storageMock.deleteMaintenanceRequestComment.mockResolvedValue([UPLOAD_URL]);
    expect((await del("/api/maintenance-request-comments/c-file")).status).toBe(200);
    expect(storageMock.deleteMaintenanceRequestComment).toHaveBeenCalledWith("c-file");
    expect(fileStoreMock.removeUpload).toHaveBeenCalledWith(KEY);
    expect(storageMock.deleteUpload).toHaveBeenCalledWith(KEY);
  });

  it("removes the comment and keeps a file another record still points at", async () => {
    actAs(STAFF, westOnly);
    storageMock.getMaintenanceRequestComment.mockResolvedValue(COMMENT_WITH_FILE);
    storageMock.getMaintenanceRequest.mockResolvedValue(OWN_HOUSE_OPEN);
    storageMock.deleteMaintenanceRequestComment.mockResolvedValue([UPLOAD_URL]);
    storageMock.findUploadReferences.mockResolvedValue([{ kind: "maintenanceRequest", record: OWN_HOUSE_OPEN }]);
    expect((await del("/api/maintenance-request-comments/c-file")).status).toBe(200);
    expect(storageMock.deleteMaintenanceRequestComment).toHaveBeenCalledWith("c-file");
    expect(storageMock.findUploadReferences).toHaveBeenCalledWith(UPLOAD_URL);
    expect(fileStoreMock.removeUpload).not.toHaveBeenCalled();
    expect(storageMock.deleteUpload).not.toHaveBeenCalled();
  });
});

describe("a household leader and the requests that are not repairs", () => {
  const HOUSE_A = "1 Main St";
  const PROPERTY_A = { id: "prop-a", name: "Cleveland House", region: "West Central", address: HOUSE_A };
  const westOnly = { ...ALL_MAINTENANCE, allowedRegions: ["West Central"] };

  /** A repair on the leader's own house: the positive control throughout. */
  const OWN_REPAIR = {
    id: "req-own-repair",
    title: "Blinds fell down",
    region: "West Central",
    buildingAddress: HOUSE_A,
    submittedBy: BOB.email,
    status: "pending",
    type: "request",
  };
  /** A project on the same house, open, filed by the housemate. */
  const OWN_PROJECT = { ...OWN_REPAIR, id: "req-own-project", title: "New back fence", type: "project" };
  /** A capital project on the same house, with the finance conversation in its text. */
  const OWN_CAPEX = {
    ...OWN_REPAIR,
    id: "req-own-capex",
    title: "Roof replacement",
    description: "Three bids in; lowest is $18,400.",
    type: "capex",
  };
  /** A project the leader is recorded as having submitted -- the ownership path. */
  const OWN_SUBMITTED_PROJECT = { ...OWN_PROJECT, id: "req-alice-project", submittedBy: ALICE.email };

  const leaderOfHouseA = () => {
    actAs({ ...ALICE, propertyId: "prop-a" } as typeof ALICE, ALL_MAINTENANCE);
    storageMock.getProperty.mockResolvedValue(PROPERTY_A);
  };

  it("lists only the repairs on their house, never a project or a capital project", async () => {
    leaderOfHouseA();
    storageMock.getAllMaintenanceRequests.mockResolvedValue([OWN_REPAIR, OWN_PROJECT, OWN_CAPEX, OWN_SUBMITTED_PROJECT]);
    const { status, body } = await get("/api/maintenance-requests");
    expect(status).toBe(200);
    expect(body.map((r: { id: string }) => r.id)).toEqual(["req-own-repair"]);
    expect(JSON.stringify(body)).not.toContain("$18,400");
  });

  // Positive control for the list: staff see all three types.
  it("lists all three types for staff in the region", async () => {
    actAs(STAFF, westOnly);
    storageMock.getAllMaintenanceRequests.mockResolvedValue([OWN_REPAIR, OWN_PROJECT, OWN_CAPEX]);
    const { body } = await get("/api/maintenance-requests");
    expect(body.map((r: { id: string }) => r.id)).toEqual(["req-own-repair", "req-own-project", "req-own-capex"]);
  });

  // Amendment to 5.3: the type filter is a STAFF default. The resident
  // constraint is a separate server-side condition, applied whatever the
  // query string says, and derived from the type column alone -- never from
  // status, priority or the filter. The house match in ownsRecord is exactly
  // what would otherwise let these through.
  it.each(["project", "capex"])(
    "gives a household leader no %s on their own house even when asked for that type by name",
    async (type) => {
      leaderOfHouseA();
      storageMock.getAllMaintenanceRequests.mockResolvedValue([OWN_REPAIR, OWN_PROJECT, OWN_CAPEX, OWN_SUBMITTED_PROJECT]);
      const { status, body } = await get(`/api/maintenance-requests?type=${type}`);
      expect(status).toBe(200);
      expect(body.map((r: { id: string }) => r.id)).toEqual(["req-own-repair"]);
      expect(JSON.stringify(body)).not.toContain("$18,400");
    },
  );

  it("gives a household leader no project on their own house even when asked for every type", async () => {
    leaderOfHouseA();
    storageMock.getAllMaintenanceRequests.mockResolvedValue([OWN_REPAIR, OWN_PROJECT, OWN_CAPEX, OWN_SUBMITTED_PROJECT]);
    const { body } = await get("/api/maintenance-requests?type=all");
    expect(body.map((r: { id: string }) => r.id)).toEqual(["req-own-repair"]);
  });

  // Positive control: the same parameter changes nothing for staff either,
  // because the type filter lives on the client. If a server-side type
  // filter is ever added, this is the test that says the resident rule must
  // stay independent of it.
  it("lists all three types for staff whatever type the query names", async () => {
    actAs(STAFF, westOnly);
    storageMock.getAllMaintenanceRequests.mockResolvedValue([OWN_REPAIR, OWN_PROJECT, OWN_CAPEX]);
    const { body } = await get("/api/maintenance-requests?type=project");
    expect(body.map((r: { id: string }) => r.id)).toEqual(["req-own-repair", "req-own-project", "req-own-capex"]);
  });

  it("refuses the detail route for a capital project on their house, and never sends its contents", async () => {
    leaderOfHouseA();
    storageMock.getMaintenanceRequest.mockResolvedValue(OWN_CAPEX);
    const { status, body } = await get("/api/maintenance-requests/req-own-capex");
    expect(status).toBe(403);
    expect(body).not.toHaveProperty("title");
    expect(body).not.toHaveProperty("description");
  });

  it("refuses the detail route for a project on their house", async () => {
    leaderOfHouseA();
    storageMock.getMaintenanceRequest.mockResolvedValue(OWN_PROJECT);
    expect((await get("/api/maintenance-requests/req-own-project")).status).toBe(403);
  });

  it("refuses a project even when they are recorded as its submitter", async () => {
    leaderOfHouseA();
    storageMock.getMaintenanceRequest.mockResolvedValue(OWN_SUBMITTED_PROJECT);
    const { status, body } = await get("/api/maintenance-requests/req-alice-project");
    expect(status).toBe(403);
    expect(body).not.toHaveProperty("title");
  });

  // Positive control for the detail route: the same house, a repair, opens.
  it("still opens a repair on their house", async () => {
    leaderOfHouseA();
    storageMock.getMaintenanceRequest.mockResolvedValue(OWN_REPAIR);
    const { status, body } = await get("/api/maintenance-requests/req-own-repair");
    expect(status).toBe(200);
    expect(body.id).toBe("req-own-repair");
  });

  it("is refused a project's contractors before they are loaded", async () => {
    leaderOfHouseA();
    storageMock.getMaintenanceRequest.mockResolvedValue(OWN_PROJECT);
    expect((await get("/api/maintenance-requests/req-own-project/contacts")).status).toBe(403);
    expect(storageMock.getRequestContacts).not.toHaveBeenCalled();
  });

  it("is refused a project's thread before the comments are loaded", async () => {
    leaderOfHouseA();
    storageMock.getMaintenanceRequest.mockResolvedValue(OWN_PROJECT);
    expect((await get("/api/maintenance-requests/req-own-project/comments")).status).toBe(403);
    expect(storageMock.getMaintenanceRequestComments).not.toHaveBeenCalled();
  });

  // Positive control for the thread: a repair's shared comments still arrive.
  it("still reads the shared comments on a repair on their house", async () => {
    leaderOfHouseA();
    storageMock.getMaintenanceRequest.mockResolvedValue(OWN_REPAIR);
    storageMock.getMaintenanceRequestComments.mockResolvedValue([
      { id: "c-shared", requestId: OWN_REPAIR.id, body: "Thursday at 9.", isInternal: false, authorUserId: STAFF.id },
    ]);
    const { status, body } = await get("/api/maintenance-requests/req-own-repair/comments");
    expect(status).toBe(200);
    expect(body.map((c: { id: string }) => c.id)).toEqual(["c-shared"]);
  });

  it("sees no photos on a project or capital project on their house through the photo list", async () => {
    leaderOfHouseA();
    storageMock.getAllMaintenanceRequests.mockResolvedValue([OWN_REPAIR, OWN_PROJECT, OWN_CAPEX]);
    storageMock.getAllMaintenanceRequestPhotos.mockResolvedValue([
      { id: "ph-repair", requestId: OWN_REPAIR.id, imageUrl: "/uploads/repair.png" },
      { id: "ph-project", requestId: OWN_PROJECT.id, imageUrl: "/uploads/fence.png" },
      { id: "ph-capex", requestId: OWN_CAPEX.id, imageUrl: "/uploads/roof.png" },
    ]);
    const { status, body } = await get("/api/maintenance-request-photos");
    expect(status).toBe(200);
    expect(body.map((p: { id: string }) => p.id)).toEqual(["ph-repair"]);
  });

  it("cannot download a photo attached to a project on their house", async () => {
    const KEY = "0123456789abcdef0123456789abcdef.jpg";
    leaderOfHouseA();
    storageMock.getUploadByStorageKey.mockResolvedValue({ storageKey: KEY, uploadedBy: STAFF.id });
    storageMock.findUploadReferences.mockResolvedValue([{ kind: "maintenanceRequest", record: OWN_PROJECT }]);
    expect((await get(`/uploads/${KEY}`)).status).toBe(403);
    expect(fileStoreMock.openUploadStream).not.toHaveBeenCalled();
  });

  // Positive control for the download: the same file on a repair streams.
  it("can download a photo attached to a repair on their house", async () => {
    const KEY = "0123456789abcdef0123456789abcdef.jpg";
    leaderOfHouseA();
    storageMock.getUploadByStorageKey.mockResolvedValue({ storageKey: KEY, uploadedBy: STAFF.id });
    storageMock.findUploadReferences.mockResolvedValue([{ kind: "maintenanceRequest", record: OWN_REPAIR }]);
    expect((await get(`/uploads/${KEY}`)).status).toBe(200);
    expect(fileStoreMock.openUploadStream).toHaveBeenCalled();
  });

  // Residents cannot PATCH a request at all -- the route is requireStaff --
  // so "a resident cannot set the type on an update" is asserted here as the
  // existing refusal, with the write never reaching storage, rather than as
  // a new branch that would only exist to be tested.
  it("cannot change a request's type on an update: the PATCH is refused and nothing is written", async () => {
    leaderOfHouseA();
    storageMock.getMaintenanceRequest.mockResolvedValue(OWN_REPAIR);
    const { status } = await request("PATCH", "/api/maintenance-requests/req-own-repair", { body: { type: "capex" } });
    expect(status).toBe(403);
    expect(storageMock.updateMaintenanceRequest).not.toHaveBeenCalled();
  });

  // Positive control: staff with the manage permission set the type on an update.
  it("lets staff change a repair into a project on an update", async () => {
    actAs(STAFF, westOnly);
    storageMock.getMaintenanceRequest.mockResolvedValue(OWN_REPAIR);
    const { status } = await request("PATCH", "/api/maintenance-requests/req-own-repair", { body: { type: "project" } });
    expect(status).toBe(200);
    expect(storageMock.updateMaintenanceRequest).toHaveBeenCalledWith(
      "req-own-repair",
      expect.objectContaining({ type: "project" }),
    );
  });

  it("refuses a type outside the vocabulary as a 400, and writes nothing", async () => {
    actAs(STAFF, westOnly);
    storageMock.getMaintenanceRequest.mockResolvedValue(OWN_REPAIR);
    const { status } = await request("PATCH", "/api/maintenance-requests/req-own-repair", { body: { type: "wishlist" } });
    expect(status).toBe(400);
    expect(storageMock.updateMaintenanceRequest).not.toHaveBeenCalled();
  });
});

describe("project fields and bids", () => {
  // The cost of ADR-0001 made concrete: bids and contract terms now sit in
  // the table a household leader can already read, so every route here is
  // staff-only, region-checked, and refuses a repair outright. A resident
  // never reaches a bid because they never reach its parent -- asserted
  // directly anyway, because "never reaches" is exactly the kind of claim
  // that stops being true after a refactor nobody meant to make.
  const HOUSE_A = "1 Main St";
  const PROPERTY_A = { id: "prop-a", name: "Cleveland House", region: "West Central", address: HOUSE_A };
  const westOnly = { ...ALL_MAINTENANCE, allowedRegions: ["West Central"] };
  const viewOnly = { canViewMaintenance: true, allowedRegions: ["West Central"] };

  const REPAIR = {
    id: "req-repair",
    title: "Blinds fell down",
    region: "West Central",
    buildingAddress: HOUSE_A,
    submittedBy: BOB.email,
    status: "pending",
    type: "request",
    contractUrl: null,
    estimatedCost: null,
    actualCost: null,
    targetYear: null,
    targetQuarter: null,
  };
  const PROJECT = { ...REPAIR, id: "req-project", title: "New back fence", type: "project" };
  const CAPEX = { ...REPAIR, id: "req-capex", title: "Roof replacement", type: "capex", targetYear: 2027 };
  const EAST_PROJECT = { ...PROJECT, id: "req-east-project", region: "East Central" };

  const BID_A = {
    id: "bid-a",
    requestId: PROJECT.id,
    contactId: null,
    vendorName: "Dave's Fencing",
    amount: "4200.00",
    bidDate: null,
    notes: null,
    documentUrl: null,
    documentName: null,
    accepted: true,
  };
  const BID_B = { ...BID_A, id: "bid-b", vendorName: "Northside Fence Co", amount: "3900.00", accepted: false };
  const EAST_BID = { ...BID_A, id: "bid-east", requestId: EAST_PROJECT.id };

  const KEY = "0123456789abcdef0123456789abcdef.pdf";
  const UPLOAD_URL = `/uploads/${KEY}`;
  const uploadRow = (uploadedBy: string) => ({
    id: "upload-1",
    storageKey: KEY,
    originalName: "quote.pdf",
    contentType: "application/pdf",
    sizeBytes: 1024,
    uploadedBy,
  });

  const leaderOfHouseA = () => {
    actAs({ ...ALICE, propertyId: "prop-a" } as typeof ALICE, ALL_MAINTENANCE);
    storageMock.getProperty.mockResolvedValue(PROPERTY_A);
  };

  const BIDS = (id: string) => `/api/maintenance-requests/${id}/bids`;
  const BID = (id: string) => `/api/maintenance-request-bids/${id}`;
  const BID_DOCS = (id: string) => `/api/maintenance-requests/${id}/bid-documents`;
  const post = (path: string, body: unknown) => request("POST", path, { body });
  const patch = (path: string, body: unknown) => request("PATCH", path, { body });
  const del = (path: string) => request("DELETE", path);

  /** A real (if tiny) PDF: the magic-byte check is the same one the other upload routes apply. */
  const aQuote = () => {
    const form = new FormData();
    form.append("file", new Blob([new TextEncoder().encode("%PDF-1.4\n%quote\n")], { type: "application/pdf" }), "quote.pdf");
    return form;
  };

  async function postFile(path: string) {
    const res = await fetch(`${baseUrl}${path}`, { method: "POST", body: aQuote() });
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  }

  beforeEach(() => {
    const requests = [REPAIR, PROJECT, CAPEX, EAST_PROJECT];
    storageMock.getMaintenanceRequest.mockImplementation(async (id: string) => requests.find((r) => r.id === id));
    const bids = [BID_A, BID_B, EAST_BID];
    storageMock.getMaintenanceRequestBid.mockImplementation(async (id: string) => bids.find((b) => b.id === id));
    storageMock.getMaintenanceRequestBids.mockResolvedValue([BID_A, BID_B]);
    storageMock.createMaintenanceRequestBid.mockImplementation(async (b: object) => ({ id: "bid-new", accepted: false, ...b }));
    storageMock.updateMaintenanceRequestBid.mockImplementation(async (id: string, p: object) => ({ ...BID_B, id, ...p }));
    storageMock.acceptMaintenanceRequestBid.mockResolvedValue({ ...BID_B, accepted: true });
    storageMock.getMaintenanceContact.mockResolvedValue(undefined);
    storageMock.updateMaintenanceRequest.mockImplementation(async (id: string, p: object) => ({ ...PROJECT, id, ...p }));
  });

  // -- reading ------------------------------------------------------------------

  it("refuses a household leader the bids on a project on their own house, before they are loaded", async () => {
    // The house match is exactly what would otherwise let them through.
    leaderOfHouseA();
    const { status, body } = await get(BIDS("req-project"));
    expect(status).toBe(403);
    expect(storageMock.getMaintenanceRequestBids).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toContain("4200");
  });

  it("refuses staff outside the request's region the bids, before they are loaded", async () => {
    actAs(STAFF, westOnly);
    expect((await get(BIDS("req-east-project"))).status).toBe(403);
    expect(storageMock.getMaintenanceRequestBids).not.toHaveBeenCalled();
  });

  it("refuses a staff account holding no maintenance permission", async () => {
    actAs(STAFF, { allowedRegions: ["West Central"] });
    expect((await get(BIDS("req-project"))).status).toBe(403);
    expect(storageMock.getMaintenanceRequestBids).not.toHaveBeenCalled();
  });

  it("answers 400 for a repair's bids -- a repair has none -- before they are loaded", async () => {
    actAs(STAFF, westOnly);
    const { status, body } = await get(BIDS("req-repair"));
    expect(status).toBe(400);
    expect(body.message).toMatch(/projects and capital projects/i);
    expect(storageMock.getMaintenanceRequestBids).not.toHaveBeenCalled();
  });

  // Positive control for the refusals above: reading needs the view
  // permission, not manage, so an RA who cannot edit still sees who bid.
  it("lists a project's bids for staff in its region, on the view permission", async () => {
    actAs(STAFF, viewOnly);
    const { status, body } = await get(BIDS("req-project"));
    expect(status).toBe(200);
    expect(body.map((b: { id: string }) => b.id)).toEqual(["bid-a", "bid-b"]);
    expect(storageMock.getMaintenanceRequestBids).toHaveBeenCalledWith("req-project");
  });

  // -- recording a bid ------------------------------------------------------------

  it("records a bid on a project for staff in its region, against the request in the URL", async () => {
    actAs(STAFF, westOnly);
    const { status, body } = await post(BIDS("req-project"), {
      vendorName: "Dave's Fencing",
      amount: 4200,
      bidDate: "2026-09-01",
      notes: "Includes the gate.",
      // Never taken from the body: the accept route is the only writer.
      accepted: true,
      requestId: "req-east-project",
    });
    expect(status).toBe(201);
    expect(body.id).toBe("bid-new");
    expect(storageMock.createMaintenanceRequestBid).toHaveBeenCalledTimes(1);
    const written = storageMock.createMaintenanceRequestBid.mock.calls[0][0];
    expect(written).toMatchObject({ requestId: "req-project", vendorName: "Dave's Fencing", amount: "4200", notes: "Includes the gate." });
    expect(written).not.toHaveProperty("accepted");
  });

  it("refuses a bid on a repair as a 400, and writes nothing", async () => {
    actAs(STAFF, westOnly);
    const { status, body } = await post(BIDS("req-repair"), { vendorName: "Dave's Fencing", amount: 4200 });
    expect(status).toBe(400);
    expect(body.message).toMatch(/projects and capital projects/i);
    expect(storageMock.createMaintenanceRequestBid).not.toHaveBeenCalled();
  });

  it("refuses a bid naming neither a contact record nor a vendor, and writes nothing", async () => {
    actAs(STAFF, westOnly);
    const { status, body } = await post(BIDS("req-project"), { amount: 4200 });
    expect(status).toBe(400);
    expect(body.message).toMatch(/contractor|vendor/i);
    expect(storageMock.createMaintenanceRequestBid).not.toHaveBeenCalled();
  });

  it.each([-1, "not-a-number"])("refuses an amount of %s, and writes nothing", async (amount) => {
    actAs(STAFF, westOnly);
    expect((await post(BIDS("req-project"), { vendorName: "Dave's Fencing", amount })).status).toBe(400);
    expect(storageMock.createMaintenanceRequestBid).not.toHaveBeenCalled();
  });

  it("refuses a household leader a bid on a project on their own house, and writes nothing", async () => {
    leaderOfHouseA();
    expect((await post(BIDS("req-project"), { vendorName: "Dave's Fencing", amount: 4200 })).status).toBe(403);
    expect(storageMock.createMaintenanceRequestBid).not.toHaveBeenCalled();
  });

  it("refuses staff outside the region a bid, and writes nothing", async () => {
    actAs(STAFF, westOnly);
    expect((await post(BIDS("req-east-project"), { vendorName: "Dave's Fencing", amount: 4200 })).status).toBe(403);
    expect(storageMock.createMaintenanceRequestBid).not.toHaveBeenCalled();
  });

  it("refuses a view-only staff account a bid, and writes nothing", async () => {
    actAs(STAFF, viewOnly);
    expect((await post(BIDS("req-project"), { vendorName: "Dave's Fencing", amount: 4200 })).status).toBe(403);
    expect(storageMock.createMaintenanceRequestBid).not.toHaveBeenCalled();
  });

  it("links the bid to a contact record in the caller's region, and refuses one that does not exist", async () => {
    actAs(STAFF, westOnly);
    storageMock.getMaintenanceContact.mockResolvedValue({ id: "c-dave", name: "Dave", region: "West Central" });
    const { status } = await post(BIDS("req-project"), { contactId: "c-dave", amount: 4200 });
    expect(status).toBe(201);
    expect(storageMock.createMaintenanceRequestBid).toHaveBeenCalledWith(expect.objectContaining({ contactId: "c-dave" }));

    storageMock.createMaintenanceRequestBid.mockClear();
    storageMock.getMaintenanceContact.mockResolvedValue(undefined);
    expect((await post(BIDS("req-project"), { contactId: "c-nope", amount: 4200 })).status).toBe(400);
    expect(storageMock.createMaintenanceRequestBid).not.toHaveBeenCalled();
  });

  it("refuses a contact record from a region the caller cannot reach, and writes nothing", async () => {
    // Same rule as linking a contractor to a request: a bid must not become
    // a way to attach a vendor the caller could not otherwise open.
    actAs(STAFF, westOnly);
    storageMock.getMaintenanceContact.mockResolvedValue({ id: "c-east", name: "East Co", region: "East Central" });
    expect((await post(BIDS("req-project"), { contactId: "c-east", amount: 4200 })).status).toBe(403);
    expect(storageMock.createMaintenanceRequestBid).not.toHaveBeenCalled();
  });

  // -- the quote document ---------------------------------------------------------

  it("stores a bid document for staff in the region, under the session's account, and records the upload once", async () => {
    // The positive control for every "not read" assertion below: the same
    // route, the same file, and the parser does run, the file is written,
    // and the upload layer records it without the route adding an event.
    actAs(STAFF, westOnly);
    const { status, body } = await postFile(BID_DOCS("req-project"));
    expect(status).toBe(200);
    expect(body.url).toMatch(/^\/uploads\/[0-9a-f]{32}\.pdf$/);
    expect(body.name).toBe("quote.pdf");
    expect(multerEntered).toHaveBeenCalledWith(BID_DOCS("req-project"));
    expect(fileStoreMock.putUpload).toHaveBeenCalled();
    expect(storageMock.createUpload).toHaveBeenCalledWith(expect.objectContaining({ uploadedBy: STAFF.id, originalName: "quote.pdf" }));
    expect(storageMock.createAuditEvent).toHaveBeenCalledTimes(1);
    expect(storageMock.createAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: "document.uploaded", entityType: "upload", actorId: STAFF.id, summary: "Uploaded quote.pdf" }),
    );
  });

  it("refuses a household leader a bid document before the parser reads a byte, and stores nothing", async () => {
    leaderOfHouseA();
    expect((await postFile(BID_DOCS("req-project"))).status).toBe(403);
    expect(multerEntered).not.toHaveBeenCalled();
    expect(fileStoreMock.putUpload).not.toHaveBeenCalled();
    expect(storageMock.createUpload).not.toHaveBeenCalled();
  });

  it("refuses staff outside the region before the parser reads a byte, and stores nothing", async () => {
    actAs(STAFF, westOnly);
    expect((await postFile(BID_DOCS("req-east-project"))).status).toBe(403);
    expect(multerEntered).not.toHaveBeenCalled();
    expect(fileStoreMock.putUpload).not.toHaveBeenCalled();
  });

  it("refuses a view-only staff account before the parser reads a byte", async () => {
    actAs(STAFF, viewOnly);
    expect((await postFile(BID_DOCS("req-project"))).status).toBe(403);
    expect(multerEntered).not.toHaveBeenCalled();
    expect(fileStoreMock.putUpload).not.toHaveBeenCalled();
  });

  it("refuses a document for a repair before the parser reads a byte", async () => {
    actAs(STAFF, westOnly);
    expect((await postFile(BID_DOCS("req-repair"))).status).toBe(400);
    expect(multerEntered).not.toHaveBeenCalled();
    expect(fileStoreMock.putUpload).not.toHaveBeenCalled();
  });

  it("refuses an anonymous caller before the parser reads a byte", async () => {
    expect((await postFile(BID_DOCS("req-project"))).status).toBe(401);
    expect(multerEntered).not.toHaveBeenCalled();
  });

  it("attaches a document the caller uploaded, named as it was stored when the body gives no name", async () => {
    actAs(STAFF, westOnly);
    storageMock.getUploadByStorageKey.mockResolvedValue(uploadRow(STAFF.id));
    const { status } = await post(BIDS("req-project"), { vendorName: "Dave's Fencing", amount: 4200, documentUrl: UPLOAD_URL });
    expect(status).toBe(201);
    expect(storageMock.getUploadByStorageKey).toHaveBeenCalledWith(KEY);
    expect(storageMock.createMaintenanceRequestBid).toHaveBeenCalledWith(
      expect.objectContaining({ documentUrl: UPLOAD_URL, documentName: "quote.pdf" }),
    );
  });

  // A file inherits the visibility of every record that points at it, so a
  // bid naming somebody else's upload would hand that file to everyone who
  // can read the project.
  it("refuses a document somebody else uploaded, and writes nothing", async () => {
    actAs(STAFF, westOnly);
    storageMock.getUploadByStorageKey.mockResolvedValue(uploadRow(ALICE.id));
    expect((await post(BIDS("req-project"), { vendorName: "Dave's Fencing", amount: 4200, documentUrl: UPLOAD_URL })).status).toBe(400);
    expect(storageMock.createMaintenanceRequestBid).not.toHaveBeenCalled();
  });

  it("refuses a document URL on another origin, and writes nothing", async () => {
    actAs(STAFF, westOnly);
    const { status } = await post(BIDS("req-project"), { vendorName: "Dave's Fencing", amount: 4200, documentUrl: "https://evil.example/x.pdf" });
    expect(status).toBe(400);
    expect(storageMock.getUploadByStorageKey).not.toHaveBeenCalled();
    expect(storageMock.createMaintenanceRequestBid).not.toHaveBeenCalled();
  });

  // -- accepting ------------------------------------------------------------------

  it("accepting a bid un-accepts the others on the request, in one storage call", async () => {
    // One call, not a loop of updates: a house must never be left with two
    // accepted bids because the second write failed.
    actAs(STAFF, westOnly);
    const { status, body } = await post(`${BID("bid-b")}/accept`, {});
    expect(status).toBe(200);
    expect(body.accepted).toBe(true);
    expect(storageMock.acceptMaintenanceRequestBid).toHaveBeenCalledTimes(1);
    expect(storageMock.acceptMaintenanceRequestBid).toHaveBeenCalledWith("req-project", "bid-b");
    expect(storageMock.updateMaintenanceRequestBid).not.toHaveBeenCalled();
  });

  it("answers 404, not a made-up acceptance, when the bid vanished between the lookup and the write", async () => {
    actAs(STAFF, westOnly);
    storageMock.acceptMaintenanceRequestBid.mockResolvedValue(undefined);
    const { status, body } = await post(`${BID("bid-b")}/accept`, {});
    expect(status).toBe(404);
    expect(body).not.toHaveProperty("accepted");
  });

  it("refuses staff outside the region an accept, and changes nothing", async () => {
    actAs(STAFF, westOnly);
    expect((await post(`${BID("bid-east")}/accept`, {})).status).toBe(403);
    expect(storageMock.acceptMaintenanceRequestBid).not.toHaveBeenCalled();
  });

  it("refuses a household leader an accept, and changes nothing", async () => {
    leaderOfHouseA();
    expect((await post(`${BID("bid-b")}/accept`, {})).status).toBe(403);
    expect(storageMock.acceptMaintenanceRequestBid).not.toHaveBeenCalled();
  });

  // -- editing ---------------------------------------------------------------------

  it("updates a bid for staff in its region, and never its accepted flag", async () => {
    actAs(STAFF, westOnly);
    const { status } = await patch(BID("bid-b"), { amount: 3850, accepted: true });
    expect(status).toBe(200);
    expect(storageMock.updateMaintenanceRequestBid).toHaveBeenCalledTimes(1);
    const [id, written] = storageMock.updateMaintenanceRequestBid.mock.calls[0];
    expect(id).toBe("bid-b");
    expect(written).toMatchObject({ amount: "3850" });
    expect(written).not.toHaveProperty("accepted");
  });

  it("refuses clearing the vendor name on a bid with no contact record, and writes nothing", async () => {
    actAs(STAFF, westOnly);
    expect((await patch(BID("bid-b"), { vendorName: "" })).status).toBe(400);
    expect(storageMock.updateMaintenanceRequestBid).not.toHaveBeenCalled();
  });

  it("answers 400, not 500, to an edit carrying nothing it may change (#163)", async () => {
    // The schema strips accepted, requestId and id, which would leave an empty
    // update for the database to refuse.
    actAs(STAFF, westOnly);
    expect((await patch(BID("bid-b"), { accepted: true, requestId: "req-other" })).status).toBe(400);
    expect(storageMock.updateMaintenanceRequestBid).not.toHaveBeenCalled();
  });

  it("refuses staff outside the region an edit, and writes nothing", async () => {
    actAs(STAFF, westOnly);
    expect((await patch(BID("bid-east"), { amount: 1 })).status).toBe(403);
    expect(storageMock.updateMaintenanceRequestBid).not.toHaveBeenCalled();
  });

  it("refuses a household leader an edit, and writes nothing", async () => {
    leaderOfHouseA();
    expect((await patch(BID("bid-b"), { amount: 1 })).status).toBe(403);
    expect(storageMock.updateMaintenanceRequestBid).not.toHaveBeenCalled();
  });

  // -- deleting --------------------------------------------------------------------

  it("removes the bid and its document", async () => {
    // Known issue 1, closed for bids (JR, 2026-09-28): the confirmation says
    // the document goes too.
    actAs(STAFF, westOnly);
    storageMock.getMaintenanceRequestBid.mockResolvedValue({ ...BID_B, documentUrl: UPLOAD_URL, documentName: "quote.pdf" });
    storageMock.deleteMaintenanceRequestBid.mockResolvedValue([UPLOAD_URL]);
    expect((await del(BID("bid-b"))).status).toBe(200);
    expect(storageMock.deleteMaintenanceRequestBid).toHaveBeenCalledWith("bid-b");
    expect(fileStoreMock.removeUpload).toHaveBeenCalledWith(KEY);
    expect(storageMock.deleteUpload).toHaveBeenCalledWith(KEY);
  });

  it("removes the bid and keeps a document another record still points at", async () => {
    actAs(STAFF, westOnly);
    storageMock.getMaintenanceRequestBid.mockResolvedValue({ ...BID_B, documentUrl: UPLOAD_URL, documentName: "quote.pdf" });
    storageMock.deleteMaintenanceRequestBid.mockResolvedValue([UPLOAD_URL]);
    storageMock.findUploadReferences.mockResolvedValue([{ kind: "maintenanceRequestBid", record: BID_A }]);
    expect((await del(BID("bid-b"))).status).toBe(200);
    expect(storageMock.deleteMaintenanceRequestBid).toHaveBeenCalledWith("bid-b");
    expect(storageMock.findUploadReferences).toHaveBeenCalledWith(UPLOAD_URL);
    expect(fileStoreMock.removeUpload).not.toHaveBeenCalled();
    expect(storageMock.deleteUpload).not.toHaveBeenCalled();
  });

  it("refuses a household leader a delete, and removes nothing", async () => {
    leaderOfHouseA();
    expect((await del(BID("bid-b"))).status).toBe(403);
    expect(storageMock.deleteMaintenanceRequestBid).not.toHaveBeenCalled();
  });

  it("refuses staff outside the region a delete, and removes nothing", async () => {
    actAs(STAFF, westOnly);
    expect((await del(BID("bid-east"))).status).toBe(403);
    expect(storageMock.deleteMaintenanceRequestBid).not.toHaveBeenCalled();
  });

  // -- the project fields on the request itself -------------------------------------

  it("stores the contract link, costs and target period on a project", async () => {
    actAs(STAFF, westOnly);
    const { status } = await patch(`/api/maintenance-requests/req-project`, {
      contractUrl: "https://drive.google.com/file/d/abc/view",
      estimatedCost: 4200,
      actualCost: "4350.50",
      targetYear: 2027,
      targetQuarter: 2,
    });
    expect(status).toBe(200);
    expect(storageMock.updateMaintenanceRequest).toHaveBeenCalledWith(
      "req-project",
      expect.objectContaining({
        contractUrl: "https://drive.google.com/file/d/abc/view",
        estimatedCost: "4200",
        actualCost: "4350.5",
        targetYear: 2027,
        targetQuarter: 2,
      }),
    );
  });

  it.each([
    ["estimatedCost", 4200],
    ["actualCost", 4350],
    ["contractUrl", "https://drive.google.com/file/d/abc/view"],
    ["targetYear", 2027],
  ])("refuses %s on a repair as a 400, and writes nothing", async (field, value) => {
    actAs(STAFF, westOnly);
    const { status, body } = await patch(`/api/maintenance-requests/req-repair`, { [field]: value });
    expect(status).toBe(400);
    expect(body.message).toMatch(/only projects and capital projects/i);
    expect(storageMock.updateMaintenanceRequest).not.toHaveBeenCalled();
  });

  it("refuses them in the same edit that turns a project back into a repair", async () => {
    actAs(STAFF, westOnly);
    expect((await patch(`/api/maintenance-requests/req-project`, { type: "request", estimatedCost: 4200 })).status).toBe(400);
    expect(storageMock.updateMaintenanceRequest).not.toHaveBeenCalled();
  });

  it("clears them when a project is turned back into a repair, so a repair never carries a cost", async () => {
    actAs(STAFF, westOnly);
    const { status } = await patch(`/api/maintenance-requests/req-capex`, { type: "request" });
    expect(status).toBe(200);
    expect(storageMock.updateMaintenanceRequest).toHaveBeenCalledWith(
      "req-capex",
      expect.objectContaining({ type: "request", contractUrl: null, estimatedCost: null, actualCost: null, targetYear: null, targetQuarter: null }),
    );
  });

  it("refuses a javascript: contract link, and writes nothing", async () => {
    // The project card renders the contract link straight into an href.
    actAs(STAFF, westOnly);
    expect((await patch(`/api/maintenance-requests/req-project`, { contractUrl: "javascript:alert(1)" })).status).toBe(400);
    expect(storageMock.updateMaintenanceRequest).not.toHaveBeenCalled();
  });

  it("reads an emptied contract link as cleared", async () => {
    actAs(STAFF, westOnly);
    expect((await patch(`/api/maintenance-requests/req-project`, { contractUrl: "" })).status).toBe(200);
    expect(storageMock.updateMaintenanceRequest).toHaveBeenCalledWith("req-project", expect.objectContaining({ contractUrl: null }));
  });

  it("refuses a quarter without a year, and writes nothing", async () => {
    actAs(STAFF, westOnly);
    const { status, body } = await patch(`/api/maintenance-requests/req-project`, { targetQuarter: 2 });
    expect(status).toBe(400);
    expect(body.message).toMatch(/year/i);
    expect(storageMock.updateMaintenanceRequest).not.toHaveBeenCalled();
  });

  it("takes the year from the row when only the quarter is sent", async () => {
    // Positive control for the rule above: CAPEX already carries 2027.
    actAs(STAFF, westOnly);
    expect((await patch(`/api/maintenance-requests/req-capex`, { targetQuarter: 3 })).status).toBe(200);
    expect(storageMock.updateMaintenanceRequest).toHaveBeenCalledWith("req-capex", expect.objectContaining({ targetQuarter: 3 }));
  });

  it("refuses clearing the year while a quarter stays, and writes nothing", async () => {
    actAs(STAFF, westOnly);
    storageMock.getMaintenanceRequest.mockResolvedValue({ ...CAPEX, targetQuarter: 2 });
    expect((await patch(`/api/maintenance-requests/req-capex`, { targetYear: null })).status).toBe(400);
    expect(storageMock.updateMaintenanceRequest).not.toHaveBeenCalled();
  });

  it.each([
    ["targetQuarter", 0],
    ["targetQuarter", 5],
    ["targetYear", 1999],
    ["targetYear", 2101],
    ["estimatedCost", -1],
  ])("refuses %s = %s, and writes nothing", async (field, value) => {
    actAs(STAFF, westOnly);
    expect((await patch(`/api/maintenance-requests/req-capex`, { [field]: value })).status).toBe(400);
    expect(storageMock.updateMaintenanceRequest).not.toHaveBeenCalled();
  });

  it("records the contract link changing, naming the request and never the link", async () => {
    // A document link, like the lease link on a property -- but the URL is
    // what somebody could follow, so the event says that it changed and not
    // to what.
    actAs(STAFF, westOnly);
    const { status } = await patch(`/api/maintenance-requests/req-project`, { contractUrl: "https://drive.google.com/file/d/abc/view" });
    expect(status).toBe(200);
    expect(storageMock.createAuditEvent).toHaveBeenCalledTimes(1);
    const event = storageMock.createAuditEvent.mock.calls[0][0];
    expect(event).toMatchObject({
      action: "maintenance_request.documents_changed",
      entityType: "maintenance_request",
      entityId: "req-project",
      summary: expect.stringContaining("New back fence"),
    });
    expect(JSON.stringify(event)).not.toContain("drive.google.com");
  });

  it("stays quiet when a cost or the target period changes: an estimate is not money moving", async () => {
    actAs(STAFF, westOnly);
    await patch(`/api/maintenance-requests/req-project`, { estimatedCost: 4200, targetYear: 2027 });
    expect(storageMock.createAuditEvent).not.toHaveBeenCalled();
  });

  it("stays quiet when the contract link is sent unchanged", async () => {
    actAs(STAFF, westOnly);
    storageMock.getMaintenanceRequest.mockResolvedValue({ ...PROJECT, contractUrl: "https://drive.google.com/file/d/abc/view" });
    await patch(`/api/maintenance-requests/req-project`, { contractUrl: "https://drive.google.com/file/d/abc/view", estimatedCost: 1 });
    expect(storageMock.createAuditEvent).not.toHaveBeenCalled();
  });

  // Residents cannot PATCH a request at all -- the route is requireStaff --
  // so "a resident can never set a project field" is the existing refusal,
  // with the write never reaching storage.
  it("refuses a household leader the project fields: the PATCH is refused and nothing is written", async () => {
    leaderOfHouseA();
    expect((await patch(`/api/maintenance-requests/req-project`, { estimatedCost: 1 })).status).toBe(403);
    expect(storageMock.updateMaintenanceRequest).not.toHaveBeenCalled();
  });
});

/**
 * A record that points at another record must not point somewhere the caller
 * cannot reach. Linking a contact to a request already checks both sides
 * (resolveContactLink); an invoice's contact, request and house, and a
 * comment's relayed contractor, now do too. Each refusal is paired with the
 * write never happening and a positive control in the caller's own region.
 */
describe("a reference to another record is checked against the caller's regions", () => {
  const westBilling = { canViewBilling: true, canManageBilling: true, allowedRegions: ["West Central"] };
  const WEST_CONTACT = { id: "ct-west", name: "Dave", region: "West Central" };
  const EAST_CONTACT = { id: "ct-east", name: "Eve", region: "East Central" };
  const WEST_REQ = { ...WEST_REQUEST, id: "req-w", buildingAddress: "1 Main St" };
  const EAST_REQ = { ...EAST_REQUEST, id: "req-e", buildingAddress: "5 East St" };
  const HOUSES: Record<string, unknown> = {
    "1 Main St": { id: "prop-w", region: "West Central", address: "1 Main St" },
    "5 East St": { id: "prop-e", region: "East Central", address: "5 East St" },
  };
  const INVOICE = {
    invoiceNumber: "INV-1",
    service: "Plumbing",
    amount: "120.00",
    dueDate: "2026-10-01",
    status: "pending",
    region: "West Central",
    buildingAddress: "1 Main St",
  };
  const EXISTING_INVOICE = { id: "inv-1", ...INVOICE, contactId: EAST_CONTACT.id, maintenanceRequestId: null };

  beforeEach(() => {
    const contacts: Record<string, unknown> = { [WEST_CONTACT.id]: WEST_CONTACT, [EAST_CONTACT.id]: EAST_CONTACT };
    const requests: Record<string, unknown> = { [WEST_REQ.id]: WEST_REQ, [EAST_REQ.id]: EAST_REQ };
    storageMock.getMaintenanceContact.mockImplementation(async (id: string) => contacts[id]);
    storageMock.getMaintenanceRequest.mockImplementation(async (id: string) => requests[id]);
    storageMock.getPropertyByAddress.mockImplementation(async (address: string) => HOUSES[address]);
    storageMock.createInvoice.mockImplementation(async (i: unknown) => ({ id: "inv-new", ...(i as object) }));
    storageMock.getInvoice.mockResolvedValue(EXISTING_INVOICE);
    storageMock.updateInvoice.mockImplementation(async (_id: string, i: unknown) => ({ ...EXISTING_INVOICE, ...(i as object) }));
    storageMock.createMaintenanceRequestComment.mockImplementation(async (c: unknown) => ({ id: "c-new", ...(c as object) }));
  });

  it.each([
    ["a contact in another region", { contactId: EAST_CONTACT.id }, 403],
    ["a request in another region", { maintenanceRequestId: EAST_REQ.id }, 403],
    ["a house in another region", { buildingAddress: "5 East St" }, 403],
    ["a contact that does not exist", { contactId: "ct-nope" }, 400],
    ["a request that does not exist", { maintenanceRequestId: "req-nope" }, 400],
    ["an address that is not a house", { buildingAddress: "9 Nowhere Ln" }, 400],
  ])("refuses an invoice naming %s, and writes nothing", async (_name, reference, expected) => {
    actAs(STAFF, westBilling);
    expect((await request("POST", "/api/invoices", { body: { ...INVOICE, ...reference } })).status).toBe(expected);
    expect(storageMock.createInvoice).not.toHaveBeenCalled();
  });

  it("stores an invoice whose contact, request and house are in the caller's region -- the positive control", async () => {
    actAs(STAFF, westBilling);
    const { status } = await request("POST", "/api/invoices", {
      body: { ...INVOICE, contactId: WEST_CONTACT.id, maintenanceRequestId: WEST_REQ.id },
    });
    expect(status).toBe(200);
    expect(storageMock.createInvoice).toHaveBeenCalledWith(expect.objectContaining({ contactId: WEST_CONTACT.id, maintenanceRequestId: WEST_REQ.id }));
  });

  it("refuses an invoice edit that repoints it at another region's request, and writes nothing", async () => {
    actAs(STAFF, westBilling);
    expect((await request("PATCH", "/api/invoices/inv-1", { body: { maintenanceRequestId: EAST_REQ.id } })).status).toBe(403);
    expect(storageMock.updateInvoice).not.toHaveBeenCalled();
  });

  // The existing invoice already names an East contact (an admin may have
  // linked it). Resending that unchanged value is not a new reference.
  it("lets an invoice edit resend the contact it already names, and change its status", async () => {
    actAs(STAFF, westBilling);
    const { status } = await request("PATCH", "/api/invoices/inv-1", { body: { contactId: EAST_CONTACT.id, status: "paid" } });
    expect(status).toBe(200);
    expect(storageMock.updateInvoice).toHaveBeenCalledWith("inv-1", expect.objectContaining({ status: "paid" }));
  });

  it("refuses a comment relaying a contractor from another region, and writes nothing", async () => {
    actAs(STAFF, { ...ALL_MAINTENANCE, allowedRegions: ["West Central"] });
    const { status } = await request("POST", `/api/maintenance-requests/${WEST_REQ.id}/comments`, {
      body: { body: "He says Thursday.", relaySource: "Eve", relayContactId: EAST_CONTACT.id },
    });
    expect(status).toBe(403);
    expect(storageMock.createMaintenanceRequestComment).not.toHaveBeenCalled();
  });

  it("refuses a comment relaying a contractor that does not exist, and writes nothing", async () => {
    actAs(STAFF, { ...ALL_MAINTENANCE, allowedRegions: ["West Central"] });
    const { status } = await request("POST", `/api/maintenance-requests/${WEST_REQ.id}/comments`, {
      body: { body: "He says Thursday.", relaySource: "Eve", relayContactId: "ct-nope" },
    });
    expect(status).toBe(400);
    expect(storageMock.createMaintenanceRequestComment).not.toHaveBeenCalled();
  });

  it("stores a comment relaying a contractor in the caller's region -- the positive control", async () => {
    actAs(STAFF, { ...ALL_MAINTENANCE, allowedRegions: ["West Central"] });
    const { status } = await request("POST", `/api/maintenance-requests/${WEST_REQ.id}/comments`, {
      body: { body: "He says Thursday.", relaySource: "Dave", relayContactId: WEST_CONTACT.id },
    });
    expect(status).toBe(201);
    expect(storageMock.createMaintenanceRequestComment).toHaveBeenCalledWith(expect.objectContaining({ relayContactId: WEST_CONTACT.id }));
  });
});

describe("submitting a maintenance request", () => {
  const body = {
    title: "Leaky tap",
    description: "The kitchen tap drips overnight.",
    category: "plumbing",
    priority: "medium",
    location: "Kitchen",
  };

  it("files a resident's request against their roster house, ignoring region/submitter in the body", async () => {
    actAs(ALICE, ALL_MAINTENANCE);
    storageMock.getActiveResidentByEmail.mockResolvedValue({ region: "West Central", buildingAddress: "1 Main St" });
    storageMock.createMaintenanceRequest.mockImplementation(async (data: Record<string, unknown>) => ({ id: "new", ...data }));

    const { status } = await request("POST", "/api/maintenance-requests", {
      body: { ...body, region: "East Central", buildingAddress: "9 Evil Rd", submittedBy: "evil@example.com" },
    });

    expect(status).toBe(200);
    // House + region come from the roster; the submitter is the session, not the body.
    expect(storageMock.createMaintenanceRequest).toHaveBeenCalledWith(
      expect.objectContaining({ region: "West Central", buildingAddress: "1 Main St", submittedBy: ALICE.email }),
    );
    const created = storageMock.createMaintenanceRequest.mock.calls[0][0];
    expect(created.region).not.toBe("East Central");
  });

  it("files a resident's request as a repair whatever type the body claims", async () => {
    // A resident can never file a project: the type is forced server-side,
    // the same way region and submitter are.
    actAs(ALICE, ALL_MAINTENANCE);
    storageMock.getActiveResidentByEmail.mockResolvedValue({ region: "West Central", buildingAddress: "1 Main St" });
    storageMock.createMaintenanceRequest.mockImplementation(async (data: Record<string, unknown>) => ({ id: "new", ...data }));

    const { status } = await request("POST", "/api/maintenance-requests", { body: { ...body, type: "capex" } });

    expect(status).toBe(200);
    expect(storageMock.createMaintenanceRequest).toHaveBeenCalledWith(expect.objectContaining({ type: "request" }));
    const created = storageMock.createMaintenanceRequest.mock.calls[0][0];
    expect(created.type).not.toBe("capex");
  });

  // A resident reports a problem; whether it is in hand or done is staff's
  // call. A request filed already closed would never show as open work.
  it("files a resident's request as pending whatever status the body claims, with no close date", async () => {
    actAs(ALICE, ALL_MAINTENANCE);
    storageMock.getActiveResidentByEmail.mockResolvedValue({ region: "West Central", buildingAddress: "1 Main St" });
    storageMock.createMaintenanceRequest.mockImplementation(async (data: Record<string, unknown>) => ({ id: "new", ...data }));

    for (const status of ["completed", "in_progress", "cancelled"]) {
      expect((await request("POST", "/api/maintenance-requests", { body: { ...body, status } })).status, status).toBe(200);
    }
    for (const [created] of storageMock.createMaintenanceRequest.mock.calls) {
      expect(created.status).toBe("pending");
      expect(created.completedDate).toBeUndefined();
    }
    expect(storageMock.createMaintenanceRequest).toHaveBeenCalledTimes(3);
  });

  it("stores a closed status when staff file a request already resolved -- the positive control", async () => {
    actAs(ADMIN);
    storageMock.getPropertyByAddress.mockResolvedValue({ id: "prop-1", region: "West Central", address: "1 Main St" });
    storageMock.createMaintenanceRequest.mockImplementation(async (data: Record<string, unknown>) => ({ id: "new", ...data }));
    const { status } = await request("POST", "/api/maintenance-requests", {
      body: { ...body, region: "West Central", buildingAddress: "1 Main St", status: "completed" },
    });
    expect(status).toBe(200);
    expect(storageMock.createMaintenanceRequest).toHaveBeenCalledWith(expect.objectContaining({ status: "completed", completedDate: expect.any(Date) }));
  });

  it("files a resident's request as a repair when the body says nothing about type", async () => {
    actAs(ALICE, ALL_MAINTENANCE);
    storageMock.getActiveResidentByEmail.mockResolvedValue({ region: "West Central", buildingAddress: "1 Main St" });
    storageMock.createMaintenanceRequest.mockImplementation(async (data: Record<string, unknown>) => ({ id: "new", ...data }));

    expect((await request("POST", "/api/maintenance-requests", { body })).status).toBe(200);
    expect(storageMock.createMaintenanceRequest).toHaveBeenCalledWith(expect.objectContaining({ type: "request" }));
  });

  // Positive control: the same body from staff stores the type it names.
  it("stores the type staff choose when they file one", async () => {
    actAs(STAFF, { ...ALL_MAINTENANCE, allowedRegions: ["West Central"] });
    storageMock.createMaintenanceRequest.mockImplementation(async (data: Record<string, unknown>) => ({ id: "new", ...data }));
    storageMock.getPropertyByAddress.mockResolvedValue({ address: "1 Main St", region: "West Central" });

    const { status } = await request("POST", "/api/maintenance-requests", {
      body: { ...body, region: "West Central", buildingAddress: "1 Main St", type: "capex" },
    });

    expect(status).toBe(200);
    expect(storageMock.createMaintenanceRequest).toHaveBeenCalledWith(expect.objectContaining({ type: "capex" }));
  });

  it("refuses a resident who is not on any house roster, with a helpful message", async () => {
    actAs(ALICE, ALL_MAINTENANCE);
    storageMock.getActiveResidentByEmail.mockResolvedValue(undefined);

    const { status, body: resBody } = await request("POST", "/api/maintenance-requests", { body });

    expect(status).toBe(400);
    expect(resBody.message).toMatch(/house on file/i);
    expect(storageMock.createMaintenanceRequest).not.toHaveBeenCalled();
  });

  it("files a staff member's request into a region they can reach, session as submitter", async () => {
    actAs(STAFF, { ...ALL_MAINTENANCE, allowedRegions: ["West Central"] });
    storageMock.createMaintenanceRequest.mockImplementation(async (data: Record<string, unknown>) => ({ id: "new", ...data }));
    storageMock.getPropertyByAddress.mockResolvedValue({ address: "1 Main St", region: "West Central" });

    const { status } = await request("POST", "/api/maintenance-requests", {
      body: { ...body, region: "West Central", buildingAddress: "1 Main St", submittedBy: "spoof@example.com" },
    });

    expect(status).toBe(200);
    expect(storageMock.createMaintenanceRequest).toHaveBeenCalledWith(
      expect.objectContaining({ region: "West Central", submittedBy: STAFF.email }),
    );
  });

  it("refuses a staff member filing into a region they cannot reach", async () => {
    actAs(STAFF, { ...ALL_MAINTENANCE, allowedRegions: ["West Central"] });
    storageMock.getPropertyByAddress.mockResolvedValue({ address: "9 Elm", region: "East Central" });

    const { status } = await request("POST", "/api/maintenance-requests", {
      body: { ...body, region: "East Central", buildingAddress: "9 Elm" },
    });

    expect(status).toBe(403);
    expect(storageMock.createMaintenanceRequest).not.toHaveBeenCalled();
  });

  it("takes the region from the house, not the body, when staff file one", async () => {
    // An admin who picks a Northwest house and then a Northeast region would
    // otherwise hide the request from the Northwest RA.
    actAs(ADMIN);
    storageMock.getPropertyByAddress.mockResolvedValue({ address: "9 Elm", region: "East Central" });
    storageMock.createMaintenanceRequest.mockImplementation(async (data: Record<string, unknown>) => ({ id: "new", ...data }));

    const { status } = await request("POST", "/api/maintenance-requests", {
      body: { ...body, region: "West Central", buildingAddress: "9 Elm" },
    });

    expect(status).toBe(200);
    expect(storageMock.createMaintenanceRequest).toHaveBeenCalledWith(expect.objectContaining({ region: "East Central" }));
  });

  it("refuses a staff request for an address that is not a house", async () => {
    actAs(ADMIN);
    storageMock.getPropertyByAddress.mockResolvedValue(undefined);

    const { status } = await request("POST", "/api/maintenance-requests", {
      body: { ...body, region: "West Central", buildingAddress: "1 Nowhere Rd" },
    });

    expect(status).toBe(400);
    expect(storageMock.getPropertyByAddress).toHaveBeenCalledWith("1 Nowhere Rd");
    expect(storageMock.createMaintenanceRequest).not.toHaveBeenCalled();
  });

  it("refuses re-pointing a request at a house in a region the RA cannot reach", async () => {
    actAs(STAFF, { ...ALL_MAINTENANCE, allowedRegions: ["West Central"] });
    storageMock.getMaintenanceRequest.mockResolvedValue({ id: "r1", type: "request", status: "pending", region: "West Central", buildingAddress: "1 Main St" });
    storageMock.getPropertyByAddress.mockResolvedValue({ address: "9 Elm", region: "East Central" });

    const { status } = await request("PATCH", "/api/maintenance-requests/r1", { body: { buildingAddress: "9 Elm" } });

    expect(status).toBe(403);
    expect(storageMock.updateMaintenanceRequest).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 6. Uploads are refused before any bytes are read
// ---------------------------------------------------------------------------

describe("who may upload a file", () => {
  const aFile = () => {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], { type: "image/jpeg" }), "photo.jpg");
    return form;
  };

  async function postFile(path: string) {
    const res = await fetch(`${baseUrl}${path}`, { method: "POST", body: aFile() });
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  }

  it("refuses a resident, and stores nothing", async () => {
    actAs(ALICE, ALL_MAINTENANCE);
    const { status, body } = await postFile("/api/upload");
    expect(status).toBe(403);
    expect(body.message).toMatch(/residents/i);
    expect(fileStoreMock.putUpload).not.toHaveBeenCalled();
    expect(storageMock.createUpload).not.toHaveBeenCalled();
  });

  it("refuses a resident on the document endpoint too", async () => {
    actAs(ALICE, ALL_MAINTENANCE);
    const { status } = await postFile("/api/upload-doc");
    expect(status).toBe(403);
    expect(fileStoreMock.putUpload).not.toHaveBeenCalled();
  });

  it("refuses a deactivated account, and stores nothing", async () => {
    actAs(DISABLED, ALL_MAINTENANCE);
    const { status, body } = await postFile("/api/upload");
    expect(status).toBe(403);
    expect(body.message).toMatch(/not active/i);
    expect(fileStoreMock.putUpload).not.toHaveBeenCalled();
  });

  it("refuses an anonymous caller, and stores nothing", async () => {
    const { status } = await postFile("/api/upload");
    expect(status).toBe(401);
    expect(fileStoreMock.putUpload).not.toHaveBeenCalled();
  });

  it("lets staff through the permission gate", async () => {
    // The counterpart to the refusals above: the same request from a member of
    // staff does reach the point where the file is written, so the assertions
    // above are about the guard rather than about the request being malformed.
    actAs(STAFF, { ...ALL_MAINTENANCE, allowedRegions: ["West Central"] });
    const { status } = await postFile("/api/upload");
    expect(status).toBe(200);
    expect(fileStoreMock.putUpload).toHaveBeenCalled();
  });

  // ── The body must never be read for a caller who is going to be refused ────
  //
  // Storing nothing is not the same as reading nothing. If the multipart parser
  // were placed ahead of the permission check, every test above would still
  // pass while the server happily buffered the whole upload from someone who
  // had no right to send it.

  it("proves the instrumentation works: an accepted upload does reach the parser", async () => {
    // Without this, the three assertions below could pass simply because the
    // spy was never wired up correctly.
    actAs(STAFF, { ...ALL_MAINTENANCE, allowedRegions: ["West Central"] });
    await postFile("/api/upload");
    expect(multerEntered).toHaveBeenCalledWith("/api/upload");
  });

  it("does not read a resident's request body", async () => {
    actAs(ALICE, ALL_MAINTENANCE);
    await postFile("/api/upload");
    expect(multerEntered).not.toHaveBeenCalled();
  });

  it("does not read a deactivated account's request body", async () => {
    actAs(DISABLED, ALL_MAINTENANCE);
    await postFile("/api/upload");
    expect(multerEntered).not.toHaveBeenCalled();
  });

  it("does not read an anonymous request body", async () => {
    await postFile("/api/upload");
    expect(multerEntered).not.toHaveBeenCalled();
  });

  it("does not read a refused body on the document endpoint either", async () => {
    actAs(ALICE, ALL_MAINTENANCE);
    await postFile("/api/upload-doc");
    expect(multerEntered).not.toHaveBeenCalled();
  });

  // ── Staff need a flag for a screen that uploads through the route ────────
  //
  // Being staff is not enough on its own. /api/upload serves the request,
  // walkthrough, asset and house photo fields; /api/upload-doc serves the
  // billing documents. An account holding none of the flags behind those
  // screens has nothing to attach a file to, so it may not store one.

  const unrelatedOnly = { canViewContacts: true, canViewProperties: true, canViewAssets: true, allowedRegions: ["West Central"] };

  it.each(["/api/upload", "/api/upload-doc"])("refuses %s to staff holding no flag that uses it, before reading the body", async (path) => {
    actAs(STAFF, unrelatedOnly);
    const { status } = await postFile(path);
    expect(status).toBe(403);
    expect(multerEntered).not.toHaveBeenCalled();
    expect(fileStoreMock.putUpload).not.toHaveBeenCalled();
  });

  it("refuses the document endpoint to staff who manage maintenance but not billing", async () => {
    actAs(STAFF, { ...ALL_MAINTENANCE, allowedRegions: ["West Central"] });
    expect((await postFile("/api/upload-doc")).status).toBe(403);
    expect(multerEntered).not.toHaveBeenCalled();
  });

  it.each(["canViewMaintenance", "canManageMaintenance", "canManageWalkthroughs", "canManageAssets", "canManageProperties"])(
    "lets staff holding %s store an image",
    async (flag) => {
      actAs(STAFF, { [flag]: true, allowedRegions: ["West Central"] });
      expect((await postFile("/api/upload")).status).toBe(200);
      expect(fileStoreMock.putUpload).toHaveBeenCalled();
    },
  );

  it("lets staff who manage billing store a document", async () => {
    actAs(STAFF, { canManageBilling: true, allowedRegions: ["West Central"] });
    expect((await postFile("/api/upload-doc")).status).toBe(200);
    expect(fileStoreMock.putUpload).toHaveBeenCalled();
  });

  it("lets an admin with no permissions row store either kind", async () => {
    actAs(ADMIN);
    expect((await postFile("/api/upload")).status).toBe(200);
    expect((await postFile("/api/upload-doc")).status).toBe(200);
  });

  it("records who stored the file, taken from the session rather than the body", async () => {
    actAs(STAFF, { ...ALL_MAINTENANCE, allowedRegions: ["West Central"] });
    await postFile("/api/upload");
    expect(storageMock.createUpload).toHaveBeenCalledWith(
      expect.objectContaining({ uploadedBy: STAFF.id }),
    );
  });
});

// ---------------------------------------------------------------------------
// 7. Downloading a file
// ---------------------------------------------------------------------------

describe("file keys that try to escape the uploads area", () => {
  const traversals = [
    ["an encoded slash", "..%2F..%2Fetc%2Fpasswd"],
    ["an encoded backslash", "..%5C..%5Cwindows%5Csystem32"],
    ["a hidden file", ".env"],
    ["a nested path", "subdir%2Fsecret.pdf"],
    ["a null byte", "photo.jpg%00.txt"],
  ];

  it.each(traversals)("rejects %s with 400", async (_label, key) => {
    actAs(STAFF, { ...ALL_MAINTENANCE, allowedRegions: ["West Central"] });
    const { status } = await get(`/uploads/${key}`);
    expect(status).toBe(400);
  });

  it("never reaches the file store for any of them", async () => {
    actAs(STAFF, { ...ALL_MAINTENANCE, allowedRegions: ["West Central"] });
    for (const [, key] of traversals) {
      await get(`/uploads/${key}`);
    }
    expect(fileStoreMock.openUploadStream).not.toHaveBeenCalled();
    expect(fileStoreMock.createUploadSignedUrl).not.toHaveBeenCalled();
    expect(fileStoreMock.uploadExists).not.toHaveBeenCalled();
  });

  it("checks the caller before it checks the key", async () => {
    // An anonymous caller learns nothing about which keys are well-formed.
    const { status } = await get("/uploads/..%2F..%2Fetc%2Fpasswd");
    expect(status).toBe(401);
  });

  it("never routes a bare parent-directory segment in the first place", async () => {
    // Express resolves `/uploads/..` to `/` before matching, so this one is
    // refused a step earlier than the key check. Asserted so that a future
    // change of router or mount point cannot quietly turn it into a hit.
    actAs(STAFF, { ...ALL_MAINTENANCE, allowedRegions: ["West Central"] });
    for (const key of ["%2E%2E", ".%2E", "..%2F"]) {
      const { status } = await get(`/uploads/${key}`);
      expect(status).not.toBe(200);
    }
    expect(fileStoreMock.openUploadStream).not.toHaveBeenCalled();
  });
});

describe("downloading someone else's file", () => {
  const KEY = "0123456789abcdef0123456789abcdef.jpg";

  it("refuses a resident a photo attached to another resident's request", async () => {
    actAs(BOB, ALL_MAINTENANCE);
    storageMock.getUploadByStorageKey.mockResolvedValue({ storageKey: KEY, uploadedBy: ALICE.id });
    storageMock.findUploadReferences.mockResolvedValue([
      { kind: "maintenanceRequest", record: WEST_REQUEST },
    ]);

    const { status } = await get(`/uploads/${KEY}`);

    expect(status).toBe(403);
    expect(fileStoreMock.openUploadStream).not.toHaveBeenCalled();
  });

  it("refuses staff a photo attached to a request outside their regions", async () => {
    actAs(STAFF, { ...ALL_MAINTENANCE, allowedRegions: ["West Central"] });
    storageMock.getUploadByStorageKey.mockResolvedValue({ storageKey: KEY, uploadedBy: ADMIN.id });
    storageMock.findUploadReferences.mockResolvedValue([
      { kind: "maintenanceRequest", record: EAST_REQUEST },
    ]);

    const { status } = await get(`/uploads/${KEY}`);

    expect(status).toBe(403);
    expect(fileStoreMock.openUploadStream).not.toHaveBeenCalled();
  });

  it("refuses a file that nothing points at and somebody else uploaded", async () => {
    actAs(BOB, ALL_MAINTENANCE);
    storageMock.getUploadByStorageKey.mockResolvedValue({ storageKey: KEY, uploadedBy: ALICE.id });
    storageMock.findUploadReferences.mockResolvedValue([]);

    expect((await get(`/uploads/${KEY}`)).status).toBe(403);
  });

  it("lets the resident who submitted the request read its photo", async () => {
    actAs(ALICE, ALL_MAINTENANCE);
    storageMock.getUploadByStorageKey.mockResolvedValue({ storageKey: KEY, uploadedBy: STAFF.id });
    storageMock.findUploadReferences.mockResolvedValue([
      { kind: "maintenanceRequest", record: WEST_REQUEST },
    ]);

    const res = await fetch(`${baseUrl}/uploads/${KEY}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("private");
  });

  it("refuses before checking whether the file exists, so a refusal reveals nothing", async () => {
    actAs(BOB, ALL_MAINTENANCE);
    storageMock.getUploadByStorageKey.mockResolvedValue(undefined);
    storageMock.findUploadReferences.mockResolvedValue([
      { kind: "maintenanceRequest", record: WEST_REQUEST },
    ]);

    const { status } = await get(`/uploads/${KEY}`);

    expect(status).toBe(403);
    expect(fileStoreMock.uploadExists).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 8. Input that is malformed rather than unauthorized
// ---------------------------------------------------------------------------

describe("malformed request bodies", () => {
  beforeEach(() => {
    actAs(STAFF, { ...ALL_MAINTENANCE, allowedRegions: ["West Central"] });
  });

  it("rejects a body that is not valid JSON", async () => {
    const { status, body } = await request("POST", "/api/maintenance-requests", { rawBody: "{not json" });
    expect(status).toBe(400);
    expect(body.message).not.toMatch(/JSON at position/i);
  });

  it("rejects a body missing required fields, naming them", async () => {
    const { status, body } = await request("POST", "/api/maintenance-requests", { body: { title: "Only a title" } });
    expect(status).toBe(400);
    expect(Array.isArray(body.errors)).toBe(true);
    expect(body.errors.length).toBeGreaterThan(0);
    expect(storageMock.createMaintenanceRequest).not.toHaveBeenCalled();
  });

  it("rejects a field of the wrong type", async () => {
    const { status } = await request("POST", "/api/maintenance-requests", {
      body: { title: 42, description: [], category: null, priority: "urgent", location: "x", region: "West Central", buildingAddress: "y" },
    });
    expect(status).toBe(400);
    expect(storageMock.createMaintenanceRequest).not.toHaveBeenCalled();
  });

  it("rejects a value outside the allowed set", async () => {
    const { status } = await request("POST", "/api/maintenance-requests", {
      body: { title: "t", description: "d", category: "c", priority: "catastrophic", location: "l", region: "West Central", buildingAddress: "b" },
    });
    expect(status).toBe(400);
  });

  it("rejects an array where an object is expected", async () => {
    const { status } = await request("POST", "/api/maintenance-requests", { rawBody: "[1,2,3]" });
    expect(status).toBe(400);
  });

  it("never returns a stack trace or a file path", async () => {
    const { body } = await request("POST", "/api/maintenance-requests", { rawBody: "{not json" });
    expect(JSON.stringify(body)).not.toMatch(/\bat .*\(.*:\d+:\d+\)/);
    expect(JSON.stringify(body)).not.toContain("/home/");
  });
});

describe("identifiers that do not correspond to anything", () => {
  beforeEach(() => {
    actAs(STAFF, { ...ALL_MAINTENANCE, allowedRegions: ["West Central"] });
    storageMock.getMaintenanceRequest.mockResolvedValue(undefined);
  });

  // Storage returns undefined for every id here, so they all exercise the same
  // not-found path; a plain miss and an over-long id are enough to cover it.
  const oddIds = [
    ["a plain unknown id", "no-such-request"],
    ["a very long id", "x".repeat(500)],
  ];

  it.each(oddIds)("answers %s with 404 rather than failing", async (_label, id) => {
    const { status } = await get(`/api/maintenance-requests/${id}`);
    expect(status).toBe(404);
  });

  it("reports a malformed-id database error as a clean 400, not a hung request", async () => {
    // Postgres rejects a malformed UUID with 22P02, which must not escape as an
    // unhandled rejection — Express 4 would leave the browser waiting.
    storageMock.getMaintenanceRequest.mockRejectedValue(Object.assign(new Error("invalid input syntax"), { code: "22P02" }));
    const { status, body } = await get("/api/maintenance-requests/not-a-uuid");
    expect(status).toBe(400);
    expect(body.message).not.toMatch(/invalid input syntax/);
  });

  it("keeps serving afterwards — one bad request is not an outage", async () => {
    await get(`/api/maintenance-requests/${"x".repeat(500)}`);
    storageMock.getMaintenanceRequest.mockResolvedValue(WEST_REQUEST);
    expect((await get("/api/maintenance-requests/req-west")).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

describe("what reaches the audit log", () => {
  const patch = (path: string, body: unknown) => request("PATCH", path, { body });

  /** The single event a request recorded, or undefined if it recorded none. */
  function recordedEvent() {
    const calls = storageMock.createAuditEvent.mock.calls;
    return calls.length === 1 ? calls[0][0] : undefined;
  }

  it("records who changed a role, and from what to what", async () => {
    actAs(ADMIN);
    storageMock.getUser.mockResolvedValueOnce(ADMIN).mockResolvedValue(ALICE);
    storageMock.updateUserRole.mockResolvedValue({ ...ALICE, role: "regional_administrator" });

    const { status } = await patch("/api/users/u-alice/role", { role: "regional_administrator" });

    expect(status).toBe(200);
    // A change of role also resets the permissions row and records that
    // separately; this test is about the role event.
    const roleEvent = storageMock.createAuditEvent.mock.calls.map((c) => c[0]).find((e) => e.action === "user.role_changed");
    expect(roleEvent).toMatchObject({
      action: "user.role_changed",
      entityType: "user",
      entityId: "u-alice",
      actorId: ADMIN.id,
      actorEmail: ADMIN.email,
      details: { from: "resident", to: "regional_administrator" },
    });
  });

  // A role change is an access change twice over: the role, and the
  // permissions row it resets. Both are recorded, and the reset is decided
  // from the roles alone, so a spell as admin leaves nothing behind.
  it("resets a demoted admin to no flags and no regions, and records both changes", async () => {
    actAs(ADMIN);
    const exAdmin = { ...STAFF, id: "u-ex", email: "ex@example.com", role: "admin" };
    storageMock.getUser.mockResolvedValueOnce(ADMIN).mockResolvedValue(exAdmin);
    storageMock.getUserPermissions.mockResolvedValueOnce(undefined).mockResolvedValue({
      userId: "u-ex",
      canManageFinancials: true,
      canManageBilling: true,
      allowedRegions: ["West Central", "East Central", "National"],
    });
    storageMock.updateUserRole.mockResolvedValue({ ...exAdmin, role: "regional_administrator" });

    const { status } = await patch("/api/users/u-ex/role", { role: "regional_administrator" });

    expect(status).toBe(200);
    expect(storageMock.updateUserRole).toHaveBeenCalledWith(
      "u-ex",
      "regional_administrator",
      expect.objectContaining({ userId: "u-ex", allowedRegions: [], canManageFinancials: false, canManageBilling: false, canViewMaintenance: false }),
    );
    const actions = storageMock.createAuditEvent.mock.calls.map((c) => c[0].action);
    expect(actions).toEqual(expect.arrayContaining(["user.role_changed", "user.permissions_changed"]));
    const permissionsEvent = storageMock.createAuditEvent.mock.calls.find((c) => c[0].action === "user.permissions_changed")![0];
    expect(permissionsEvent.details.changed).toEqual(expect.arrayContaining(["canManageFinancials", "allowedRegions"]));
  });

  it("changes nothing and records nothing when the role is the one they already have", async () => {
    actAs(ADMIN);
    storageMock.getUser.mockResolvedValueOnce(ADMIN).mockResolvedValue({ ...STAFF });
    const { status } = await patch("/api/users/u-staff/role", { role: "regional_administrator" });
    expect(status).toBe(200);
    expect(storageMock.updateUserRole).not.toHaveBeenCalled();
    expect(storageMock.upsertUserPermissions).not.toHaveBeenCalled();
    expect(storageMock.createAuditEvent).not.toHaveBeenCalled();
  });

  it("leaves the permissions row alone on a promotion to admin, and records only the role", async () => {
    actAs(ADMIN);
    storageMock.getUser.mockResolvedValueOnce(ADMIN).mockResolvedValue({ ...STAFF });
    storageMock.updateUserRole.mockResolvedValue({ ...STAFF, role: "admin" });
    const { status } = await patch("/api/users/u-staff/role", { role: "admin" });
    expect(status).toBe(200);
    expect(storageMock.updateUserRole).toHaveBeenCalledWith("u-staff", "admin", null);
    expect(storageMock.createAuditEvent.mock.calls.map((c) => c[0].action)).toEqual(["user.role_changed"]);
  });

  it("answers 404 for a role change on an account that does not exist, and records nothing", async () => {
    actAs(ADMIN);
    storageMock.getUser.mockResolvedValueOnce(ADMIN).mockResolvedValue(undefined);
    const { status } = await patch("/api/users/u-nobody/role", { role: "admin" });
    expect(status).toBe(404);
    expect(storageMock.updateUserRole).not.toHaveBeenCalled();
    expect(storageMock.createAuditEvent).not.toHaveBeenCalled();
  });

  it("records a deactivation", async () => {
    actAs(ADMIN);
    storageMock.getUser.mockResolvedValueOnce(ADMIN).mockResolvedValue(ALICE);
    storageMock.updateUserActiveStatus.mockResolvedValue({ ...ALICE, isActive: false });

    await patch("/api/users/u-alice/status", { isActive: false });

    expect(recordedEvent()).toMatchObject({
      action: "user.status_changed",
      entityId: "u-alice",
      details: { isActive: false },
    });
  });

  it("answers 404 for an account that does not exist, and records nothing (#163)", async () => {
    // user.status_changed is kept indefinitely; an event about nobody would
    // sit in the log for good.
    actAs(ADMIN);
    storageMock.getUser.mockResolvedValueOnce(ADMIN).mockResolvedValue(undefined);

    const { status } = await patch("/api/users/u-nobody/status", { isActive: false });

    expect(status).toBe(404);
    expect(storageMock.updateUserActiveStatus).not.toHaveBeenCalled();
    expect(storageMock.createAuditEvent).not.toHaveBeenCalled();
  });

  it("records a permission change as field names, not as a copy of the request", async () => {
    actAs(ADMIN);
    storageMock.getUserPermissions
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue({ userId: "u-alice", canViewMaintenance: false, allowedRegions: [] });
    storageMock.upsertUserPermissions.mockResolvedValue({ userId: "u-alice" });

    await patch("/api/users/u-alice/permissions", {
      canViewMaintenance: true,
      allowedRegions: ["West Central"],
    });

    expect(recordedEvent()).toMatchObject({
      action: "user.permissions_changed",
      entityId: "u-alice",
      details: { changed: ["allowedRegions", "canViewMaintenance"], allowedRegions: ["West Central"] },
    });
  });

  it("records a maintenance status change", async () => {
    actAs(STAFF, { ...ALL_MAINTENANCE, allowedRegions: ["West Central"] });
    storageMock.getMaintenanceRequest.mockResolvedValue(WEST_REQUEST);

    await patch("/api/maintenance-requests/req-west", { status: "completed" });

    expect(recordedEvent()).toMatchObject({
      action: "maintenance_request.status_changed",
      entityId: "req-west",
      details: { from: "pending", to: "completed" },
    });
  });

  it("does not record an ordinary maintenance edit that leaves the status alone", async () => {
    actAs(STAFF, { ...ALL_MAINTENANCE, allowedRegions: ["West Central"] });
    storageMock.getMaintenanceRequest.mockResolvedValue(WEST_REQUEST);

    await patch("/api/maintenance-requests/req-west", { description: "Now dripping faster" });

    expect(storageMock.createAuditEvent).not.toHaveBeenCalled();
  });

  it("records nothing at all when the action was refused", async () => {
    actAs(ALICE);
    storageMock.getUser.mockResolvedValue(ALICE);

    const { status } = await patch("/api/users/u-bob/role", { role: "admin" });

    expect(status).toBe(403);
    expect(storageMock.updateUserRole).not.toHaveBeenCalled();
    expect(storageMock.createAuditEvent).not.toHaveBeenCalled();
  });

  // The account lookup used to be for the log's summary only. It now decides
  // what the permissions row becomes, so a failed lookup refuses the change
  // rather than guessing at the previous role.
  it("refuses a role change when the account cannot be looked up, and writes nothing", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    actAs(ADMIN);
    storageMock.getUser.mockResolvedValueOnce(ADMIN).mockRejectedValue(new Error("connection reset"));

    const { status } = await patch("/api/users/u-alice/role", { role: "admin" });

    expect(status).toBe(500);
    expect(storageMock.updateUserRole).not.toHaveBeenCalled();
    expect(storageMock.createAuditEvent).not.toHaveBeenCalled();
    logged.mockRestore();
  });

  it("still saves permissions when the lookup done for the log fails", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    actAs(ADMIN);
    storageMock.getUserPermissions
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(new Error("connection reset"));
    storageMock.upsertUserPermissions.mockResolvedValue({ userId: "u-alice" });

    const { status } = await patch("/api/users/u-alice/permissions", { canViewMaintenance: true });

    expect(status).toBe(200);
    expect(storageMock.upsertUserPermissions).toHaveBeenCalled();
    logged.mockRestore();
  });

  it("still answers the caller when the audit write fails", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    actAs(ADMIN);
    storageMock.getUser.mockResolvedValueOnce(ADMIN).mockResolvedValue(ALICE);
    storageMock.updateUserRole.mockResolvedValue({ ...ALICE, role: "admin" });
    storageMock.createAuditEvent.mockRejectedValue(new Error("audit table is missing"));

    const { status, body } = await patch("/api/users/u-alice/role", { role: "admin" });

    // The change itself succeeded. Failing the request because the record of it
    // could not be written would be the worse outcome of the two.
    expect(status).toBe(200);
    expect(body.role).toBe("admin");
    logged.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Reading the audit log back
// ---------------------------------------------------------------------------

/**
 * The close-date clock over real HTTP.
 *
 * The transition rules are covered exhaustively and without HTTP in
 * maintenanceStatus.test.ts. What can only be checked here is that the route
 * actually calls them, and that the value reaching storage came from the
 * server rather than from the request body.
 */
describe("when a maintenance request records that it closed", () => {
  const patch = (path: string, body: unknown) => request("PATCH", path, { body });

  /** The patch the route handed to storage on a maintenance update. */
  function maintenancePatch() {
    const calls = storageMock.updateMaintenanceRequest.mock.calls;
    return calls.length === 1 ? calls[0][1] : undefined;
  }

  it("stamps a close date when a request is completed", async () => {
    actAs(STAFF, { ...ALL_MAINTENANCE, allowedRegions: ["West Central"] });
    storageMock.getMaintenanceRequest.mockResolvedValue(WEST_REQUEST);

    await patch("/api/maintenance-requests/req-west", { status: "completed" });

    expect(maintenancePatch()?.completedDate).toBeInstanceOf(Date);
  });

  it("clears the close date when a closed request is reopened", async () => {
    actAs(STAFF, { ...ALL_MAINTENANCE, allowedRegions: ["West Central"] });
    storageMock.getMaintenanceRequest.mockResolvedValue({ ...WEST_REQUEST, status: "completed" });

    await patch("/api/maintenance-requests/req-west", { status: "in_progress" });

    expect(maintenancePatch()).toHaveProperty("completedDate", null);
  });

  it("leaves the close date alone on an edit that does not change the status", async () => {
    // The one that matters for the rows closed before this column was written:
    // an unrelated edit must not backfill a date and make an old request look
    // freshly closed. The positive control above proves the spy fires, so this
    // absence is a real absence rather than a test that never ran.
    actAs(STAFF, { ...ALL_MAINTENANCE, allowedRegions: ["West Central"] });
    storageMock.getMaintenanceRequest.mockResolvedValue({ ...WEST_REQUEST, status: "completed" });

    await patch("/api/maintenance-requests/req-west", { description: "Still dripping" });

    expect(maintenancePatch()).not.toHaveProperty("completedDate");
  });

  it("ignores a close date supplied by the caller", async () => {
    // completedDate is not in the insert schema, so a body carrying one is
    // stripped before it reaches storage. Without that, a client could backdate
    // a closure and push a request out of the resident visibility window early.
    actAs(STAFF, { ...ALL_MAINTENANCE, allowedRegions: ["West Central"] });
    storageMock.getMaintenanceRequest.mockResolvedValue(WEST_REQUEST);

    await patch("/api/maintenance-requests/req-west", {
      description: "Still dripping",
      completedDate: "2020-01-01T00:00:00.000Z",
    });

    expect(maintenancePatch()).not.toHaveProperty("completedDate");
  });
});

/**
 * The roster CSV import.
 *
 * The parsing and duplicate rules are covered without HTTP in
 * residentImport.test.ts. What is asserted here is the part only a real request
 * can show: that the permission and region checks run BEFORE the multipart
 * parser, that a preview writes nothing, and that a confirm does not trust what
 * the client sends back.
 */
describe("importing a roster from a spreadsheet", () => {
  const WEST_PROPERTY = { id: "prop-west", name: "Cleveland House", region: "West Central", address: "1 Main St" };
  const EAST_PROPERTY = { id: "prop-east", name: "Como House", region: "East Central", address: "2 River Rd" };
  const ALL_PROPERTIES = { canViewProperties: true, canManageProperties: true };

  const ROSTER = "First Name,Last Name,Email\nAda,Lovelace,ada@spo.org\nGrace,Hopper,grace@spo.org";

  async function postRoster(propertyId: string, text = ROSTER) {
    const form = new FormData();
    form.append("file", new Blob([text], { type: "text/csv" }), "roster.csv");
    const res = await fetch(`${baseUrl}/api/properties/${propertyId}/residents/import/preview`, {
      method: "POST",
      body: form,
    });
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  }

  const confirm = (propertyId: string, rows: unknown[]) =>
    request("POST", `/api/properties/${propertyId}/residents/import`, { body: { rows } });

  // Both write paths: the confirm step writes in one batch, and a regression
  // back to one-at-a-time must not make these assertions vacuous.
  const expectNoResidentsWritten = () => {
    expect(storageMock.createResidents).not.toHaveBeenCalled();
    expect(storageMock.createResident).not.toHaveBeenCalled();
  };

  // ── Who may import ────────────────────────────────────────────────────────

  it("refuses an anonymous caller", async () => {
    const { status } = await postRoster("prop-west");
    expect(status).toBe(401);
    expectNoResidentsWritten();
  });

  it("refuses a resident", async () => {
    actAs(ALICE, ALL_MAINTENANCE);
    storageMock.getProperty.mockResolvedValue(WEST_PROPERTY);
    const { status } = await postRoster("prop-west");
    expect(status).toBe(403);
    expectNoResidentsWritten();
  });

  it("refuses staff who lack the property permission", async () => {
    actAs(STAFF, { ...ALL_MAINTENANCE, allowedRegions: ["West Central"] });
    storageMock.getProperty.mockResolvedValue(WEST_PROPERTY);
    const { status } = await postRoster("prop-west");
    expect(status).toBe(403);
    expectNoResidentsWritten();
  });

  it("refuses a house in a region the importer cannot reach", async () => {
    actAs(STAFF, { ...ALL_PROPERTIES, allowedRegions: ["West Central"] });
    storageMock.getProperty.mockResolvedValue(EAST_PROPERTY);
    const { status } = await postRoster("prop-east");
    expect(status).toBe(403);
    expectNoResidentsWritten();
  });

  // ── The body must not be read for a caller who will be refused ────────────

  it("proves the instrumentation works: an allowed import does reach the parser", async () => {
    // The positive control. Without it, every "not called" below could pass
    // because the spy was never wired to this route at all.
    actAs(STAFF, { ...ALL_PROPERTIES, allowedRegions: ["West Central"] });
    storageMock.getProperty.mockResolvedValue(WEST_PROPERTY);
    storageMock.getResidentsByProperty.mockResolvedValue([]);

    const { status } = await postRoster("prop-west");

    expect(status).toBe(200);
    expect(multerEntered).toHaveBeenCalledWith("/api/properties/prop-west/residents/import/preview");
  });

  it("turns a resident away before reading the file", async () => {
    actAs(ALICE, ALL_MAINTENANCE);
    storageMock.getProperty.mockResolvedValue(WEST_PROPERTY);
    await postRoster("prop-west");
    expect(multerEntered).not.toHaveBeenCalled();
  });

  it("turns an out-of-region importer away before reading the file", async () => {
    actAs(STAFF, { ...ALL_PROPERTIES, allowedRegions: ["West Central"] });
    storageMock.getProperty.mockResolvedValue(EAST_PROPERTY);
    await postRoster("prop-east");
    expect(multerEntered).not.toHaveBeenCalled();
  });

  // ── Preview writes nothing ────────────────────────────────────────────────

  it("previews without creating anybody", async () => {
    // The rule the whole feature is shaped around: an upload is never an
    // import. Nothing is written until a separate confirm arrives.
    actAs(STAFF, { ...ALL_PROPERTIES, allowedRegions: ["West Central"] });
    storageMock.getProperty.mockResolvedValue(WEST_PROPERTY);
    storageMock.getResidentsByProperty.mockResolvedValue([]);

    const { status, body } = await postRoster("prop-west");

    expect(status).toBe(200);
    expect(body.counts).toEqual({ create: 2, duplicate: 0, error: 0 });
    expectNoResidentsWritten();
  });

  it("reports a duplicate against the roster as it stands now", async () => {
    actAs(STAFF, { ...ALL_PROPERTIES, allowedRegions: ["West Central"] });
    storageMock.getProperty.mockResolvedValue(WEST_PROPERTY);
    storageMock.getResidentsByProperty.mockResolvedValue([{ email: "ada@spo.org" }]);

    const { body } = await postRoster("prop-west");

    expect(body.counts).toEqual({ create: 1, duplicate: 1, error: 0 });
    expectNoResidentsWritten();
  });

  it("refuses a file that is not a CSV", async () => {
    actAs(STAFF, { ...ALL_PROPERTIES, allowedRegions: ["West Central"] });
    storageMock.getProperty.mockResolvedValue(WEST_PROPERTY);

    const form = new FormData();
    form.append("file", new Blob(["not a roster"], { type: "application/pdf" }), "roster.pdf");
    const res = await fetch(`${baseUrl}/api/properties/prop-west/residents/import/preview`, {
      method: "POST",
      body: form,
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expectNoResidentsWritten();
  });

  // ── Confirm re-derives rather than trusting the client ────────────────────

  it("creates the confirmed rows against the property from the URL", async () => {
    actAs(STAFF, { ...ALL_PROPERTIES, allowedRegions: ["West Central"] });
    storageMock.getProperty.mockResolvedValue(WEST_PROPERTY);
    storageMock.getResidentsByProperty.mockResolvedValue([]);
    storageMock.createResidents.mockImplementation(async (rows: Record<string, unknown>[]) => rows.map((r, i) => ({ id: `res-new-${i}`, ...r })));

    const { status, body } = await confirm("prop-west", [
      { firstName: "Ada", lastName: "Lovelace", email: "ada@spo.org" },
    ]);

    expect(status).toBe(200);
    expect(body.created).toBe(1);
    expect(storageMock.createResidents).toHaveBeenCalledWith([
      expect.objectContaining({
        propertyId: "prop-west",
        email: "ada@spo.org",
        region: "West Central",
        buildingAddress: "1 Main St",
      }),
    ]);
  });

  it("takes region and house from the property, not from the caller", async () => {
    // A client that echoes an edited preview back must not be able to file
    // somebody into a region the importer cannot reach.
    actAs(STAFF, { ...ALL_PROPERTIES, allowedRegions: ["West Central"] });
    storageMock.getProperty.mockResolvedValue(WEST_PROPERTY);
    storageMock.getResidentsByProperty.mockResolvedValue([]);
    storageMock.createResidents.mockImplementation(async (rows: Record<string, unknown>[]) => rows.map((r, i) => ({ id: `res-new-${i}`, ...r })));

    await confirm("prop-west", [
      {
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@spo.org",
        region: "East Central",
        propertyId: "prop-east",
        buildingAddress: "2 River Rd",
        isActive: false,
      },
    ]);

    expect(storageMock.createResidents).toHaveBeenCalledWith([
      expect.objectContaining({ propertyId: "prop-west", region: "West Central", buildingAddress: "1 Main St" }),
    ]);
  });

  it("re-checks duplicates at confirm, not just at preview", async () => {
    // The roster can move on between the two requests -- another RA importing
    // the same sheet, or the same person adding one by hand.
    actAs(STAFF, { ...ALL_PROPERTIES, allowedRegions: ["West Central"] });
    storageMock.getProperty.mockResolvedValue(WEST_PROPERTY);
    storageMock.getResidentsByProperty.mockResolvedValue([{ email: "ada@spo.org" }]);

    const { status, body } = await confirm("prop-west", [
      { firstName: "Ada", lastName: "Lovelace", email: "ada@spo.org" },
    ]);

    expect(status).toBe(200);
    expect(body.created).toBe(0);
    expect(body.skipped).toBe(1);
    expectNoResidentsWritten();
  });

  it("refuses a confirm for a house in another region", async () => {
    actAs(STAFF, { ...ALL_PROPERTIES, allowedRegions: ["West Central"] });
    storageMock.getProperty.mockResolvedValue(EAST_PROPERTY);

    const { status } = await confirm("prop-east", [
      { firstName: "Ada", lastName: "Lovelace", email: "ada@spo.org" },
    ]);

    expect(status).toBe(403);
    expectNoResidentsWritten();
  });

  it("refuses a confirm carrying a row that is not usable", async () => {
    actAs(STAFF, { ...ALL_PROPERTIES, allowedRegions: ["West Central"] });
    storageMock.getProperty.mockResolvedValue(WEST_PROPERTY);
    storageMock.getResidentsByProperty.mockResolvedValue([]);

    const { status } = await confirm("prop-west", [
      { firstName: "Ada", lastName: "Lovelace", email: "not-an-email" },
    ]);

    expect(status).toBe(400);
    expectNoResidentsWritten();
  });

  it("refuses a property that does not exist", async () => {
    actAs(STAFF, { ...ALL_PROPERTIES, allowedRegions: ["West Central"] });
    storageMock.getProperty.mockResolvedValue(undefined);

    const { status } = await confirm("prop-nope", [
      { firstName: "Ada", lastName: "Lovelace", email: "ada@spo.org" },
    ]);

    expect(status).toBe(404);
    expectNoResidentsWritten();
  });

  it("re-runs the row checks at confirm, refusing a date that does not exist (#163)", async () => {
    // Rebuilt with no errors, 2026-02-30 used to be stored as March 2.
    actAs(STAFF, { ...ALL_PROPERTIES, allowedRegions: ["West Central"] });
    storageMock.getProperty.mockResolvedValue(WEST_PROPERTY);
    storageMock.getResidentsByProperty.mockResolvedValue([]);

    const { status } = await confirm("prop-west", [
      { firstName: "Ada", lastName: "Lovelace", email: "ada@spo.org", moveInDate: "2026-02-30" },
    ]);

    expect(status).toBe(400);
    expectNoResidentsWritten();
  });

  it("writes none of the good rows when a later one is bad (#163)", async () => {
    actAs(STAFF, { ...ALL_PROPERTIES, allowedRegions: ["West Central"] });
    storageMock.getProperty.mockResolvedValue(WEST_PROPERTY);
    storageMock.getResidentsByProperty.mockResolvedValue([]);

    const { status } = await confirm("prop-west", [
      { firstName: "Ada", lastName: "Lovelace", email: "ada@spo.org" },
      { firstName: "Grace", lastName: "Hopper", email: "grace@spo.org", moveInDate: "someday" },
    ]);

    expect(status).toBe(400);
    expectNoResidentsWritten();
  });

  it("writes every confirmed row in one call, with the date as the preview read it (#163)", async () => {
    // The positive control: a US-style date the preview accepts is normalised
    // the same way at confirm, and both rows land together.
    actAs(STAFF, { ...ALL_PROPERTIES, allowedRegions: ["West Central"] });
    storageMock.getProperty.mockResolvedValue(WEST_PROPERTY);
    storageMock.getResidentsByProperty.mockResolvedValue([]);
    storageMock.createResidents.mockImplementation(async (rows: Record<string, unknown>[]) => rows.map((r, i) => ({ id: `res-new-${i}`, ...r })));

    const { status, body } = await confirm("prop-west", [
      { firstName: "Ada", lastName: "Lovelace", email: "ada@spo.org", moveInDate: "8/20/2026" },
      { firstName: "Grace", lastName: "Hopper", email: "grace@spo.org" },
    ]);

    expect(status).toBe(200);
    expect(body.created).toBe(2);
    expect(storageMock.createResidents).toHaveBeenCalledTimes(1);
    const [rows] = storageMock.createResidents.mock.calls[0];
    expect(rows).toHaveLength(2);
    expect((rows[0].moveInDate as Date).toISOString().slice(0, 10)).toBe("2026-08-20");
    expect(storageMock.createResident).not.toHaveBeenCalled();
  });
});

/**
 * Walkthroughs and their items.
 *
 * These are new routes, and nothing existing fails if one of them is missing a
 * guard -- which is exactly why every one of them is asserted here.
 *
 * The novel risk is the region chain. An item has no region of its own: it
 * inherits its room's, which inherits its walkthrough's. Any break in that
 * chain must grant nothing rather than fall through to "no region required".
 */
describe("walkthroughs and walkthrough items", () => {
  const WEST_PROPERTY = { id: "prop-west", name: "Cleveland House", region: "West Central", address: "1 Main St" };
  const EAST_PROPERTY = { id: "prop-east", name: "Como House", region: "East Central", address: "2 River Rd" };
  const VIEW = { canViewWalkthroughs: true };
  const MANAGE = { canViewWalkthroughs: true, canManageWalkthroughs: true };

  const WEST_WT = { id: "wt-west", propertyId: "prop-west", region: "West Central", buildingAddress: "1 Main St", status: "draft" };
  const EAST_WT = { id: "wt-east", propertyId: "prop-east", region: "East Central", buildingAddress: "2 River Rd", status: "draft" };
  const WEST_ROOM = { id: "room-west", name: "Kitchen", walkthroughId: "wt-west" };
  const EAST_ROOM = { id: "room-east", name: "Kitchen", walkthroughId: "wt-east" };
  const ORPHAN_ROOM = { id: "room-orphan", name: "Kitchen", walkthroughId: null };
  const WEST_ITEM = { id: "item-west", roomId: "room-west", label: "Sink", condition: "good" };
  const ORPHAN_ITEM = { id: "item-orphan", roomId: "room-orphan", label: "Sink", condition: "good" };

  const westLead = () => actAs(STAFF, { ...MANAGE, allowedRegions: ["West Central"] });

  /**
   * Creating a walkthrough also seeds its structure from the template. These
   * tests are about the guards rather than the seeding, so this gives it an
   * empty template to read and nothing to copy.
   */
  const seedsNothing = () => {
    storageMock.getWalkthroughsByProperty.mockResolvedValue([]);
    storageMock.getAllWalkthroughTemplateRooms.mockResolvedValue([]);
    storageMock.getAllWalkthroughTemplateItems.mockResolvedValue([]);
  };

  // ── The three layers, on every new route ─────────────────────────────────

  const READS: [string, string][] = [
    ["GET", "/api/walkthroughs"],
    ["GET", "/api/walkthroughs/wt-west"],
    ["GET", "/api/walkthroughs/wt-west/rooms"],
    ["GET", "/api/walkthroughs/wt-west/items"],
    ["GET", "/api/walkthrough-rooms/room-west/items"],
  ];
  const WRITES: [string, string][] = [
    ["POST", "/api/walkthroughs"],
    ["PATCH", "/api/walkthroughs/wt-west"],
    ["DELETE", "/api/walkthroughs/wt-west"],
    ["POST", "/api/walkthrough-items"],
    ["PATCH", "/api/walkthrough-items/item-west"],
    ["DELETE", "/api/walkthrough-items/item-west"],
  ];

  /** GET cannot carry a body, so only the writes get one. */
  const call = (method: string, path: string) =>
    method === "GET" ? request(method, path) : request(method, path, { body: {} });

  it.each([...READS, ...WRITES])("refuses an anonymous caller: %s %s", async (method, path) => {
    const { status } = await call(method, path);
    expect(status).toBe(401);
  });

  it.each([...READS, ...WRITES])("refuses a resident: %s %s", async (method, path) => {
    actAs(ALICE, ALL_MAINTENANCE);
    storageMock.getWalkthrough.mockResolvedValue(WEST_WT);
    storageMock.getWalkthroughRoom.mockResolvedValue(WEST_ROOM);
    storageMock.getWalkthroughItem.mockResolvedValue(WEST_ITEM);
    const { status } = await call(method, path);
    expect(status).toBe(403);
  });

  it.each(WRITES)("refuses staff holding only the view permission: %s %s", async (method, path) => {
    actAs(STAFF, { ...VIEW, allowedRegions: ["West Central"] });
    storageMock.getProperty.mockResolvedValue(WEST_PROPERTY);
    storageMock.getWalkthrough.mockResolvedValue(WEST_WT);
    storageMock.getWalkthroughRoom.mockResolvedValue(WEST_ROOM);
    storageMock.getWalkthroughItem.mockResolvedValue(WEST_ITEM);
    const { status } = await call(method, path);
    expect(status).toBe(403);
    expect(storageMock.createWalkthrough).not.toHaveBeenCalled();
    expect(storageMock.updateWalkthrough).not.toHaveBeenCalled();
    expect(storageMock.deleteWalkthrough).not.toHaveBeenCalled();
    expect(storageMock.createWalkthroughItem).not.toHaveBeenCalled();
  });

  // ── Region scoping ───────────────────────────────────────────────────────

  it("filters the list to the caller's regions", async () => {
    westLead();
    storageMock.getAllWalkthroughs.mockResolvedValue([WEST_WT, EAST_WT]);
    const { status, body } = await request("GET", "/api/walkthroughs");
    expect(status).toBe(200);
    expect(body.map((w: { id: string }) => w.id)).toEqual(["wt-west"]);
  });

  it("gives an unassigned staff account an empty list, never everything", async () => {
    actAs(STAFF, { ...MANAGE, allowedRegions: [] });
    storageMock.getAllWalkthroughs.mockResolvedValue([WEST_WT, EAST_WT]);
    const { body } = await request("GET", "/api/walkthroughs");
    expect(body).toEqual([]);
  });

  it("refuses a walkthrough in another region", async () => {
    westLead();
    storageMock.getWalkthrough.mockResolvedValue(EAST_WT);
    expect((await request("GET", "/api/walkthroughs/wt-east")).status).toBe(403);
  });

  it("refuses another region's rooms, without reading them", async () => {
    westLead();
    storageMock.getWalkthrough.mockResolvedValue(EAST_WT);
    const { status } = await request("GET", "/api/walkthroughs/wt-east/rooms");
    expect(status).toBe(403);
    expect(storageMock.getWalkthroughRoomsByWalkthrough).not.toHaveBeenCalled();
  });

  it("returns the whole checklist of a walkthrough in the caller's region", async () => {
    // The positive control for the refusal below: the route really does read
    // the checklist when it is allowed to, so "not called" means the guard.
    westLead();
    storageMock.getWalkthrough.mockResolvedValue(WEST_WT);
    storageMock.getWalkthroughItemsByWalkthrough.mockResolvedValue([WEST_ITEM]);

    const { status, body } = await request("GET", "/api/walkthroughs/wt-west/items");
    expect(status).toBe(200);
    expect(body.map((i: { id: string }) => i.id)).toEqual(["item-west"]);
  });

  it("refuses another region's checklist, without reading it", async () => {
    westLead();
    storageMock.getWalkthrough.mockResolvedValue(EAST_WT);
    const { status } = await request("GET", "/api/walkthroughs/wt-east/items");
    expect(status).toBe(403);
    expect(storageMock.getWalkthroughItemsByWalkthrough).not.toHaveBeenCalled();
  });

  it("fails closed when the walkthrough behind a checklist is gone", async () => {
    westLead();
    storageMock.getWalkthrough.mockResolvedValue(undefined);
    const { status } = await request("GET", "/api/walkthroughs/nope/items");
    expect(status).toBe(404);
    expect(storageMock.getWalkthroughItemsByWalkthrough).not.toHaveBeenCalled();
  });

  it("takes region and house from the property, not from the caller", async () => {
    westLead();
    storageMock.getProperty.mockResolvedValue(WEST_PROPERTY);
    storageMock.createWalkthrough.mockImplementation(async (w: Record<string, unknown>) => ({ id: "wt-new", ...w }));
    seedsNothing();

    const { status } = await request("POST", "/api/walkthroughs", {
      body: { propertyId: "prop-west", region: "East Central", buildingAddress: "2 River Rd" },
    });

    expect(status).toBe(200);
    expect(storageMock.createWalkthrough).toHaveBeenCalledWith(
      expect.objectContaining({ region: "West Central", buildingAddress: "1 Main St" }),
    );
  });

  it("records who performed it from the session, not the body", async () => {
    westLead();
    storageMock.getProperty.mockResolvedValue(WEST_PROPERTY);
    storageMock.createWalkthrough.mockImplementation(async (w: Record<string, unknown>) => ({ id: "wt-new", ...w }));
    seedsNothing();

    await request("POST", "/api/walkthroughs", {
      body: { propertyId: "prop-west", performedBy: "someone.else@spo.org" },
    });

    expect(storageMock.createWalkthrough).toHaveBeenCalledWith(
      expect.objectContaining({ performedBy: STAFF.email }),
    );
  });

  it("refuses to create in a region the caller cannot reach", async () => {
    westLead();
    storageMock.getProperty.mockResolvedValue(EAST_PROPERTY);
    const { status } = await request("POST", "/api/walkthroughs", { body: { propertyId: "prop-east" } });
    expect(status).toBe(403);
    expect(storageMock.createWalkthrough).not.toHaveBeenCalled();
  });

  it("will not move a walkthrough to another house or region", async () => {
    westLead();
    storageMock.getWalkthrough.mockResolvedValue(WEST_WT);
    storageMock.updateWalkthrough.mockResolvedValue(WEST_WT);

    // `notes` is the carrier here: status is stripped too, since the submit
    // and review routes became its only writers (2026-09 RA review).
    await request("PATCH", "/api/walkthroughs/wt-west", {
      body: { notes: "Reviewed on site", propertyId: "prop-east", region: "East Central", buildingAddress: "2 River Rd" },
    });

    const patch = storageMock.updateWalkthrough.mock.calls[0][1];
    expect(patch).toEqual({ notes: "Reviewed on site" });
  });

  // ── The region chain, and what happens when it breaks ────────────────────

  it("resolves an item's region through its room and walkthrough", async () => {
    // The positive control for the three refusals below: the chain really does
    // resolve, so their failures are about the guard and not about the mocks.
    westLead();
    storageMock.getWalkthroughRoom.mockResolvedValue(WEST_ROOM);
    storageMock.getWalkthrough.mockResolvedValue(WEST_WT);
    storageMock.getWalkthroughItemsByRoom.mockResolvedValue([WEST_ITEM]);

    const { status, body } = await request("GET", "/api/walkthrough-rooms/room-west/items");
    expect(status).toBe(200);
    expect(body).toHaveLength(1);
  });

  it("refuses an item whose walkthrough is in another region", async () => {
    westLead();
    storageMock.getWalkthroughRoom.mockResolvedValue(EAST_ROOM);
    storageMock.getWalkthrough.mockResolvedValue(EAST_WT);

    const { status } = await request("GET", "/api/walkthrough-rooms/room-east/items");
    expect(status).toBe(403);
    expect(storageMock.getWalkthroughItemsByRoom).not.toHaveBeenCalled();
  });

  it("fails closed for a room that belongs to no walkthrough", async () => {
    // A room left unlinked by the backfill has no region to inherit. It must
    // grant nothing, rather than skipping the region check for want of a value.
    westLead();
    storageMock.getWalkthroughRoom.mockResolvedValue(ORPHAN_ROOM);

    const { status } = await request("GET", "/api/walkthrough-rooms/room-orphan/items");
    expect(status).toBe(403);
    expect(storageMock.getWalkthroughItemsByRoom).not.toHaveBeenCalled();
  });

  it("fails closed when the room itself is missing", async () => {
    westLead();
    storageMock.getWalkthroughRoom.mockResolvedValue(undefined);
    expect((await request("GET", "/api/walkthrough-rooms/nope/items")).status).toBe(403);
  });

  it("fails closed when the walkthrough behind the room has been deleted", async () => {
    westLead();
    storageMock.getWalkthroughRoom.mockResolvedValue(WEST_ROOM);
    storageMock.getWalkthrough.mockResolvedValue(undefined);
    expect((await request("GET", "/api/walkthrough-rooms/room-west/items")).status).toBe(403);
  });

  it("refuses to create an item on an orphaned room, and creates nothing", async () => {
    westLead();
    storageMock.getWalkthroughRoom.mockResolvedValue(ORPHAN_ROOM);

    const { status } = await request("POST", "/api/walkthrough-items", {
      body: { roomId: "room-orphan", label: "Sink", displayOrder: 0 },
    });

    expect(status).toBe(403);
    expect(storageMock.createWalkthroughItem).not.toHaveBeenCalled();
  });

  it("refuses to edit an item whose chain does not resolve, and writes nothing", async () => {
    westLead();
    storageMock.getWalkthroughItem.mockResolvedValue(ORPHAN_ITEM);
    storageMock.getWalkthroughRoom.mockResolvedValue(ORPHAN_ROOM);

    const { status } = await request("PATCH", "/api/walkthrough-items/item-orphan", {
      body: { condition: "good" },
    });

    expect(status).toBe(403);
    expect(storageMock.updateWalkthroughItem).not.toHaveBeenCalled();
  });

  it("will not move an item into another room", async () => {
    westLead();
    storageMock.getWalkthroughItem.mockResolvedValue(WEST_ITEM);
    storageMock.getWalkthroughRoom.mockResolvedValue(WEST_ROOM);
    storageMock.getWalkthrough.mockResolvedValue(WEST_WT);
    storageMock.updateWalkthroughItem.mockResolvedValue(WEST_ITEM);

    await request("PATCH", "/api/walkthrough-items/item-west", {
      body: { condition: "poor", roomId: "room-east" },
    });

    const patch = storageMock.updateWalkthroughItem.mock.calls[0][1];
    expect(patch).toEqual({ condition: "poor" });
  });
});

/**
 * The second way into the walkthrough routes: a household leader or steward.
 *
 * A resident-tier account holding canCompleteWalkthroughs reaches the same
 * routes staff do, by a different rule — their own house, resolved from
 * `users.propertyId`, and no region path at any point. That is the exact shape
 * of both historic authorization gaps in this codebase, so every one of these
 * assertions is over real HTTP with the real guards running, and every refusal
 * asserts the refused work never happened rather than only the status.
 */
describe("the flagged-items list across walkthroughs", () => {
  const WEST_FLAG = {
    itemId: "item-west",
    label: "Wall",
    condition: "damaged",
    roomId: "room-west",
    roomName: "Living room",
    walkthroughId: "wt-west",
    propertyId: "prop-west",
    buildingAddress: "1 Main St",
    region: "West Central",
    roomPhotoCount: 1,
  };
  const EAST_FLAG = { ...WEST_FLAG, itemId: "item-east", walkthroughId: "wt-east", propertyId: "prop-east", buildingAddress: "2 River Rd", region: "East Central" };

  const bothFlagged = () =>
    storageMock.getFlaggedWalkthroughItems.mockResolvedValue([WEST_FLAG, EAST_FLAG]);

  it("refuses an anonymous caller", async () => {
    expect((await get("/api/walkthrough-flagged-items")).status).toBe(401);
  });

  it("refuses staff holding no walkthrough permission, without running the query", async () => {
    actAs(STAFF, { ...ALL_MAINTENANCE, allowedRegions: ["West Central"] });
    bothFlagged();
    expect((await get("/api/walkthrough-flagged-items")).status).toBe(403);
    expect(storageMock.getFlaggedWalkthroughItems).not.toHaveBeenCalled();
  });

  it("refuses a resident who cannot complete walkthroughs", async () => {
    actAs(ALICE, ALL_MAINTENANCE);
    bothFlagged();
    expect((await get("/api/walkthrough-flagged-items")).status).toBe(403);
    expect(storageMock.getFlaggedWalkthroughItems).not.toHaveBeenCalled();
  });

  // The positive control: without it every "not called" above could pass on a
  // typo in the storage method name.
  it("gives a regional lead only their own regions' items", async () => {
    actAs(STAFF, { canViewWalkthroughs: true, allowedRegions: ["West Central"] });
    bothFlagged();
    const { status, body } = await get("/api/walkthrough-flagged-items");
    expect(status).toBe(200);
    expect(storageMock.getFlaggedWalkthroughItems).toHaveBeenCalled();
    expect(body.map((row: { itemId: string }) => row.itemId)).toEqual(["item-west"]);
  });

  it("gives a staff account with no regions an empty list, never everything", async () => {
    actAs(STAFF, { canViewWalkthroughs: true, allowedRegions: [] });
    bothFlagged();
    expect((await get("/api/walkthrough-flagged-items")).body).toEqual([]);
  });

  it("narrows a household leader to their own house, with no region path", async () => {
    // Their permissions row names a region deliberately: a resident must not
    // pick up the region rule even when one is set on the row.
    actAs({ ...ALICE, propertyId: "prop-east" } as typeof ALICE, {
      canCompleteWalkthroughs: true,
      allowedRegions: ["West Central"],
    });
    storageMock.getProperty.mockResolvedValue({ id: "prop-east", address: "2 River Rd", region: "East Central" });
    bothFlagged();
    const { status, body } = await get("/api/walkthrough-flagged-items");
    expect(status).toBe(200);
    expect(body.map((row: { itemId: string }) => row.itemId)).toEqual(["item-east"]);
  });

  it("gives a leader whose account is linked to no house an empty list", async () => {
    actAs(ALICE, { canCompleteWalkthroughs: true, allowedRegions: ["West Central"] });
    bothFlagged();
    expect((await get("/api/walkthrough-flagged-items")).body).toEqual([]);
  });
});

/**
 * The photo comparison on the staff walkthrough index.
 *
 * A view over existing data, read through routes that already exist: the
 * rooms of each walkthrough, and the region-wide photo list. The list is the
 * one that carries the photos, and it is staff-only in both directions -- a
 * resident cannot upload a walkthrough photo and cannot be served one -- so
 * the assertion that matters is that a household leader holding the
 * completion grant for that very house still gets nothing from it, before
 * the query runs.
 */
describe("comparing a room's photos across walkthrough years", () => {
  const WEST_PHOTO = { id: "photo-west", roomId: "room-west", imageUrl: "/uploads/west.png", region: "West Central", buildingAddress: "1 Main St" };
  const EAST_PHOTO = { id: "photo-east", roomId: "room-east", imageUrl: "/uploads/east.png", region: "East Central", buildingAddress: "2 River Rd" };

  const bothRegions = () => storageMock.getAllWalkthroughPhotos.mockResolvedValue([WEST_PHOTO, EAST_PHOTO]);

  it("refuses a household leader who may complete that house's walkthrough, without running the query", async () => {
    actAs({ ...ALICE, propertyId: "prop-west" } as typeof ALICE, { canCompleteWalkthroughs: true });
    storageMock.getProperty.mockResolvedValue({ id: "prop-west", address: "1 Main St", region: "West Central" });
    bothRegions();
    expect((await get("/api/walkthrough-photos")).status).toBe(403);
    expect(storageMock.getAllWalkthroughPhotos).not.toHaveBeenCalled();
  });

  it("gives staff outside the region nothing from it", async () => {
    actAs(STAFF, { canViewWalkthroughs: true, allowedRegions: ["Northeast"] });
    bothRegions();
    const { status, body } = await get("/api/walkthrough-photos");
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  // The positive control for the "not called" above.
  it("gives staff in the region that region's photos and no other", async () => {
    actAs(STAFF, { canViewWalkthroughs: true, allowedRegions: ["West Central"] });
    bothRegions();
    const { status, body } = await get("/api/walkthrough-photos");
    expect(status).toBe(200);
    expect(storageMock.getAllWalkthroughPhotos).toHaveBeenCalled();
    expect(body.map((photo: { id: string }) => photo.id)).toEqual(["photo-west"]);
  });
});

describe("residents completing their own house's walkthrough", () => {
  const HOUSE_A = "1 Main St";
  const HOUSE_B = "2 River Rd";

  const PROPERTY_A = { id: "prop-a", name: "Cleveland House", region: "West Central", address: HOUSE_A };
  const PROPERTY_B = { id: "prop-b", name: "Como House", region: "East Central", address: HOUSE_B };

  const THIS_YEAR = "2026-09-01T00:00:00.000Z";
  const LAST_YEAR = "2025-09-01T00:00:00.000Z";

  const WT_A = { id: "wt-a", propertyId: "prop-a", region: "West Central", buildingAddress: HOUSE_A, status: "draft", walkthroughDate: THIS_YEAR };
  const WT_B = { id: "wt-b", propertyId: "prop-b", region: "East Central", buildingAddress: HOUSE_B, status: "draft", walkthroughDate: THIS_YEAR };
  /** Last year's inspection of house A: readable by its leader, not writable. */
  const WT_A_PRIOR = { ...WT_A, id: "wt-a-prior", walkthroughDate: LAST_YEAR };
  const ROOM_A_PRIOR = { id: "room-a-prior", name: "Kitchen", walkthroughId: "wt-a-prior" };
  const ITEM_A_PRIOR = { id: "item-a-prior", roomId: "room-a-prior", label: "Sink", condition: "good" };

  const ROOM_A = { id: "room-a", name: "Kitchen", walkthroughId: "wt-a" };
  const ROOM_B = { id: "room-b", name: "Kitchen", walkthroughId: "wt-b" };
  const ITEM_A = { id: "item-a", roomId: "room-a", label: "Sink", condition: "not_recorded" };
  const ITEM_B = { id: "item-b", roomId: "room-b", label: "Sink", condition: "not_recorded" };

  const COMPLETE = { canCompleteWalkthroughs: true };

  /** Alice leads house A: the flag, and a login linked to that property. */
  const leaderOfHouseA = (permissions: Record<string, unknown> = COMPLETE) => {
    actAs({ ...ALICE, propertyId: "prop-a" } as typeof ALICE, permissions);
    storageMock.getProperty.mockImplementation(async (id: string) =>
      id === "prop-a" ? PROPERTY_A : id === "prop-b" ? PROPERTY_B : undefined,
    );
  };

  /** Their own house's records, primed for the happy path. */
  const ownHouse = () => {
    storageMock.getWalkthrough.mockResolvedValue(WT_A);
    storageMock.getWalkthroughRoom.mockResolvedValue(ROOM_A);
    storageMock.getWalkthroughItem.mockResolvedValue(ITEM_A);
    storageMock.getWalkthroughsByProperty.mockResolvedValue([WT_A, WT_A_PRIOR]);
  };

  /** Their own house, but the inspection they finished last year. */
  const ownHousePriorYear = () => {
    storageMock.getWalkthrough.mockResolvedValue(WT_A_PRIOR);
    storageMock.getWalkthroughRoom.mockResolvedValue(ROOM_A_PRIOR);
    storageMock.getWalkthroughItem.mockResolvedValue(ITEM_A_PRIOR);
    storageMock.getWalkthroughsByProperty.mockResolvedValue([WT_A, WT_A_PRIOR]);
  };

  /** Somebody else's house, at every id the routes could be given. */
  const otherHouse = () => {
    storageMock.getWalkthrough.mockResolvedValue(WT_B);
    storageMock.getWalkthroughRoom.mockResolvedValue(ROOM_B);
    storageMock.getWalkthroughItem.mockResolvedValue(ITEM_B);
  };

  const seedsNothing = () => {
    storageMock.getWalkthroughsByProperty.mockResolvedValue([]);
    storageMock.getAllWalkthroughTemplateRooms.mockResolvedValue([]);
    storageMock.getAllWalkthroughTemplateItems.mockResolvedValue([]);
  };

  const expectNoWalkthroughWrite = () => {
    expect(storageMock.createWalkthrough).not.toHaveBeenCalled();
    expect(storageMock.updateWalkthrough).not.toHaveBeenCalled();
    expect(storageMock.deleteWalkthrough).not.toHaveBeenCalled();
    expect(storageMock.createWalkthroughRoom).not.toHaveBeenCalled();
    expect(storageMock.createWalkthroughItem).not.toHaveBeenCalled();
    expect(storageMock.updateWalkthroughItem).not.toHaveBeenCalled();
    expect(storageMock.deleteWalkthroughItem).not.toHaveBeenCalled();
  };

  // ── What a leader may do on their own house ──────────────────────────────
  //
  // These are the positive controls. Without them every "not called" assertion
  // below could pass because the route never does that work at all.

  it("lists their own house's walkthroughs, and only those", async () => {
    leaderOfHouseA();
    storageMock.getAllWalkthroughs.mockResolvedValue([WT_A, WT_B]);

    const { status, body } = await request("GET", "/api/walkthroughs");
    expect(status).toBe(200);
    expect(body.map((w: { id: string }) => w.id)).toEqual(["wt-a"]);
  });

  it("opens their own house's walkthrough, its rooms and its checklist", async () => {
    leaderOfHouseA();
    ownHouse();
    storageMock.getWalkthroughRoomsByWalkthrough.mockResolvedValue([ROOM_A]);
    storageMock.getWalkthroughItemsByWalkthrough.mockResolvedValue([ITEM_A]);
    storageMock.getWalkthroughItemsByRoom.mockResolvedValue([ITEM_A]);

    expect((await request("GET", "/api/walkthroughs/wt-a")).status).toBe(200);
    expect((await request("GET", "/api/walkthroughs/wt-a/rooms")).body).toHaveLength(1);
    expect((await request("GET", "/api/walkthroughs/wt-a/items")).body).toHaveLength(1);
    expect((await request("GET", "/api/walkthrough-rooms/room-a/items")).body).toHaveLength(1);
  });

  it("records a condition on their own house's checklist", async () => {
    leaderOfHouseA();
    ownHouse();
    storageMock.updateWalkthroughItem.mockResolvedValue({ ...ITEM_A, condition: "damaged" });

    const { status } = await request("PATCH", "/api/walkthrough-items/item-a", {
      body: { condition: "damaged", notes: "Cracked basin" },
    });

    expect(status).toBe(200);
    expect(storageMock.updateWalkthroughItem).toHaveBeenCalledWith(
      "item-a",
      expect.objectContaining({ condition: "damaged", notes: "Cracked basin" }),
    );
  });

  it("refuses a leader who has left the house's roster -- moved out, login still linked -- without writing", async () => {
    leaderOfHouseA();
    ownHouse();
    storageMock.getResidentsByProperty.mockResolvedValue([
      { id: "r-alice", email: ALICE.email, propertyId: "prop-a", isActive: false, moveOutDate: new Date("2026-05-20T00:00:00Z") },
    ]);
    storageMock.getAllWalkthroughs.mockResolvedValue([WT_A, WT_B]);

    expect((await request("GET", "/api/walkthroughs")).body).toEqual([]);
    const { status } = await request("PATCH", "/api/walkthrough-items/item-a", { body: { condition: "damaged" } });
    expect(status).toBe(403);
    expectNoWalkthroughWrite();
  });

  it("adds a room their house has", async () => {
    leaderOfHouseA();
    ownHouse();
    storageMock.getWalkthroughRoomsByWalkthrough.mockResolvedValue([ROOM_A]);
    storageMock.getWalkthroughTemplateRoom.mockResolvedValue({ id: "t-bath", name: "Bathroom" });
    storageMock.getAllWalkthroughTemplateItems.mockResolvedValue([]);
    storageMock.createWalkthroughRoom.mockResolvedValue({ id: "room-new", name: "Bathroom" });

    const added = await request("POST", "/api/walkthroughs/wt-a/rooms", { body: { templateRoomId: "t-bath" } });
    expect(added.status).toBe(200);
    expect(storageMock.createWalkthroughRoom).toHaveBeenCalledWith(
      expect.objectContaining({ walkthroughId: "wt-a", propertyId: "prop-a" }),
    );
  });

  it("starts a walkthrough on their own house, filed under that house", async () => {
    leaderOfHouseA();
    seedsNothing();
    storageMock.createWalkthrough.mockImplementation(async (w: Record<string, unknown>) => ({ id: "wt-new", ...w }));

    const { status } = await request("POST", "/api/walkthroughs", {
      body: { propertyId: "prop-a", type: "additional", walkthroughDate: "2026-09-02" },
    });

    expect(status).toBe(200);
    expect(storageMock.createWalkthrough).toHaveBeenCalledWith(
      expect.objectContaining({
        propertyId: "prop-a",
        region: "West Central",
        buildingAddress: HOUSE_A,
        performedBy: ALICE.email,
      }),
    );
  });

  it("reads the national room-type list, which is what the add-a-room picker needs", async () => {
    leaderOfHouseA();
    storageMock.getAllWalkthroughTemplateRooms.mockResolvedValue([{ id: "t-bath", name: "Bathroom" }]);
    const { status, body } = await request("GET", "/api/walkthrough-template/rooms");
    expect(status).toBe(200);
    expect(body).toHaveLength(1);
  });

  it("cannot remove an item, even from their own current walkthrough — that is staff work", async () => {
    // 2026-09 RA review, item 1.3. A leader used to be able to prune an item
    // their house lacks; now they mark it "Not here" and ask their RA. The
    // guard sits before the item is loaded, so nothing is read or deleted.
    leaderOfHouseA();
    ownHouse();

    const { status } = await request("DELETE", "/api/walkthrough-items/item-a");

    expect(status).toBe(403);
    expect(storageMock.getWalkthroughItem).not.toHaveBeenCalled();
    expect(storageMock.deleteWalkthroughItem).not.toHaveBeenCalled();
  });

  it("lets staff remove that same item — the control that proves the delete spy fires", async () => {
    actAs(STAFF, { canViewWalkthroughs: true, canManageWalkthroughs: true, allowedRegions: ["West Central"] });
    ownHouse();

    const { status } = await request("DELETE", "/api/walkthrough-items/item-a");

    expect(status).toBe(200);
    expect(storageMock.deleteWalkthroughItem).toHaveBeenCalledWith("item-a");
  });

  // ── Standing notes (2026-09 RA review, item 6) ───────────────────────────

  it("cannot write a standing note — it is staff instruction to the household", async () => {
    leaderOfHouseA();
    ownHouse();
    const { status } = await request("PATCH", "/api/walkthrough-items/item-a", {
      body: { standingNote: "Photograph this each year" },
    });
    expect(status).toBe(403);
    expect(storageMock.updateWalkthroughItem).not.toHaveBeenCalled();
  });

  it("lets staff write one on the item — the control that proves the field reaches storage", async () => {
    actAs(STAFF, { canViewWalkthroughs: true, canManageWalkthroughs: true, allowedRegions: ["West Central"] });
    ownHouse();
    storageMock.updateWalkthroughItem.mockResolvedValue({ ...ITEM_A, standingNote: "Photograph this each year" });
    const { status } = await request("PATCH", "/api/walkthrough-items/item-a", {
      body: { standingNote: "Photograph this each year" },
    });
    expect(status).toBe(200);
    expect(storageMock.updateWalkthroughItem).toHaveBeenCalledWith("item-a", expect.objectContaining({ standingNote: "Photograph this each year" }));
  });

  // ── What else on an item a leader may write ─────────────────────────────
  //
  // A leader records condition and notes, and nothing else. The label and the
  // order carry forward into next year's walkthrough, the move-out comparison
  // and the damages worksheet, so a renamed item is a change to the house's
  // record, which is staff work. Refused rather than dropped, like the
  // standing note, so a client mistake is visible.

  it.each([
    ["label", { label: "Renamed sink" }],
    ["displayOrder", { displayOrder: 7 }],
    ["label alongside a condition", { condition: "good", label: "Renamed sink" }],
  ])("refuses a leader writing %s on an item, and writes nothing", async (_name, body) => {
    leaderOfHouseA();
    ownHouse();
    expect((await request("PATCH", "/api/walkthrough-items/item-a", { body })).status).toBe(403);
    expect(storageMock.updateWalkthroughItem).not.toHaveBeenCalled();
  });

  it("records a leader's condition and notes -- the positive control", async () => {
    leaderOfHouseA();
    ownHouse();
    storageMock.updateWalkthroughItem.mockResolvedValue({ ...ITEM_A, condition: "damaged", notes: "Hole by the door" });
    const { status } = await request("PATCH", "/api/walkthrough-items/item-a", { body: { condition: "damaged", notes: "Hole by the door" } });
    expect(status).toBe(200);
    expect(storageMock.updateWalkthroughItem).toHaveBeenCalledWith("item-a", { condition: "damaged", notes: "Hole by the door" });
  });

  it("lets staff rename an item -- the control that proves the label reaches storage", async () => {
    actAs(STAFF, { canViewWalkthroughs: true, canManageWalkthroughs: true, allowedRegions: ["West Central"] });
    ownHouse();
    storageMock.updateWalkthroughItem.mockResolvedValue({ ...ITEM_A, label: "Kitchen sink" });
    expect((await request("PATCH", "/api/walkthrough-items/item-a", { body: { label: "Kitchen sink" } })).status).toBe(200);
    expect(storageMock.updateWalkthroughItem).toHaveBeenCalledWith("item-a", expect.objectContaining({ label: "Kitchen sink" }));
  });

  // ── Submitting and reviewing (2026-09 RA review, 7.1) ────────────────────

  it("submits their own current walkthrough, and only from draft", async () => {
    leaderOfHouseA();
    ownHouse();
    storageMock.updateWalkthrough.mockResolvedValue({ ...WT_A, status: "submitted" });

    const { status } = await request("POST", "/api/walkthroughs/wt-a/submit", { body: {} });
    expect(status).toBe(200);
    expect(storageMock.updateWalkthrough).toHaveBeenCalledWith("wt-a", { status: "submitted" });
    expect(storageMock.recordAuditEvent).not.toHaveBeenCalled();

    storageMock.updateWalkthrough.mockClear();
    storageMock.getWalkthrough.mockResolvedValue({ ...WT_A, status: "submitted" });
    const again = await request("POST", "/api/walkthroughs/wt-a/submit", { body: {} });
    expect(again.status).toBe(409);
    expect(storageMock.updateWalkthrough).not.toHaveBeenCalled();
  });

  it("cannot submit a prior year — the date rule applies to submitting too", async () => {
    leaderOfHouseA();
    ownHousePriorYear();
    const { status, body } = await request("POST", "/api/walkthroughs/wt-a-prior/submit", { body: {} });
    expect(status).toBe(403);
    expect(body.message).toContain("read-only");
    expect(storageMock.updateWalkthrough).not.toHaveBeenCalled();
  });

  it("cannot mark a walkthrough reviewed — that is staff reading it over", async () => {
    leaderOfHouseA();
    storageMock.getWalkthrough.mockResolvedValue({ ...WT_A, status: "submitted" });
    const { status } = await request("POST", "/api/walkthroughs/wt-a/review", { body: {} });
    expect(status).toBe(403);
    expect(storageMock.updateWalkthrough).not.toHaveBeenCalled();
  });

  it("lets staff mark a submitted walkthrough reviewed, and refuses a draft", async () => {
    actAs(STAFF, { canViewWalkthroughs: true, canManageWalkthroughs: true, allowedRegions: ["West Central"] });
    storageMock.getWalkthrough.mockResolvedValue({ ...WT_A, status: "draft" });
    const draft = await request("POST", "/api/walkthroughs/wt-a/review", { body: {} });
    expect(draft.status).toBe(409);
    expect(storageMock.updateWalkthrough).not.toHaveBeenCalled();

    storageMock.getWalkthrough.mockResolvedValue({ ...WT_A, status: "submitted" });
    storageMock.updateWalkthrough.mockResolvedValue({ ...WT_A, status: "reviewed" });
    const { status } = await request("POST", "/api/walkthroughs/wt-a/review", { body: {} });
    expect(status).toBe(200);
    expect(storageMock.updateWalkthrough).toHaveBeenCalledWith("wt-a", { status: "reviewed" });
  });

  it("ignores a status in the body of the create and edit routes — the two routes above are its only writers", async () => {
    actAs(STAFF, { canViewWalkthroughs: true, canManageWalkthroughs: true, allowedRegions: ["West Central"] });
    ownHouse();
    seedsNothing();
    storageMock.getProperty.mockResolvedValue(PROPERTY_A);
    storageMock.createWalkthrough.mockImplementation(async (data: Record<string, unknown>) => ({ id: "wt-new", ...data }));
    storageMock.updateWalkthrough.mockResolvedValue(WT_A);

    const created = await request("POST", "/api/walkthroughs", { body: { propertyId: "prop-a", status: "reviewed" } });
    expect(created.status).toBe(200);
    const inserted = storageMock.createWalkthrough.mock.calls[0][0] as { status?: string };
    expect(inserted.status).toBeUndefined();

    const edited = await request("PATCH", "/api/walkthroughs/wt-a", { body: { status: "reviewed", notes: "Kitchen redone" } });
    expect(edited.status).toBe(200);
    // The positive control: the same PATCH still changes what it may.
    expect(storageMock.updateWalkthrough).toHaveBeenCalledWith("wt-a", expect.objectContaining({ notes: "Kitchen redone" }));
    expect((storageMock.updateWalkthrough.mock.calls[0][1] as { status?: string }).status).toBeUndefined();
  });

  // ── Dismissing an item, and raising a repair from one (2026-09 RA review) ──

  it("cannot dismiss a flagged item — deciding a hole is fine is staff work", async () => {
    leaderOfHouseA();
    ownHouse();
    const { status } = await request("POST", "/api/walkthrough-items/item-a/dismiss", { body: { reason: "Looked fine" } });
    expect(status).toBe(403);
    expect(storageMock.getWalkthroughItem).not.toHaveBeenCalled();
    expect(storageMock.updateWalkthroughItem).not.toHaveBeenCalled();
  });

  it("lets staff dismiss it with a reason, and refuses a blank one", async () => {
    actAs(STAFF, { canViewWalkthroughs: true, canManageWalkthroughs: true, allowedRegions: ["West Central"] });
    ownHouse();
    storageMock.updateWalkthroughItem.mockResolvedValue({ ...ITEM_A, dismissReason: "A scuff, not a hole" });

    const blank = await request("POST", "/api/walkthrough-items/item-a/dismiss", { body: { reason: "  " } });
    expect(blank.status).toBe(400);
    expect(storageMock.updateWalkthroughItem).not.toHaveBeenCalled();

    const { status } = await request("POST", "/api/walkthrough-items/item-a/dismiss", { body: { reason: "A scuff, not a hole" } });
    expect(status).toBe(200);
    expect(storageMock.updateWalkthroughItem).toHaveBeenCalledWith(
      "item-a",
      expect.objectContaining({ dismissReason: "A scuff, not a hole", dismissedByUserId: STAFF.id, dismissedAt: expect.any(Date) }),
    );
    expect(storageMock.recordAuditEvent).not.toHaveBeenCalled();
  });

  it("cannot raise a repair from an item — and the guard runs before the item is read", async () => {
    leaderOfHouseA();
    ownHouse();
    const { status } = await request("POST", "/api/walkthrough-items/item-a/maintenance-request", { body: {} });
    expect(status).toBe(403);
    expect(storageMock.getWalkthroughItem).not.toHaveBeenCalled();
    expect(storageMock.createMaintenanceRequest).not.toHaveBeenCalled();
    expect(storageMock.createMaintenanceRequestPhoto).not.toHaveBeenCalled();
  });

  it("lets staff raise a repair the household can read, referencing the room's photos", async () => {
    actAs(STAFF, { canViewWalkthroughs: true, canManageMaintenance: true, allowedRegions: ["West Central"] });
    ownHouse();
    storageMock.getProperty.mockResolvedValue(PROPERTY_A);
    storageMock.getWalkthroughItem.mockResolvedValue({ ...ITEM_A, condition: "damaged", notes: "Hole by the window" });
    storageMock.getMaintenanceRequestByWalkthroughItem.mockResolvedValue(undefined);
    storageMock.getWalkthroughPhotosByRoom.mockResolvedValue([
      { id: "ph-1", roomId: "room-a", imageUrl: "/uploads/aaaa.jpg", uploadedBy: "ra.west@spo.org" },
    ]);
    storageMock.createMaintenanceRequest.mockImplementation(async (data: Record<string, unknown>) => ({ id: "req-1", ...data }));
    storageMock.createMaintenanceRequestPhoto.mockResolvedValue({ id: "rp-1" });

    const { status, body } = await request("POST", "/api/walkthrough-items/item-a/maintenance-request", { body: {} });

    expect(status).toBe(201);
    expect(body.id).toBe("req-1");
    expect(storageMock.createMaintenanceRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        // A repair: the one type a household leader can read.
        type: "request",
        status: "pending",
        location: "Kitchen",
        title: "Sink — Kitchen",
        region: PROPERTY_A.region,
        buildingAddress: HOUSE_A,
        // An email, because ownsRecord compares against one.
        submittedBy: STAFF.email,
        walkthroughItemId: "item-a",
      }),
    );
    const created = storageMock.createMaintenanceRequest.mock.calls[0][0] as { description: string };
    expect(created.description).toContain('Recorded "Damaged" for Sink in the Kitchen');
    expect(created.description).toContain("Hole by the window");
    // Referenced, not re-uploaded: the existing upload's own URL.
    expect(storageMock.createMaintenanceRequestPhoto).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "req-1", imageUrl: "/uploads/aaaa.jpg" }),
    );
    expect(storageMock.createUpload).not.toHaveBeenCalled();
  });

  it("refuses staff without a walkthrough grant before the item is read", async () => {
    // The write is also a walkthrough read; the view grant is checked with
    // the other guards, ahead of every storage call.
    actAs(STAFF, { canManageMaintenance: true, allowedRegions: ["West Central"] });
    ownHouse();
    const { status } = await request("POST", "/api/walkthrough-items/item-a/maintenance-request", { body: {} });
    expect(status).toBe(403);
    expect(storageMock.getWalkthroughItem).not.toHaveBeenCalled();
    expect(storageMock.createMaintenanceRequest).not.toHaveBeenCalled();
  });

  it("answers 404, not 500, for an item whose room has no walkthrough", async () => {
    actAs(STAFF, { canViewWalkthroughs: true, canManageMaintenance: true, allowedRegions: ["all"] });
    storageMock.getWalkthroughItem.mockResolvedValue(ITEM_A);
    storageMock.getWalkthroughRoom.mockResolvedValue({ ...ROOM_A, walkthroughId: null });
    expect((await request("GET", "/api/walkthrough-items/item-a")).status).toBe(404);
    expect((await request("POST", "/api/walkthrough-items/item-a/maintenance-request", { body: {} })).status).toBe(404);
    expect(storageMock.createMaintenanceRequest).not.toHaveBeenCalled();
  });

  it("answers 409 with the existing request rather than raising a second one", async () => {
    actAs(STAFF, { canViewWalkthroughs: true, canManageMaintenance: true, allowedRegions: ["West Central"] });
    ownHouse();
    storageMock.getProperty.mockResolvedValue(PROPERTY_A);
    storageMock.getMaintenanceRequestByWalkthroughItem.mockResolvedValue({ id: "req-old" });

    const { status, body } = await request("POST", "/api/walkthrough-items/item-a/maintenance-request", { body: {} });
    expect(status).toBe(409);
    expect(body.requestId).toBe("req-old");
    expect(storageMock.createMaintenanceRequest).not.toHaveBeenCalled();
  });

  it("refuses staff outside the house's region, before anything is created", async () => {
    actAs(STAFF, { canViewWalkthroughs: true, canManageMaintenance: true, allowedRegions: ["East Central"] });
    ownHouse();
    const { status } = await request("POST", "/api/walkthrough-items/item-a/maintenance-request", { body: {} });
    expect(status).toBe(403);
    expect(storageMock.createMaintenanceRequest).not.toHaveBeenCalled();
  });

  // ── And nothing at all on anybody else's ─────────────────────────────────

  const OTHER_HOUSE_ROUTES: [string, string][] = [
    ["GET", "/api/walkthroughs/wt-b"],
    ["GET", "/api/walkthroughs/wt-b/rooms"],
    ["GET", "/api/walkthroughs/wt-b/items"],
    ["GET", "/api/walkthrough-rooms/room-b/items"],
    ["POST", "/api/walkthroughs/wt-b/rooms"],
    ["PATCH", "/api/walkthrough-items/item-b"],
    ["DELETE", "/api/walkthrough-items/item-b"],
  ];

  it.each(OTHER_HOUSE_ROUTES)("refuses another house by id: %s %s", async (method, path) => {
    leaderOfHouseA();
    otherHouse();
    const { status } = await request(method, path, method === "GET" ? undefined : { body: {} });
    expect(status).toBe(403);
    expectNoWalkthroughWrite();
    expect(storageMock.getWalkthroughRoomsByWalkthrough).not.toHaveBeenCalled();
    expect(storageMock.getWalkthroughItemsByWalkthrough).not.toHaveBeenCalled();
    expect(storageMock.getWalkthroughItemsByRoom).not.toHaveBeenCalled();
  });

  // ── Prior years are readable, and read-only ──────────────────────────────

  it("opens a prior year's walkthrough and its checklist", async () => {
    // The positive control for the refusals below: reading last year really
    // does work, so the 403s that follow are about writing and nothing else.
    leaderOfHouseA();
    ownHousePriorYear();
    storageMock.getWalkthroughRoomsByWalkthrough.mockResolvedValue([ROOM_A_PRIOR]);
    storageMock.getWalkthroughItemsByWalkthrough.mockResolvedValue([ITEM_A_PRIOR]);
    storageMock.getWalkthroughItemsByRoom.mockResolvedValue([ITEM_A_PRIOR]);

    expect((await request("GET", "/api/walkthroughs/wt-a-prior")).status).toBe(200);
    expect((await request("GET", "/api/walkthroughs/wt-a-prior/rooms")).body).toHaveLength(1);
    expect((await request("GET", "/api/walkthroughs/wt-a-prior/items")).body).toHaveLength(1);
    expect((await request("GET", "/api/walkthrough-rooms/room-a-prior/items")).body).toHaveLength(1);
  });

  it("lists prior years alongside the current one", async () => {
    leaderOfHouseA();
    storageMock.getAllWalkthroughs.mockResolvedValue([WT_A, WT_A_PRIOR, WT_B]);
    const { body } = await request("GET", "/api/walkthroughs");
    expect(body.map((w: { id: string }) => w.id)).toEqual(["wt-a", "wt-a-prior"]);
  });

  const PRIOR_YEAR_WRITES: [string, string][] = [
    ["POST", "/api/walkthroughs/wt-a-prior/rooms"],
    ["PATCH", "/api/walkthrough-items/item-a-prior"],
  ];
  // Deleting an item is staff-only outright, so a leader never reaches the
  // date rule on it; it belongs on the staff side of this pair only.
  const STAFF_PRIOR_YEAR_WRITES: [string, string][] = [
    ...PRIOR_YEAR_WRITES,
    ["DELETE", "/api/walkthrough-items/item-a-prior"],
  ];

  it.each(PRIOR_YEAR_WRITES)("refuses a leader writing to a prior year: %s %s", async (method, path) => {
    leaderOfHouseA();
    ownHousePriorYear();
    const { status, body } = await request(method, path, { body: { condition: "damaged" } });
    expect(status).toBe(403);
    expect(body.message).toContain("read-only");
    expectNoWalkthroughWrite();
  });

  it.each(STAFF_PRIOR_YEAR_WRITES)("lets staff correct a prior year: %s %s", async (method, path) => {
    // The restriction is resident-tier only, which is what makes it safe:
    // anything a leader gets wrong, their regional administrator can fix.
    actAs(STAFF, { canViewWalkthroughs: true, canManageWalkthroughs: true, allowedRegions: ["West Central"] });
    ownHousePriorYear();
    storageMock.getWalkthroughRoomsByWalkthrough.mockResolvedValue([ROOM_A_PRIOR]);
    storageMock.getWalkthroughTemplateRoom.mockResolvedValue({ id: "t-bath", name: "Bathroom" });
    storageMock.getAllWalkthroughTemplateItems.mockResolvedValue([]);
    storageMock.createWalkthroughRoom.mockResolvedValue({ id: "room-new", name: "Bathroom" });
    storageMock.updateWalkthroughItem.mockResolvedValue(ITEM_A_PRIOR);

    const { status } = await request(method, path, { body: { condition: "damaged", templateRoomId: "t-bath" } });
    expect(status).toBe(200);
  });

  it("refuses to start a walkthrough on another house", async () => {
    leaderOfHouseA();
    seedsNothing();
    const { status } = await request("POST", "/api/walkthroughs", { body: { propertyId: "prop-b" } });
    expect(status).toBe(403);
    expect(storageMock.createWalkthrough).not.toHaveBeenCalled();
  });

  it("gains no region reach from allowedRegions, however generous", async () => {
    // The failure this exists to catch: a resident falling through to the
    // region rule. "all" is the widest grant there is, and it must buy nothing.
    leaderOfHouseA({ ...COMPLETE, allowedRegions: ["all"] });
    otherHouse();
    storageMock.getAllWalkthroughs.mockResolvedValue([WT_A, WT_B]);

    expect((await request("GET", "/api/walkthroughs")).body.map((w: { id: string }) => w.id)).toEqual(["wt-a"]);
    expect((await request("GET", "/api/walkthroughs/wt-b")).status).toBe(403);
  });

  // ── Accounts that must get nothing ───────────────────────────────────────

  const OWN_HOUSE_ROUTES: [string, string][] = [
    ["GET", "/api/walkthroughs/wt-a"],
    ["GET", "/api/walkthroughs/wt-a/rooms"],
    ["GET", "/api/walkthroughs/wt-a/items"],
    ["GET", "/api/walkthrough-rooms/room-a/items"],
    ["POST", "/api/walkthroughs/wt-a/rooms"],
    ["PATCH", "/api/walkthrough-items/item-a"],
    ["DELETE", "/api/walkthrough-items/item-a"],
  ];

  it.each(OWN_HOUSE_ROUTES)("refuses a leader whose login is linked to no house: %s %s", async (method, path) => {
    // Nothing resolves to a house, so nothing is theirs -- not even the house
    // whose walkthrough the id points at.
    actAs(ALICE, COMPLETE);
    ownHouse();
    const { status } = await request(method, path, method === "GET" ? undefined : { body: {} });
    expect(status).toBe(403);
    expectNoWalkthroughWrite();
  });

  it("gives an unlinked leader an empty list rather than every house", async () => {
    // allowedRegions is deliberately the widest grant there is: if the list
    // ever fell through to the region rule for want of a house, this account
    // would receive both houses instead of neither.
    actAs(ALICE, { ...COMPLETE, allowedRegions: ["all"] });
    storageMock.getAllWalkthroughs.mockResolvedValue([WT_A, WT_B]);
    expect((await request("GET", "/api/walkthroughs")).body).toEqual([]);
  });

  it("refuses a leader whose linked property has been deleted", async () => {
    actAs({ ...ALICE, propertyId: "prop-gone" } as typeof ALICE, COMPLETE);
    storageMock.getProperty.mockResolvedValue(undefined);
    ownHouse();
    expect((await request("GET", "/api/walkthroughs/wt-a")).status).toBe(403);
  });

  it.each(OWN_HOUSE_ROUTES)("refuses a linked resident without the flag: %s %s", async (method, path) => {
    // The flag is what turns the house link into walkthrough access. Living in
    // the house is not enough on its own.
    leaderOfHouseA(ALL_MAINTENANCE);
    ownHouse();
    const { status } = await request(method, path, method === "GET" ? undefined : { body: {} });
    expect(status).toBe(403);
    expectNoWalkthroughWrite();
  });

  it("will not accept a staff walkthrough flag on a resident account", async () => {
    // A resident row carrying canManageWalkthroughs must not be read as the
    // staff grant, or the region path would come with it.
    leaderOfHouseA({ canViewWalkthroughs: true, canManageWalkthroughs: true, allowedRegions: ["all"] });
    ownHouse();
    expect((await request("GET", "/api/walkthroughs/wt-a")).status).toBe(403);
  });

  // ── The routes a leader still cannot reach at all ────────────────────────

  it.each([
    ["PATCH", "/api/walkthroughs/wt-a"],
    ["DELETE", "/api/walkthroughs/wt-a"],
    ["POST", "/api/walkthroughs/wt-a/review"],
    ["POST", "/api/walkthrough-items"],
    ["DELETE", "/api/walkthrough-items/item-a"],
    ["POST", "/api/walkthrough-items/item-a/dismiss"],
    ["DELETE", "/api/walkthrough-items/item-a/dismiss"],
    ["POST", "/api/walkthrough-items/item-a/maintenance-request"],
    ["POST", "/api/walkthrough-rooms"],
    ["PATCH", "/api/walkthrough-rooms/room-a"],
    ["DELETE", "/api/walkthrough-rooms/room-a"],
    ["GET", "/api/walkthrough-photos"],
    ["GET", "/api/walkthrough-photos/room/room-a"],
    ["POST", "/api/walkthrough-photos"],
    ["GET", "/api/walkthrough-template/items"],
    ["POST", "/api/walkthrough-template/rooms"],
  ] as [string, string][])(
    "refuses a leader on a staff-only walkthrough route: %s %s",
    async (method, path) => {
      // Completing a walkthrough is not managing one. Editing the record
      // itself, the rooms, the photos and the national template all stay with
      // staff, so the grant widens nothing beyond filling in the checklist.
      leaderOfHouseA();
      ownHouse();
      const { status } = await request(method, path, method === "GET" ? undefined : { body: {} });
      expect(status).toBe(403);
      expectNoWalkthroughWrite();
      expect(storageMock.createWalkthroughPhoto).not.toHaveBeenCalled();
      expect(storageMock.createMaintenanceRequest).not.toHaveBeenCalled();
      expect(storageMock.updateWalkthroughRoom).not.toHaveBeenCalled();
      expect(storageMock.deleteWalkthroughRoom).not.toHaveBeenCalled();
      expect(storageMock.createWalkthroughTemplateRoom).not.toHaveBeenCalled();
    },
  );
});

/**
 * The national walkthrough template.
 *
 * The interesting boundary here is not resident-versus-staff, it is
 * regional-versus-national. A regional administrator holding
 * canManageWalkthroughs manages their own houses; this template reaches every
 * region, so changing it takes admin. Those are the tests that matter.
 */
describe("the national walkthrough template", () => {
  const MANAGE = { canViewWalkthroughs: true, canManageWalkthroughs: true };
  const T_ROOM = { id: "t-bath", name: "Bathroom", includeByDefault: true, displayOrder: 1 };
  const T_ITEM = { id: "ti-1", templateRoomId: "t-bath", label: "Toilet", displayOrder: 0 };

  const MUTATIONS: [string, string, Record<string, unknown>][] = [
    ["POST", "/api/walkthrough-template/rooms", { name: "Attic", displayOrder: 0 }],
    ["PATCH", "/api/walkthrough-template/rooms/t-bath", { name: "Bath" }],
    ["DELETE", "/api/walkthrough-template/rooms/t-bath", {}],
    ["POST", "/api/walkthrough-template/items", { templateRoomId: "t-bath", label: "Fan", displayOrder: 0 }],
    ["PATCH", "/api/walkthrough-template/items/ti-1", { label: "Extractor fan" }],
    ["DELETE", "/api/walkthrough-template/items/ti-1", {}],
  ];

  const primeTemplate = () => {
    storageMock.getWalkthroughTemplateRoom.mockResolvedValue(T_ROOM);
    storageMock.getWalkthroughTemplateItem.mockResolvedValue(T_ITEM);
  };

  const expectNoTemplateWrite = () => {
    expect(storageMock.createWalkthroughTemplateRoom).not.toHaveBeenCalled();
    expect(storageMock.updateWalkthroughTemplateRoom).not.toHaveBeenCalled();
    expect(storageMock.deleteWalkthroughTemplateRoom).not.toHaveBeenCalled();
    expect(storageMock.createWalkthroughTemplateItem).not.toHaveBeenCalled();
    expect(storageMock.updateWalkthroughTemplateItem).not.toHaveBeenCalled();
    expect(storageMock.deleteWalkthroughTemplateItem).not.toHaveBeenCalled();
  };

  it.each(MUTATIONS)("refuses an anonymous caller: %s %s", async (method, path, body) => {
    const { status } = await request(method, path, { body });
    expect(status).toBe(401);
    expectNoTemplateWrite();
  });

  it.each(MUTATIONS)("refuses a resident: %s %s", async (method, path, body) => {
    actAs(ALICE, ALL_MAINTENANCE);
    primeTemplate();
    const { status } = await request(method, path, { body });
    expect(status).toBe(403);
    expectNoTemplateWrite();
  });

  it.each(MUTATIONS)(
    "refuses a regional administrator who manages walkthroughs: %s %s",
    async (method, path, body) => {
      // The boundary this whole block exists for. canManageWalkthroughs is a
      // grant over your own houses; the template is national, so it is not
      // enough here. A regional lead editing it would change every region.
      actAs(STAFF, { ...MANAGE, allowedRegions: ["West Central"] });
      primeTemplate();
      const { status } = await request(method, path, { body });
      expect(status).toBe(403);
      expectNoTemplateWrite();
    },
  );

  it.each(MUTATIONS)("lets an admin through: %s %s", async (method, path, body) => {
    // The positive control. Without it every refusal above could be passing
    // because the request was malformed rather than because a guard ran.
    actAs(ADMIN);
    primeTemplate();
    storageMock.createWalkthroughTemplateRoom.mockResolvedValue(T_ROOM);
    storageMock.updateWalkthroughTemplateRoom.mockResolvedValue(T_ROOM);
    storageMock.createWalkthroughTemplateItem.mockResolvedValue(T_ITEM);
    storageMock.updateWalkthroughTemplateItem.mockResolvedValue(T_ITEM);

    const { status } = await request(method, path, { body });
    expect(status).toBe(200);
  });

  it("lets a regional administrator READ the template", async () => {
    // Refusing this would stop an RA picking a room type at all.
    actAs(STAFF, { ...MANAGE, allowedRegions: ["West Central"] });
    storageMock.getAllWalkthroughTemplateRooms.mockResolvedValue([T_ROOM]);
    const { status, body } = await request("GET", "/api/walkthrough-template/rooms");
    expect(status).toBe(200);
    expect(body).toHaveLength(1);
  });

  it("refuses a resident the template list", async () => {
    actAs(ALICE, ALL_MAINTENANCE);
    expect((await request("GET", "/api/walkthrough-template/rooms")).status).toBe(403);
    expect((await request("GET", "/api/walkthrough-template/items")).status).toBe(403);
  });

  it("will not move a template item between room types", async () => {
    actAs(ADMIN);
    primeTemplate();
    storageMock.updateWalkthroughTemplateItem.mockResolvedValue(T_ITEM);

    await request("PATCH", "/api/walkthrough-template/items/ti-1", {
      body: { label: "Extractor fan", templateRoomId: "t-kitchen" },
    });

    expect(storageMock.updateWalkthroughTemplateItem.mock.calls[0][1]).toEqual({ label: "Extractor fan" });
  });

  it("404s an item added to a room type that does not exist", async () => {
    actAs(ADMIN);
    storageMock.getWalkthroughTemplateRoom.mockResolvedValue(undefined);
    const { status } = await request("POST", "/api/walkthrough-template/items", {
      body: { templateRoomId: "nope", label: "Fan", displayOrder: 0 },
    });
    expect(status).toBe(404);
    expect(storageMock.createWalkthroughTemplateItem).not.toHaveBeenCalled();
  });
});

/**
 * What a new walkthrough starts out containing.
 *
 * The planning rules are covered without HTTP in walkthroughTemplate.test.ts.
 * What only a real request shows is which SOURCE the route picks -- template on
 * a property's first walkthrough, that property's own last one afterwards --
 * and that a seeding failure does not cost the RA the walkthrough itself.
 */
describe("seeding a new walkthrough", () => {
  const MANAGE = { canViewWalkthroughs: true, canManageWalkthroughs: true };
  const WEST_PROPERTY = { id: "prop-west", name: "Cleveland House", region: "West Central", address: "1 Main St" };
  const T_ROOMS = [
    { id: "t-kitchen", name: "Kitchen", includeByDefault: true, displayOrder: 0 },
    { id: "t-garage", name: "Garage", includeByDefault: false, displayOrder: 9 },
  ];
  const T_ITEMS = [
    { id: "i1", templateRoomId: "t-kitchen", label: "Sink", displayOrder: 0 },
    { id: "i2", templateRoomId: "t-garage", label: "Door opener", displayOrder: 0 },
  ];

  const readyToCreate = () => {
    actAs(STAFF, { ...MANAGE, allowedRegions: ["West Central"] });
    storageMock.getProperty.mockResolvedValue(WEST_PROPERTY);
    storageMock.createWalkthrough.mockImplementation(async (w: Record<string, unknown>) => ({ id: "wt-new", ...w }));
    storageMock.createWalkthroughRoom.mockImplementation(async (r: Record<string, unknown>) => ({ id: `room-${(r as { name: string }).name}`, ...r }));
    storageMock.createWalkthroughItem.mockResolvedValue({ id: "item-new" });
  };

  const createdRoomNames = () =>
    storageMock.createWalkthroughRoom.mock.calls.map((c: unknown[]) => (c[0] as { name: string }).name);
  const createdItemLabels = () =>
    storageMock.createWalkthroughItem.mock.calls.map((c: unknown[]) => (c[0] as { label: string }).label);

  it("copies the national template on a property's first walkthrough", async () => {
    readyToCreate();
    storageMock.getWalkthroughsByProperty.mockResolvedValue([]);
    storageMock.getAllWalkthroughTemplateRooms.mockResolvedValue(T_ROOMS);
    storageMock.getAllWalkthroughTemplateItems.mockResolvedValue(T_ITEMS);

    const { status, body } = await request("POST", "/api/walkthroughs", { body: { propertyId: "prop-west" } });

    expect(status).toBe(200);
    expect(body.roomsCreated).toBe(1);
    expect(createdRoomNames()).toEqual(["Kitchen"]);
    expect(createdItemLabels()).toEqual(["Sink"]);
  });

  it("leaves a non-standard room type out of a first walkthrough", async () => {
    readyToCreate();
    storageMock.getWalkthroughsByProperty.mockResolvedValue([]);
    storageMock.getAllWalkthroughTemplateRooms.mockResolvedValue(T_ROOMS);
    storageMock.getAllWalkthroughTemplateItems.mockResolvedValue(T_ITEMS);

    await request("POST", "/api/walkthroughs", { body: { propertyId: "prop-west" } });

    expect(createdRoomNames()).not.toContain("Garage");
    expect(createdItemLabels()).not.toContain("Door opener");
  });

  it("copies the property's own last walkthrough, not the template, on a repeat", async () => {
    // The rule that makes editing worth doing: once an RA has deleted the
    // smoke detector this house lacks and added the porch it has, that shape
    // comes back next year rather than the national default.
    readyToCreate();
    storageMock.getWalkthroughsByProperty.mockResolvedValue([
      { id: "wt-last", propertyId: "prop-west", region: "West Central" },
    ]);
    storageMock.getWalkthroughRoomsByWalkthrough.mockResolvedValue([
      { id: "r-porch", name: "Porch", displayOrder: 0 },
    ]);
    storageMock.getWalkthroughItemsByRoom.mockResolvedValue([
      { roomId: "r-porch", label: "Railing", displayOrder: 0, condition: "damaged", notes: "Loose" },
    ]);

    const { body } = await request("POST", "/api/walkthroughs", { body: { propertyId: "prop-west" } });

    expect(body.roomsCreated).toBe(1);
    expect(createdRoomNames()).toEqual(["Porch"]);
    expect(storageMock.getAllWalkthroughTemplateRooms).not.toHaveBeenCalled();
  });

  it("does not carry last year's condition or notes into the new walkthrough", async () => {
    // A new walkthrough starts unassessed. Inheriting "damaged" would present
    // a stale judgement as this year's finding.
    readyToCreate();
    storageMock.getWalkthroughsByProperty.mockResolvedValue([{ id: "wt-last", propertyId: "prop-west" }]);
    storageMock.getWalkthroughRoomsByWalkthrough.mockResolvedValue([{ id: "r-porch", name: "Porch", displayOrder: 0 }]);
    storageMock.getWalkthroughItemsByRoom.mockResolvedValue([
      { roomId: "r-porch", label: "Railing", displayOrder: 0, condition: "damaged", notes: "Loose" },
    ]);

    await request("POST", "/api/walkthroughs", { body: { propertyId: "prop-west" } });

    const item = storageMock.createWalkthroughItem.mock.calls[0][0];
    expect(item).not.toHaveProperty("condition");
    expect(item).not.toHaveProperty("notes");
  });

  it("never copies photos", async () => {
    readyToCreate();
    storageMock.getWalkthroughsByProperty.mockResolvedValue([{ id: "wt-last", propertyId: "prop-west" }]);
    storageMock.getWalkthroughRoomsByWalkthrough.mockResolvedValue([{ id: "r-porch", name: "Porch", displayOrder: 0 }]);
    storageMock.getWalkthroughItemsByRoom.mockResolvedValue([]);

    await request("POST", "/api/walkthroughs", { body: { propertyId: "prop-west" } });

    expect(storageMock.createWalkthroughPhoto).not.toHaveBeenCalled();
  });

  it("still creates the walkthrough when seeding fails", async () => {
    // The walkthrough row already exists by the time seeding runs. A 500 here
    // would tell an RA the whole thing failed when it did not, and they would
    // start a second one.
    readyToCreate();
    storageMock.getWalkthroughsByProperty.mockRejectedValue(new Error("template unreachable"));

    const { status, body } = await request("POST", "/api/walkthroughs", { body: { propertyId: "prop-west" } });

    expect(status).toBe(200);
    expect(body.id).toBe("wt-new");
    expect(body.roomsCreated).toBe(0);
  });

  it("creates an empty walkthrough when the template is empty", async () => {
    readyToCreate();
    storageMock.getWalkthroughsByProperty.mockResolvedValue([]);
    storageMock.getAllWalkthroughTemplateRooms.mockResolvedValue([]);
    storageMock.getAllWalkthroughTemplateItems.mockResolvedValue([]);

    const { status, body } = await request("POST", "/api/walkthroughs", { body: { propertyId: "prop-west" } });

    expect(status).toBe(200);
    expect(body.roomsCreated).toBe(0);
    expect(storageMock.createWalkthroughRoom).not.toHaveBeenCalled();
  });
});

/**
 * Adding a room to an existing walkthrough, prefilled from a room type.
 */
describe("adding a room to a walkthrough", () => {
  const MANAGE = { canViewWalkthroughs: true, canManageWalkthroughs: true };
  const WEST_WT = { id: "wt-west", propertyId: "prop-west", region: "West Central", buildingAddress: "1 Main St" };
  const EAST_WT = { id: "wt-east", propertyId: "prop-east", region: "East Central", buildingAddress: "2 River Rd" };
  const T_BATH = { id: "t-bath", name: "Bathroom", includeByDefault: true, displayOrder: 1 };
  const T_ITEMS = [
    { id: "i1", templateRoomId: "t-bath", label: "Sink", displayOrder: 0 },
    { id: "i2", templateRoomId: "t-bath", label: "Toilet", displayOrder: 1 },
    { id: "i3", templateRoomId: "t-kitchen", label: "Range", displayOrder: 0 },
  ];

  const westLead = () => actAs(STAFF, { ...MANAGE, allowedRegions: ["West Central"] });

  it("prefills the room type's standard items", async () => {
    westLead();
    storageMock.getWalkthrough.mockResolvedValue(WEST_WT);
    storageMock.getWalkthroughTemplateRoom.mockResolvedValue(T_BATH);
    storageMock.getAllWalkthroughTemplateItems.mockResolvedValue(T_ITEMS);
    storageMock.getWalkthroughRoomsByWalkthrough.mockResolvedValue([]);
    storageMock.createWalkthroughRoom.mockResolvedValue({ id: "room-new", name: "Bathroom" });
    storageMock.createWalkthroughItem.mockResolvedValue({ id: "item-new" });

    const { status, body } = await request("POST", "/api/walkthroughs/wt-west/rooms", {
      body: { templateRoomId: "t-bath" },
    });

    expect(status).toBe(200);
    expect(body.itemsCreated).toBe(2);
    expect(storageMock.createWalkthroughItem.mock.calls.map((c: unknown[]) => (c[0] as { label: string }).label))
      .toEqual(["Sink", "Toilet"]);
  });

  it("does not leak another room type's items", async () => {
    westLead();
    storageMock.getWalkthrough.mockResolvedValue(WEST_WT);
    storageMock.getWalkthroughTemplateRoom.mockResolvedValue(T_BATH);
    storageMock.getAllWalkthroughTemplateItems.mockResolvedValue(T_ITEMS);
    storageMock.getWalkthroughRoomsByWalkthrough.mockResolvedValue([]);
    storageMock.createWalkthroughRoom.mockResolvedValue({ id: "room-new", name: "Bathroom" });
    storageMock.createWalkthroughItem.mockResolvedValue({ id: "item-new" });

    await request("POST", "/api/walkthroughs/wt-west/rooms", { body: { templateRoomId: "t-bath" } });

    expect(storageMock.createWalkthroughItem.mock.calls.map((c: unknown[]) => (c[0] as { label: string }).label))
      .not.toContain("Range");
  });

  it("adds a plain named room with no items", async () => {
    westLead();
    storageMock.getWalkthrough.mockResolvedValue(WEST_WT);
    storageMock.getWalkthroughRoomsByWalkthrough.mockResolvedValue([]);
    storageMock.createWalkthroughRoom.mockResolvedValue({ id: "room-new", name: "Boot room" });

    const { status, body } = await request("POST", "/api/walkthroughs/wt-west/rooms", {
      body: { name: "Boot room" },
    });

    expect(status).toBe(200);
    expect(body.itemsCreated).toBe(0);
    expect(storageMock.createWalkthroughItem).not.toHaveBeenCalled();
  });

  it("refuses a request with neither a name nor a room type", async () => {
    westLead();
    storageMock.getWalkthrough.mockResolvedValue(WEST_WT);
    storageMock.getWalkthroughRoomsByWalkthrough.mockResolvedValue([]);

    const { status } = await request("POST", "/api/walkthroughs/wt-west/rooms", { body: {} });
    expect(status).toBe(400);
    expect(storageMock.createWalkthroughRoom).not.toHaveBeenCalled();
  });

  it("refuses a walkthrough in another region, and creates nothing", async () => {
    westLead();
    storageMock.getWalkthrough.mockResolvedValue(EAST_WT);

    const { status } = await request("POST", "/api/walkthroughs/wt-east/rooms", {
      body: { templateRoomId: "t-bath" },
    });

    expect(status).toBe(403);
    expect(storageMock.createWalkthroughRoom).not.toHaveBeenCalled();
    expect(storageMock.createWalkthroughItem).not.toHaveBeenCalled();
  });

  it("refuses a resident", async () => {
    actAs(ALICE, ALL_MAINTENANCE);
    storageMock.getWalkthrough.mockResolvedValue(WEST_WT);
    const { status } = await request("POST", "/api/walkthroughs/wt-west/rooms", { body: { name: "Boot room" } });
    expect(status).toBe(403);
    expect(storageMock.createWalkthroughRoom).not.toHaveBeenCalled();
  });

  it("takes the house from the walkthrough, not the caller", async () => {
    westLead();
    storageMock.getWalkthrough.mockResolvedValue(WEST_WT);
    storageMock.getWalkthroughRoomsByWalkthrough.mockResolvedValue([]);
    storageMock.createWalkthroughRoom.mockResolvedValue({ id: "room-new", name: "Boot room" });

    await request("POST", "/api/walkthroughs/wt-west/rooms", {
      body: { name: "Boot room", propertyId: "prop-east", buildingAddress: "2 River Rd" },
    });

    expect(storageMock.createWalkthroughRoom).toHaveBeenCalledWith(
      expect.objectContaining({ propertyId: "prop-west", buildingAddress: "1 Main St" }),
    );
  });
});

describe("the per-property setup checklist", () => {
  const WEST = { id: "prop-west", name: "Cleveland House", region: "West Central", address: "1 Main St", ownership: "owned" };
  const EAST = { id: "prop-east", name: "Como House", region: "East Central", address: "2 River Rd", ownership: "rented" };

  const SETUP = { canManagePropertySetup: true, canViewProperties: true };

  const westLead = (permissions: Record<string, unknown> = SETUP) =>
    actAs(STAFF, { ...permissions, allowedRegions: ["West Central"] });

  beforeEach(() => {
    storageMock.getProperty.mockImplementation(async (id: string) =>
      id === "prop-west" ? WEST : id === "prop-east" ? EAST : undefined,
    );
    storageMock.getPropertySetupItems.mockResolvedValue([]);
    storageMock.setPropertySetupItem.mockImplementation(async (propertyId, itemKey, patch) => ({
      id: "setup-1",
      propertyId,
      itemKey,
      ...patch,
    }));
  });

  const setItem = (propertyId: string, itemKey: string, body: unknown) =>
    request("PUT", `/api/properties/${propertyId}/setup/${itemKey}`, { body });

  // ── The three layers ─────────────────────────────────────────────────────

  it("refuses an anonymous caller on both the read and the write", async () => {
    expect((await get("/api/properties/prop-west/setup")).status).toBe(401);
    expect((await setItem("prop-west", "electric", { status: "done" })).status).toBe(401);
  });

  it("refuses a resident, without reading the checklist", async () => {
    actAs(ALICE, ALL_MAINTENANCE);
    expect((await get("/api/properties/prop-west/setup")).status).toBe(403);
    expect(storageMock.getPropertySetupItems).not.toHaveBeenCalled();
  });

  it("refuses staff holding no property-setup permission, without writing", async () => {
    westLead({ canViewProperties: true });
    const { status } = await setItem("prop-west", "electric", { status: "done" });
    expect(status).toBe(403);
    expect(storageMock.setPropertySetupItem).not.toHaveBeenCalled();
  });

  it("refuses a house in another region, without writing", async () => {
    westLead();
    const { status } = await setItem("prop-east", "electric", { status: "done" });
    expect(status).toBe(403);
    expect(storageMock.setPropertySetupItem).not.toHaveBeenCalled();
  });

  // The positive control: without it every "not called" above could pass on a
  // typo in the storage method name.
  it("lets a regional lead set an item on a house they cover", async () => {
    westLead();
    const { status } = await setItem("prop-west", "electric", { status: "done", note: "Xcel, in SPO's name" });
    expect(status).toBe(200);
    expect(storageMock.setPropertySetupItem).toHaveBeenCalled();
  });

  // ── Server-owned attribution ─────────────────────────────────────────────

  it("takes who set it and when from the session, never from the body", async () => {
    // "Who said the gas was on" is worthless if the client is the one saying.
    westLead();
    await setItem("prop-west", "gas", {
      status: "done",
      setByUserId: "u-somebody-else",
      setAt: "1999-01-01T00:00:00.000Z",
    });
    const [, , patch] = storageMock.setPropertySetupItem.mock.calls[0];
    expect(patch.setByUserId).toBe(STAFF.id);
    expect(patch.setAt.getTime()).toBeGreaterThan(new Date("2020-01-01").getTime());
  });

  it("takes the region from the property, never from the body", async () => {
    westLead();
    await setItem("prop-west", "water", { status: "done", region: "East Central" });
    const [, , patch] = storageMock.setPropertySetupItem.mock.calls[0];
    expect(patch.region).toBe("West Central");
  });

  // ── Input validation ─────────────────────────────────────────────────────

  it("refuses a status outside the three the checklist has", async () => {
    westLead();
    const { status } = await setItem("prop-west", "electric", { status: "probably" });
    expect(status).toBe(400);
    expect(storageMock.setPropertySetupItem).not.toHaveBeenCalled();
  });

  it("refuses an item key that is not in the checklist", async () => {
    // The list is fixed in code. Accepting an arbitrary key would let a caller
    // write rows nothing ever reads, and the summary would silently ignore them.
    westLead();
    const { status } = await setItem("prop-west", "buy_a_yacht", { status: "done" });
    expect(status).toBe(400);
    expect(storageMock.setPropertySetupItem).not.toHaveBeenCalled();
  });

  it("refuses an item belonging to the other kind of house", async () => {
    // prop-west is owned, so it is never asked for a lease.
    westLead();
    const { status } = await setItem("prop-west", "lease_on_file", { status: "done" });
    expect(status).toBe(400);
    expect(storageMock.setPropertySetupItem).not.toHaveBeenCalled();
  });

  it("answers 404 for a house that does not exist, without writing", async () => {
    westLead();
    const { status } = await setItem("prop-nowhere", "electric", { status: "done" });
    expect(status).toBe(404);
    expect(storageMock.setPropertySetupItem).not.toHaveBeenCalled();
  });

  // ── The list behind the badge on the property row ────────────────────────

  it("refuses an anonymous caller on the list", async () => {
    expect((await get("/api/property-setup-items")).status).toBe(401);
  });

  it("refuses a resident the list, without reading it", async () => {
    actAs(ALICE, ALL_MAINTENANCE);
    expect((await get("/api/property-setup-items")).status).toBe(403);
    expect(storageMock.getAllPropertySetupItems).not.toHaveBeenCalled();
  });

  it("gives a regional lead only their own regions' rows", async () => {
    westLead();
    storageMock.getAllPropertySetupItems.mockResolvedValue([
      { id: "si-w", propertyId: "prop-west", itemKey: "electric", status: "open", region: "West Central" },
      { id: "si-e", propertyId: "prop-east", itemKey: "electric", status: "open", region: "East Central" },
    ]);
    const { status, body } = await get("/api/property-setup-items");
    expect(status).toBe(200);
    expect(body.map((r: { id: string }) => r.id)).toEqual(["si-w"]);
  });

  it("gives a staff account with no regions an empty list, never everything", async () => {
    actAs(STAFF, { ...SETUP, allowedRegions: [] });
    storageMock.getAllPropertySetupItems.mockResolvedValue([
      { id: "si-w", propertyId: "prop-west", itemKey: "electric", status: "open", region: "West Central" },
    ]);
    expect((await get("/api/property-setup-items")).body).toEqual([]);
  });

  // ── Seeding on creation ──────────────────────────────────────────────────

  it("seeds the checklist when a house is created", async () => {
    actAs(ADMIN);
    storageMock.createProperty.mockResolvedValue({ ...WEST, id: "prop-new" });
    storageMock.createPropertySetupItems.mockResolvedValue([]);

    const { status } = await request("POST", "/api/properties", {
      body: {
        name: "New House",
        streetAddress: "9 Oak Ave",
        city: "St Paul",
        state: "MN",
        zipCode: "55104",
        region: "West Central",
        chapter: "St Paul",
        ownership: "owned",
      },
    });

    expect(status).toBe(200);
    const [rows] = storageMock.createPropertySetupItems.mock.calls[0];
    const keys = rows.map((r: { itemKey: string }) => r.itemKey);
    // The four utilities are separate entries; one combined checkbox hides
    // which one is missing.
    expect(keys).toEqual(expect.arrayContaining(["electric", "gas", "water", "internet"]));
    // An owned house is never asked for a lease.
    expect(keys).not.toContain("lease_on_file");
    expect(rows.every((r: { status: string }) => r.status === "open")).toBe(true);
  });

  it("refuses to create a house with no chapter", async () => {
    // Required to save, alongside the address parts, region and ownership.
    actAs(ADMIN);
    const { status } = await request("POST", "/api/properties", {
      body: {
        name: "New House",
        streetAddress: "9 Oak Ave",
        city: "St Paul",
        state: "MN",
        zipCode: "55104",
        region: "West Central",
        ownership: "owned",
      },
    });
    expect(status).toBe(400);
    expect(storageMock.createProperty).not.toHaveBeenCalled();
  });

  it("still creates the house when seeding the checklist fails", async () => {
    // The checklist is a convenience. A house that exists without one is
    // recoverable; a create that half-succeeded and reported failure is not.
    actAs(ADMIN);
    storageMock.createProperty.mockResolvedValue({ ...WEST, id: "prop-new" });
    storageMock.createPropertySetupItems.mockRejectedValue(new Error("nope"));

    const { status } = await request("POST", "/api/properties", {
      body: {
        name: "New House",
        streetAddress: "9 Oak Ave",
        city: "St Paul",
        state: "MN",
        zipCode: "55104",
        region: "West Central",
        chapter: "St Paul",
        ownership: "owned",
      },
    });
    expect(status).toBe(200);
  });
});

describe("who may read the activity log", () => {
  const EVENT = {
    id: "evt-1",
    createdAt: "2026-08-20T09:00:00.000Z",
    actorId: ADMIN.id,
    actorEmail: ADMIN.email,
    action: "invoice.deleted",
    entityType: "invoice",
    entityId: "inv-1",
    summary: "Deleted invoice INV-1",
    details: null,
  };

  beforeEach(() => {
    storageMock.listAuditEvents.mockResolvedValue({ events: [EVENT], total: 1 });
  });

  it("gives an administrator a page of activity", async () => {
    actAs(ADMIN);
    const { status, body } = await get("/api/audit-log");
    expect(status).toBe(200);
    expect(body).toMatchObject({ total: 1, page: 1, pageSize: 25 });
    expect(body.events).toHaveLength(1);
  });

  it("refuses a regional administrator, however broad their permissions", async () => {
    // The trail names who did what across every region, so it is withheld
    // rather than filtered down to the regions they administer.
    actAs(STAFF, {
      ...ALL_MAINTENANCE,
      canManageUsers: true,
      canViewBilling: true,
      allowedRegions: ["West Central", "East Central"],
    });
    const { status } = await get("/api/audit-log");
    expect(status).toBe(403);
    expect(storageMock.listAuditEvents).not.toHaveBeenCalled();
  });

  it("refuses a resident", async () => {
    actAs(ALICE);
    expect((await get("/api/audit-log")).status).toBe(403);
    expect(storageMock.listAuditEvents).not.toHaveBeenCalled();
  });

  it("refuses a deactivated administrator", async () => {
    actAs({ ...ADMIN, isActive: false });
    expect((await get("/api/audit-log")).status).toBe(403);
    expect(storageMock.listAuditEvents).not.toHaveBeenCalled();
  });
});

describe("paging and filtering the activity log", () => {
  beforeEach(() => {
    actAs(ADMIN);
    storageMock.listAuditEvents.mockResolvedValue({ events: [], total: 0 });
  });

  /** The query the route asked the storage layer for. */
  const askedFor = () => storageMock.listAuditEvents.mock.calls[0][0];

  it("asks for a bounded page even when the caller asks for none", async () => {
    await get("/api/audit-log");
    expect(askedFor()).toMatchObject({ limit: 25, offset: 0 });
  });

  it("turns a page number into an offset", async () => {
    await get("/api/audit-log?page=3&pageSize=10");
    expect(askedFor()).toMatchObject({ limit: 10, offset: 20 });
  });

  it("refuses a page size larger than the cap rather than serving the whole table", async () => {
    const { status } = await get("/api/audit-log?pageSize=100000");
    expect(status).toBe(400);
    expect(storageMock.listAuditEvents).not.toHaveBeenCalled();
  });

  it("refuses a page size or page number that is not a positive whole number", async () => {
    expect((await get("/api/audit-log?page=0")).status).toBe(400);
    expect((await get("/api/audit-log?pageSize=-5")).status).toBe(400);
    expect((await get("/api/audit-log?page=all")).status).toBe(400);
    expect(storageMock.listAuditEvents).not.toHaveBeenCalled();
  });

  it("passes the person and action filters through", async () => {
    await get("/api/audit-log?actor=admin%40example.com&action=invoice.deleted");
    expect(askedFor()).toMatchObject({
      actorEmail: "admin@example.com",
      action: "invoice.deleted",
    });
  });

  it("refuses an action outside the recorded vocabulary", async () => {
    const { status } = await get("/api/audit-log?action=invoice.exploded");
    expect(status).toBe(400);
    expect(storageMock.listAuditEvents).not.toHaveBeenCalled();
  });

  it("treats an empty filter as no filter at all", async () => {
    const { status } = await get("/api/audit-log?actor=&action=&from=&to=");
    expect(status).toBe(200);
    expect(askedFor().actorEmail).toBeUndefined();
    expect(askedFor().action).toBeUndefined();
    expect(askedFor().from).toBeUndefined();
    expect(askedFor().to).toBeUndefined();
  });

  it("includes the whole of the day the reader chose as the end of the range", async () => {
    await get("/api/audit-log?from=2026-08-01&to=2026-08-31");
    const { from, to } = askedFor();
    expect(from.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    // Exclusive, and the day after the one asked for -- an event recorded at
    // 23:59 on the 31st is inside the range the reader described.
    expect(to.toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });

  it("takes the reader's own midnights as exact bounds", async () => {
    // What the activity page sends from Chicago for Sep 27 to Sep 27: local
    // midnight to the next local midnight. Read as UTC days instead, an
    // event at 8pm Central on the 27th (01:00Z on the 28th) fell outside.
    await get("/api/audit-log?from=2026-09-27T05:00:00.000Z&to=2026-09-28T05:00:00.000Z");
    const { from, to } = askedFor();
    expect(from.toISOString()).toBe("2026-09-27T05:00:00.000Z");
    expect(to.toISOString()).toBe("2026-09-28T05:00:00.000Z");
  });

  it("refuses a bound that is neither a calendar day nor a timestamp", async () => {
    expect((await get("/api/audit-log?from=last-tuesday")).status).toBe(400);
    expect((await get("/api/audit-log?to=2026-13-45x")).status).toBe(400);
    expect((await get("/api/audit-log?to=2026-09-28T99:00:00.000Z")).status).toBe(400);
    expect(storageMock.listAuditEvents).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 9. Input validation and server-owned attribution
//
// These do not test access control -- they test that the create endpoints
// accept the payload the client actually sends (numbers for money, date
// strings for dates), reject nonsensical values (negatives), and never let a
// caller name someone else as the author of a photo.
// ---------------------------------------------------------------------------

describe("what an RA knows about a contractor", () => {
  const WEST_CONTACT = { id: "c-west", name: "Dana Ruiz", company: "Ruiz Plumbing", region: "West Central" };
  const EAST_CONTACT = { id: "c-east", name: "Sam Fox", company: "Fox HVAC", region: "East Central" };

  const CONTACTS = { canViewContacts: true, canManageContacts: true };
  const westLead = (permissions: Record<string, unknown> = CONTACTS) =>
    actAs(STAFF, { ...permissions, allowedRegions: ["West Central"] });

  beforeEach(() => {
    storageMock.getMaintenanceContact.mockImplementation(async (id: string) =>
      id === "c-west" ? WEST_CONTACT : id === "c-east" ? EAST_CONTACT : undefined,
    );
    storageMock.getRequestsForContact.mockResolvedValue([]);
    storageMock.getContactNotes.mockResolvedValue([]);
    storageMock.createContactNote.mockImplementation(async (note) => ({ id: "note-1", ...note }));
  });

  // ── Reading their history ────────────────────────────────────────────────

  it("refuses an anonymous caller on both reads", async () => {
    expect((await get("/api/contacts/c-west/requests")).status).toBe(401);
    expect((await get("/api/contacts/c-west/notes")).status).toBe(401);
  });

  it("refuses a resident, without reading anything", async () => {
    actAs(ALICE, ALL_MAINTENANCE);
    expect((await get("/api/contacts/c-west/requests")).status).toBe(403);
    expect(storageMock.getRequestsForContact).not.toHaveBeenCalled();
  });

  it("refuses a contractor in another region, without reading their history", async () => {
    westLead();
    expect((await get("/api/contacts/c-east/requests")).status).toBe(403);
    expect(storageMock.getRequestsForContact).not.toHaveBeenCalled();
  });

  it("gives a lead the requests a contractor in their region touched", async () => {
    westLead();
    storageMock.getRequestsForContact.mockResolvedValue([
      { id: "req-1", title: "Leaky tap", region: "West Central" },
    ]);
    const { status, body } = await get("/api/contacts/c-west/requests");
    expect(status).toBe(200);
    expect(body.map((r: { id: string }) => r.id)).toEqual(["req-1"]);
  });

  it("filters out a linked request that sits outside the caller's regions", async () => {
    // A vendor can work across regions. Reading their page must not become a
    // way to see requests the caller could not otherwise open.
    westLead();
    storageMock.getRequestsForContact.mockResolvedValue([
      { id: "req-west", region: "West Central" },
      { id: "req-east", region: "East Central" },
    ]);
    const { body } = await get("/api/contacts/c-west/requests");
    expect(body.map((r: { id: string }) => r.id)).toEqual(["req-west"]);
  });

  // ── Writing a note ───────────────────────────────────────────────────────

  const addNote = (contactId: string, body: unknown) =>
    request("POST", `/api/contacts/${contactId}/notes`, { body });

  it("refuses a note from staff holding only the view permission", async () => {
    westLead({ canViewContacts: true });
    const { status } = await addNote("c-west", { body: "Turned up late twice" });
    expect(status).toBe(403);
    expect(storageMock.createContactNote).not.toHaveBeenCalled();
  });

  it("refuses a note on a contractor in another region", async () => {
    westLead();
    const { status } = await addNote("c-east", { body: "Good work" });
    expect(status).toBe(403);
    expect(storageMock.createContactNote).not.toHaveBeenCalled();
  });

  it("refuses an empty note", async () => {
    // An empty note tells the next RA nothing, which is the only thing this
    // record is for.
    westLead();
    expect((await addNote("c-west", { body: "   " })).status).toBe(400);
    expect(storageMock.createContactNote).not.toHaveBeenCalled();
  });

  // The positive control.
  it("takes the author and the region from the server, never the body", async () => {
    westLead();
    const { status } = await addNote("c-west", {
      body: "Only ones who will touch this boiler",
      authorUserId: "u-somebody-else",
      authorEmail: "someone@else.com",
      region: "East Central",
    });
    expect(status).toBe(200);
    const [note] = storageMock.createContactNote.mock.calls[0];
    expect(note.authorUserId).toBe(STAFF.id);
    expect(note.authorEmail).toBe(STAFF.email);
    expect(note.region).toBe("West Central");
    expect(note.contactId).toBe("c-west");
  });

  it("has no rating field to set", async () => {
    // Deliberate: a star score on a vendor SPO may have to keep using invites
    // arguments about the number and tells an incoming RA less than a
    // paragraph does. A rating sent anyway is dropped, never stored.
    westLead();
    await addNote("c-west", { body: "Fine", rating: 5 });
    const [note] = storageMock.createContactNote.mock.calls[0];
    expect(note).not.toHaveProperty("rating");
  });

  it("answers 404 for a contractor that does not exist, without writing", async () => {
    westLead();
    expect((await addNote("c-nowhere", { body: "x" })).status).toBe(404);
    expect(storageMock.createContactNote).not.toHaveBeenCalled();
  });

  // ── Deleting one ─────────────────────────────────────────────────────────

  it("refuses to delete a note in another region, without deleting", async () => {
    westLead();
    storageMock.getContactNote.mockResolvedValue({ id: "note-9", contactId: "c-east", region: "East Central" });
    const { status } = await request("DELETE", "/api/contact-notes/note-9", {});
    expect(status).toBe(403);
    expect(storageMock.deleteContactNote).not.toHaveBeenCalled();
  });

  it("deletes one in the caller's own region", async () => {
    westLead();
    storageMock.getContactNote.mockResolvedValue({ id: "note-1", contactId: "c-west", region: "West Central" });
    const { status } = await request("DELETE", "/api/contact-notes/note-1", {});
    expect(status).toBe(200);
    expect(storageMock.deleteContactNote).toHaveBeenCalledWith("note-1");
  });
});

describe("suggesting where in the house a problem is", () => {
  const WEST = { id: "prop-west", name: "Cleveland House", region: "West Central", address: "1 Main St" };
  const EAST = { id: "prop-east", name: "Como House", region: "East Central", address: "9 Elm" };

  beforeEach(() => {
    storageMock.getProperty.mockImplementation(async (id: string) =>
      id === "prop-west" ? WEST : id === "prop-east" ? EAST : undefined,
    );
    storageMock.getWalkthroughRoomsByBuilding.mockImplementation(async (address: string) =>
      address === "1 Main St"
        ? [
            { id: "r1", name: "Kitchen", displayOrder: 0 },
            { id: "r2", name: "Living room", displayOrder: 1 },
            // The same room from an earlier walkthrough of the same house.
            { id: "r3", name: "Kitchen", displayOrder: 0 },
          ]
        : [{ id: "r9", name: "Basement", displayOrder: 0 }],
    );
  });

  it("refuses an anonymous caller", async () => {
    expect((await get("/api/maintenance-locations?propertyId=prop-west")).status).toBe(401);
  });

  it("gives staff the room names of a house they cover, each once", async () => {
    // Rooms repeat across a house's walkthroughs; the vocabulary does not.
    actAs(STAFF, { ...ALL_MAINTENANCE, allowedRegions: ["West Central"] });
    const { status, body } = await get("/api/maintenance-locations?propertyId=prop-west");
    expect(status).toBe(200);
    expect(body).toEqual(["Kitchen", "Living room"]);
  });

  it("refuses staff a house outside their regions, without reading its rooms", async () => {
    actAs(STAFF, { ...ALL_MAINTENANCE, allowedRegions: ["West Central"] });
    const { status } = await get("/api/maintenance-locations?propertyId=prop-east");
    expect(status).toBe(403);
    expect(storageMock.getWalkthroughRoomsByBuilding).not.toHaveBeenCalled();
  });

  it("ignores the propertyId a resident asks for and uses their own house", async () => {
    // Otherwise this route becomes a way to enumerate another house's rooms,
    // which is a second read path into walkthrough data -- the exact shape of
    // both historic authorization gaps in this codebase.
    actAs({ ...ALICE, propertyId: "prop-west" } as typeof ALICE, ALL_MAINTENANCE);
    const { status, body } = await get("/api/maintenance-locations?propertyId=prop-east");
    expect(status).toBe(200);
    expect(body).toEqual(["Kitchen", "Living room"]);
    expect(storageMock.getWalkthroughRoomsByBuilding).toHaveBeenCalledWith("1 Main St");
  });

  it("gives a resident with no linked house an empty list, not an error", async () => {
    // A blank suggestion list still leaves the free-text field usable, which
    // is the fallback the whole feature is built around.
    actAs(ALICE, ALL_MAINTENANCE);
    const { status, body } = await get("/api/maintenance-locations");
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it("answers 404 for a house that does not exist", async () => {
    actAs(STAFF, { ...ALL_MAINTENANCE, allowedRegions: ["West Central"] });
    expect((await get("/api/maintenance-locations?propertyId=prop-nowhere")).status).toBe(404);
  });
});

describe("snoozing an asset an RA is confident about", () => {
  const WEST_ASSET = { id: "asset-west", name: "Rheem water heater", region: "West Central", buildingAddress: "1 Main St" };
  const EAST_ASSET = { id: "asset-east", name: "Carrier furnace", region: "East Central", buildingAddress: "9 Elm" };

  const MANAGE = { canViewAssets: true, canManageAssets: true };
  const westLead = (permissions: Record<string, unknown> = MANAGE) =>
    actAs(STAFF, { ...permissions, allowedRegions: ["West Central"] });

  const NEXT_YEAR = "2027-08-01T00:00:00.000Z";

  beforeEach(() => {
    storageMock.getAsset.mockImplementation(async (id: string) =>
      id === "asset-west" ? WEST_ASSET : id === "asset-east" ? EAST_ASSET : undefined,
    );
    storageMock.updateAsset.mockImplementation(async (id, patch) => ({ ...WEST_ASSET, id, ...patch }));
  });

  const snooze = (id: string, body: unknown) => request("POST", `/api/assets/${id}/snooze`, { body });

  // ── The three layers ─────────────────────────────────────────────────────

  it("refuses an anonymous caller", async () => {
    expect((await snooze("asset-west", { until: NEXT_YEAR, reason: "Serviced last month" })).status).toBe(401);
  });

  it("refuses a resident, without writing", async () => {
    actAs(ALICE, ALL_MAINTENANCE);
    expect((await snooze("asset-west", { until: NEXT_YEAR, reason: "x" })).status).toBe(403);
    expect(storageMock.updateAsset).not.toHaveBeenCalled();
  });

  it("refuses staff holding only the view permission, without writing", async () => {
    westLead({ canViewAssets: true });
    expect((await snooze("asset-west", { until: NEXT_YEAR, reason: "x" })).status).toBe(403);
    expect(storageMock.updateAsset).not.toHaveBeenCalled();
  });

  it("refuses an asset in another region, without writing", async () => {
    westLead();
    expect((await snooze("asset-east", { until: NEXT_YEAR, reason: "x" })).status).toBe(403);
    expect(storageMock.updateAsset).not.toHaveBeenCalled();
  });

  it("answers 404 for an asset that does not exist, without writing", async () => {
    westLead();
    expect((await snooze("asset-nowhere", { until: NEXT_YEAR, reason: "x" })).status).toBe(404);
    expect(storageMock.updateAsset).not.toHaveBeenCalled();
  });

  // ── The reason is the point ──────────────────────────────────────────────

  it("refuses a snooze with no reason", async () => {
    // The reason is what makes next year's budget conversation possible. A
    // snooze without one is just a boiler quietly disappearing.
    westLead();
    const { status } = await snooze("asset-west", { until: NEXT_YEAR });
    expect(status).toBe(400);
    expect(storageMock.updateAsset).not.toHaveBeenCalled();
  });

  it("refuses a blank reason too", async () => {
    westLead();
    expect((await snooze("asset-west", { until: NEXT_YEAR, reason: "   " })).status).toBe(400);
    expect(storageMock.updateAsset).not.toHaveBeenCalled();
  });

  it("refuses a snooze with no end date, so it can never be permanent", async () => {
    // Snooze returns. Editing the replacement date is the permanent
    // correction; conflating the two would let a date be falsified silently.
    westLead();
    expect((await snooze("asset-west", { reason: "Serviced last month" })).status).toBe(400);
    expect(storageMock.updateAsset).not.toHaveBeenCalled();
  });

  // The positive control.
  it("records who snoozed it and when, from the session rather than the body", async () => {
    westLead();
    const { status } = await snooze("asset-west", {
      until: NEXT_YEAR,
      reason: "Serviced last month, has years left",
      snoozedByUserId: "u-somebody-else",
      snoozedAt: "1999-01-01T00:00:00.000Z",
    });
    expect(status).toBe(200);
    const [, patch] = storageMock.updateAsset.mock.calls[0];
    expect(patch.snoozedByUserId).toBe(STAFF.id);
    expect(patch.snoozeReason).toBe("Serviced last month, has years left");
    expect(patch.snoozedAt.getTime()).toBeGreaterThan(new Date("2020-01-01").getTime());
  });

  it("never touches the replacement date, so a snooze cannot falsify it", async () => {
    westLead();
    await snooze("asset-west", { until: NEXT_YEAR, reason: "Serviced last month" });
    const [, patch] = storageMock.updateAsset.mock.calls[0];
    expect(patch).not.toHaveProperty("replacementDueDate");
    expect(patch).not.toHaveProperty("acquisitionDate");
  });

  // ── The snooze routes are the ONLY writers ───────────────────────────────

  it("refuses to set a snooze through the ordinary asset PATCH", async () => {
    // Otherwise every guarantee the snooze route makes -- a required reason,
    // a recorded actor, an end date -- is optional in practice, and an asset
    // vanishes from the dashboard with no who, when or why.
    westLead();
    const { status } = await request("PATCH", "/api/assets/asset-west", {
      body: { snoozedUntil: NEXT_YEAR, snoozeReason: "because" },
    });
    expect(status).toBe(200);
    const [, patch] = storageMock.updateAsset.mock.calls[0];
    expect(patch).not.toHaveProperty("snoozedUntil");
    expect(patch).not.toHaveProperty("snoozeReason");
  });

  it("refuses an asset PATCH that sets a category not on the list (#161)", async () => {
    westLead();
    const { status } = await request("PATCH", "/api/assets/asset-west", { body: { category: "Vehicle" } });
    expect(status).toBe(400);
    expect(storageMock.updateAsset).not.toHaveBeenCalled();
  });

  it("takes an asset PATCH that sets a category on the list (#161)", async () => {
    // The positive control for the refusal above.
    westLead();
    const { status } = await request("PATCH", "/api/assets/asset-west", { body: { category: "Tools" } });
    expect(status).toBe(200);
    expect(storageMock.updateAsset.mock.calls[0][1].category).toBe("Tools");
  });

  it("still lets the ordinary PATCH edit the replacement date", async () => {
    // The positive control, and the distinction that matters: editing the date
    // is the permanent correction and belongs on the asset form. Snoozing is
    // the temporary one and belongs on its own route.
    westLead();
    const { status } = await request("PATCH", "/api/assets/asset-west", {
      body: { replacementDueDate: NEXT_YEAR },
    });
    expect(status).toBe(200);
    const [, patch] = storageMock.updateAsset.mock.calls[0];
    expect(patch.replacementDueDate).toBeInstanceOf(Date);
  });

  it("refuses a snooze so far out it is permanent in all but name", async () => {
    // "It returns" is the whole distinction from editing the date. An
    // unbounded end date is the permanent correction wearing a temporary hat.
    westLead();
    const { status } = await snooze("asset-west", {
      until: "3000-01-01T00:00:00.000Z",
      reason: "Definitely fine",
    });
    expect(status).toBe(400);
    expect(storageMock.updateAsset).not.toHaveBeenCalled();
  });

  it("refuses a snooze that has already ended", async () => {
    westLead();
    const { status } = await snooze("asset-west", {
      until: "2020-01-01T00:00:00.000Z",
      reason: "Serviced",
    });
    expect(status).toBe(400);
    expect(storageMock.updateAsset).not.toHaveBeenCalled();
  });

  it("takes tomorrow as an end date after 7pm Central, and refuses today (#168)", async () => {
    // 01:17Z on Sep 28 is 8:17pm on Sep 27 in Chicago. Tomorrow arrives as
    // UTC midnight of Sep 28, already past as an instant; it has not begun
    // everywhere, so it is still in the future. Today (Sep 27) has.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-28T01:17:00.000Z"));
    try {
      westLead();
      const today = await snooze("asset-west", { until: "2026-09-27", reason: "Serviced" });
      expect(today.status).toBe(400);
      expect(storageMock.updateAsset).not.toHaveBeenCalled();

      const tomorrow = await snooze("asset-west", { until: "2026-09-28", reason: "Serviced" });
      expect(tomorrow.status).toBe(200);
      expect(storageMock.updateAsset).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears a snooze, keeping the reason as the record of why it was parked", async () => {
    westLead();
    const { status } = await request("DELETE", "/api/assets/asset-west/snooze", {});
    expect(status).toBe(200);
    const [, patch] = storageMock.updateAsset.mock.calls[0];
    expect(patch.snoozedUntil).toBeNull();
    expect(patch).not.toHaveProperty("snoozeReason");
  });
});

describe("who holds an asset, by name (#164)", () => {
  // "Who has what" exists for staff departures, and /api/users is admin-only,
  // so the asset list carries the holder's name itself -- and nothing more.
  beforeEach(() => {
    storageMock.getAllAssets.mockResolvedValue([
      { id: "a-lent", name: "iPad", region: "West Central", assignedUserId: "u-lent" },
      { id: "a-free", name: "Guitar", region: "West Central", assignedUserId: null },
      { id: "a-east", name: "Laptop", region: "East Central", assignedUserId: "u-east" },
    ]);
    storageMock.getAllUsers.mockResolvedValue([
      { id: "u-lent", firstName: "Sam", lastName: "O'Connor", email: "sam@spo.org", role: "regional_administrator" },
      { id: "u-east", firstName: "Eve", lastName: "East", email: "eve@spo.org", role: "regional_administrator" },
    ]);
  });

  it("names the staff account an asset is lent to, for a regional administrator", async () => {
    actAs(STAFF, { canViewAssets: true, allowedRegions: ["West Central"] });
    const { status, body } = await get("/api/assets");
    expect(status).toBe(200);
    const lent = body.find((asset: { id: string }) => asset.id === "a-lent");
    expect(lent.assignedUserName).toBe("Sam O'Connor");
    expect(body.find((asset: { id: string }) => asset.id === "a-free").assignedUserName).toBeNull();
  });

  it("carries the name only, never the rest of the account", async () => {
    actAs(STAFF, { canViewAssets: true, allowedRegions: ["West Central"] });
    const { body } = await get("/api/assets");
    const text = JSON.stringify(body);
    expect(text).not.toContain("sam@spo.org");
    expect(text).not.toContain("regional_administrator");
    // An asset outside the caller's regions stays out, holder and all.
    expect(text).not.toContain("Eve");
  });
});

describe("asset creation input validation", () => {
  const baseAsset = {
    name: "Fridge",
    category: "Appliances - Large",
    type: "movable",
    ageInYears: 2,
    region: "West Central",
    buildingAddress: "1 Main St",
    location: "Kitchen",
  };

  beforeEach(() => {
    storageMock.createAsset.mockImplementation(async (data: Record<string, unknown>) => ({ id: "asset-1", ...data }));
  });

  it("accepts purchasePrice as the number the form sends", async () => {
    actAs(ADMIN);
    const { status } = await request("POST", "/api/assets", { body: { ...baseAsset, purchasePrice: 450 } });
    expect(status).toBe(200);
    // Stored as a string, because the numeric column round-trips as one.
    expect(storageMock.createAsset).toHaveBeenCalledWith(
      expect.objectContaining({ purchasePrice: "450" }),
    );
  });

  it("accepts lastServiced as the YYYY-MM-DD string the date input sends", async () => {
    actAs(ADMIN);
    const { status } = await request("POST", "/api/assets", {
      body: { ...baseAsset, type: "fixed", lastServiced: "2026-01-15" },
    });
    expect(status).toBe(200);
    const stored = storageMock.createAsset.mock.calls.at(-1)![0];
    expect(stored.lastServiced).toBeInstanceOf(Date);
    expect((stored.lastServiced as Date).toISOString()).toBe("2026-01-15T00:00:00.000Z");
  });

  it("rejects a negative purchasePrice", async () => {
    actAs(ADMIN);
    const { status } = await request("POST", "/api/assets", { body: { ...baseAsset, purchasePrice: -5 } });
    expect(status).toBe(400);
    expect(storageMock.createAsset).not.toHaveBeenCalled();
  });

  it("rejects a negative ageInYears", async () => {
    actAs(ADMIN);
    const { status } = await request("POST", "/api/assets", { body: { ...baseAsset, ageInYears: -1 } });
    expect(status).toBe(400);
    expect(storageMock.createAsset).not.toHaveBeenCalled();
  });

  it("rejects a non-numeric purchasePrice", async () => {
    actAs(ADMIN);
    const { status } = await request("POST", "/api/assets", { body: { ...baseAsset, purchasePrice: "abc" } });
    expect(status).toBe(400);
    expect(storageMock.createAsset).not.toHaveBeenCalled();
  });

  it("rejects a category that is not on the list (#161)", async () => {
    // A category outside ASSET_CATEGORIES has no lifespan and no fixed/movable
    // answer, so every such asset silently reads as unrated.
    actAs(ADMIN);
    const { status } = await request("POST", "/api/assets", { body: { ...baseAsset, category: "Appliance" } });
    expect(status).toBe(400);
    expect(storageMock.createAsset).not.toHaveBeenCalled();
  });
});

describe("recording a change to a property's documents", () => {
  const WEST = { id: "prop-1", name: "Cleveland House", address: "1 Main St", region: "West Central", ownership: "rented", leaseDocumentUrl: null, photoUrl: null };

  beforeEach(() => {
    storageMock.getProperty.mockResolvedValue(WEST);
    storageMock.updateProperty.mockImplementation(async (_id, patch) => ({ ...WEST, ...patch }));
  });

  it("records the lease link changing, naming the house", async () => {
    actAs(ADMIN);
    await request("PATCH", "/api/properties/prop-1", {
      body: { leaseDocumentUrl: "https://drive.google.com/file/d/abc/view" },
    });
    expect(storageMock.createAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "property.documents_changed",
        entityType: "property",
        entityId: "prop-1",
        summary: expect.stringContaining("Cleveland House"),
      }),
    );
  });

  it("stays quiet for an edit that touches no document", async () => {
    // Otherwise an ordinary bedroom-count edit fills the trail with noise and
    // buries the changes somebody actually has to account for.
    actAs(ADMIN);
    await request("PATCH", "/api/properties/prop-1", { body: { bedrooms: 5 } });
    expect(storageMock.createAuditEvent).not.toHaveBeenCalled();
  });
});

describe("links a property stores and later renders as an href", () => {
  const base = {
    name: "New House",
    streetAddress: "9 Oak Ave",
    city: "St Paul",
    state: "MN",
    zipCode: "55104",
    region: "West Central",
    chapter: "St Paul",
    ownership: "rented",
  };

  beforeEach(() => {
    storageMock.createProperty.mockImplementation(async (data: Record<string, unknown>) => ({ id: "prop-new", ...data }));
    storageMock.createPropertySetupItems.mockResolvedValue([]);
  });

  // The property page renders both of these straight into an href. Validating
  // in the form only would leave the API accepting whatever it is sent.
  it.each(["leaseDocumentUrl", "maintenancePortalUrl"])(
    "refuses a javascript: URL in %s, without storing anything",
    async (field) => {
      actAs(ADMIN);
      const { status } = await request("POST", "/api/properties", {
        body: { ...base, [field]: "javascript:alert(document.cookie)" },
      });
      expect(status).toBe(400);
      expect(storageMock.createProperty).not.toHaveBeenCalled();
    },
  );

  it.each(["data:text/html,<script>alert(1)</script>", "vbscript:msgbox(1)", "not a url at all"])(
    "refuses %s",
    async (value) => {
      actAs(ADMIN);
      const { status } = await request("POST", "/api/properties", {
        body: { ...base, maintenancePortalUrl: value },
      });
      expect(status).toBe(400);
      expect(storageMock.createProperty).not.toHaveBeenCalled();
    },
  );

  it("refuses one on update too, without writing", async () => {
    actAs(ADMIN);
    storageMock.getProperty.mockResolvedValue({ id: "prop-1", region: "West Central", ownership: "rented" });
    const { status } = await request("PATCH", "/api/properties/prop-1", {
      body: { leaseDocumentUrl: "javascript:alert(1)" },
    });
    expect(status).toBe(400);
    expect(storageMock.updateProperty).not.toHaveBeenCalled();
  });

  // The positive control: without it every refusal above could pass on a
  // schema that rejects everything.
  it("accepts an ordinary https link and stores it", async () => {
    actAs(ADMIN);
    const { status } = await request("POST", "/api/properties", {
      body: { ...base, leaseDocumentUrl: "https://drive.google.com/file/d/abc/view" },
    });
    expect(status).toBe(200);
    expect(storageMock.createProperty).toHaveBeenCalledWith(
      expect.objectContaining({ leaseDocumentUrl: "https://drive.google.com/file/d/abc/view" }),
    );
  });

  it("reads an untouched input's empty string as cleared, not as invalid", async () => {
    // The form sends "" for a field nobody filled in. Rejecting the whole
    // property for that would be wrong.
    actAs(ADMIN);
    const { status } = await request("POST", "/api/properties", {
      body: { ...base, leaseDocumentUrl: "", maintenancePortalUrl: "" },
    });
    expect(status).toBe(200);
    expect(storageMock.createProperty).toHaveBeenCalledWith(
      expect.objectContaining({ leaseDocumentUrl: null, maintenancePortalUrl: null }),
    );
  });
});

describe("property creation input validation", () => {
  const baseProperty = {
    name: "Edel House",
    streetAddress: "1 Main St",
    city: "Saint Paul",
    state: "MN",
    zipCode: "55101",
    region: "West Central",
  };

  beforeEach(() => {
    storageMock.createProperty.mockImplementation(async (data: Record<string, unknown>) => ({ id: "prop-1", ...data }));
  });

  it("rejects a negative bedroom count", async () => {
    actAs(ADMIN);
    const { status } = await request("POST", "/api/properties", { body: { ...baseProperty, bedrooms: -2 } });
    expect(status).toBe(400);
    expect(storageMock.createProperty).not.toHaveBeenCalled();
  });
});

describe("photo attribution is taken from the session, not the body", () => {
  it("stores an asset photo under the signed-in user, ignoring a spoofed uploadedBy", async () => {
    actAs(ADMIN);
    storageMock.getAsset.mockResolvedValue({ id: "asset-1", region: "West Central" });
    storageMock.createAssetPhoto.mockImplementation(async (data: Record<string, unknown>) => ({ id: "photo-1", ...data }));
    // The file itself must be the caller's own upload; attribution is what this tests.
    storageMock.getUploadByStorageKey.mockResolvedValue({ storageKey: "x.png", uploadedBy: ADMIN.id });

    const { status } = await request("POST", "/api/asset-photos", {
      body: { assetId: "asset-1", imageUrl: "/uploads/x.png", uploadedBy: "victim@example.com" },
    });

    expect(status).toBe(200);
    expect(storageMock.createAssetPhoto).toHaveBeenCalledWith(
      expect.objectContaining({ uploadedBy: ADMIN.email }),
    );
    expect(storageMock.createAssetPhoto).not.toHaveBeenCalledWith(
      expect.objectContaining({ uploadedBy: "victim@example.com" }),
    );
  });

  it("stores a walkthrough photo under the signed-in user, ignoring a spoofed uploadedBy", async () => {
    actAs(ADMIN);
    // The photo's room and walkthrough, which now decide its region and house.
    storageMock.getWalkthroughRoom.mockResolvedValue({ id: "room-1", walkthroughId: "wt-1" });
    storageMock.getWalkthrough.mockResolvedValue({ id: "wt-1", region: "West Central", buildingAddress: "1 Main St", propertyId: "prop-1" });
    storageMock.createWalkthroughPhoto.mockImplementation(async (data: Record<string, unknown>) => ({ id: "photo-1", ...data }));
    // The file itself must be the caller's own upload; attribution is what this tests.
    storageMock.getUploadByStorageKey.mockResolvedValue({ storageKey: "x.png", uploadedBy: ADMIN.id });

    const { status } = await request("POST", "/api/walkthrough-photos", {
      body: {
        roomId: "room-1",
        imageUrl: "/uploads/x.png",
        condition: "same_as_last_walkthrough",
        region: "West Central",
        buildingAddress: "1 Main St",
        location: "Kitchen",
        uploadedBy: "victim@example.com",
      },
    });

    expect(status).toBe(200);
    expect(storageMock.createWalkthroughPhoto).toHaveBeenCalledWith(
      expect.objectContaining({ uploadedBy: ADMIN.email }),
    );
  });
});

// ---------------------------------------------------------------------------
// 10. Maintenance schedules — region comes from the property, not the body
// ---------------------------------------------------------------------------

describe("maintenance schedules", () => {
  const WEST_PROPERTY = { id: "prop-west", name: "Cleveland House", region: "West Central", address: "1 Main St" };
  const EAST_PROPERTY = { id: "prop-east", name: "Como House", region: "East Central", address: "2 River Rd" };

  it("refuses a resident the schedules list", async () => {
    actAs(ALICE, ALL_MAINTENANCE);
    const { status } = await get("/api/maintenance-schedules");
    expect(status).toBe(403);
  });

  it("takes region and building from the property, ignoring the body", async () => {
    actAs(STAFF, { ...ALL_MAINTENANCE, allowedRegions: ["West Central"] });
    storageMock.getProperty.mockResolvedValue(WEST_PROPERTY);
    storageMock.createMaintenanceSchedule.mockImplementation(async (data: Record<string, unknown>) => ({ id: "sch-1", ...data }));

    const { status } = await request("POST", "/api/maintenance-schedules", {
      body: {
        propertyId: WEST_PROPERTY.id,
        title: "Fire extinguisher check",
        category: "safety",
        intervalMonths: 12,
        nextDueDate: "2026-06-01",
        region: "East Central", // spoofed — must be ignored
        buildingAddress: "999 Evil St", // spoofed — must be ignored
      },
    });

    expect(status).toBe(200);
    expect(storageMock.createMaintenanceSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ region: "West Central", buildingAddress: "1 Main St" }),
    );
  });

  it("refuses creating a schedule on a property in another region", async () => {
    actAs(STAFF, { ...ALL_MAINTENANCE, allowedRegions: ["West Central"] });
    storageMock.getProperty.mockResolvedValue(EAST_PROPERTY);

    const { status } = await request("POST", "/api/maintenance-schedules", {
      body: { propertyId: EAST_PROPERTY.id, title: "x", category: "safety", intervalMonths: 12, nextDueDate: "2026-06-01" },
    });

    expect(status).toBe(403);
    expect(storageMock.createMaintenanceSchedule).not.toHaveBeenCalled();
  });

  it("advances the due date when a schedule is marked done", async () => {
    actAs(STAFF, { ...ALL_MAINTENANCE, allowedRegions: ["West Central"] });
    storageMock.getMaintenanceSchedule.mockResolvedValue({
      id: "sch-1", region: "West Central", intervalMonths: 12,
    });
    storageMock.completeMaintenanceSchedule.mockImplementation(async (id: string) => ({ id }));

    const { status } = await request("POST", "/api/maintenance-schedules/sch-1/complete");

    expect(status).toBe(200);
    // The route computes the new dates and hands them to storage.
    expect(storageMock.completeMaintenanceSchedule).toHaveBeenCalledWith(
      "sch-1", expect.any(Date), expect.any(Date),
    );
  });
});

describe("residents", () => {
  const WEST_PROPERTY = { id: "prop-west", name: "Cleveland House", region: "West Central", address: "1 Main St" };
  const EAST_PROPERTY = { id: "prop-east", name: "Como House", region: "East Central", address: "2 River Rd" };
  const ALL_PROPERTIES = { canViewProperties: true, canManageProperties: true };

  it("refuses a resident the roster list", async () => {
    // A resident holds maintenance permissions but not the property permission.
    actAs(ALICE, ALL_MAINTENANCE);
    const { status } = await get("/api/residents");
    expect(status).toBe(403);
  });

  it("takes region and building from the property, ignoring the body", async () => {
    actAs(STAFF, { ...ALL_PROPERTIES, allowedRegions: ["West Central"] });
    storageMock.getProperty.mockResolvedValue(WEST_PROPERTY);
    storageMock.createResident.mockImplementation(async (data: Record<string, unknown>) => ({ id: "res-1", ...data }));

    const { status } = await request("POST", "/api/residents", {
      body: {
        propertyId: WEST_PROPERTY.id,
        firstName: "Maria",
        lastName: "Gonzalez",
        email: "maria@spo.org",
        region: "East Central", // spoofed — must be ignored
        buildingAddress: "999 Evil St", // spoofed — must be ignored
      },
    });

    expect(status).toBe(200);
    expect(storageMock.createResident).toHaveBeenCalledWith(
      expect.objectContaining({ region: "West Central", buildingAddress: "1 Main St" }),
    );
  });

  it("refuses adding a resident to a property in another region", async () => {
    actAs(STAFF, { ...ALL_PROPERTIES, allowedRegions: ["West Central"] });
    storageMock.getProperty.mockResolvedValue(EAST_PROPERTY);

    const { status } = await request("POST", "/api/residents", {
      body: { propertyId: EAST_PROPERTY.id, firstName: "A", lastName: "B", email: "ab@spo.org" },
    });

    expect(status).toBe(403);
    expect(storageMock.createResident).not.toHaveBeenCalled();
  });

  it("rejects an invalid email address", async () => {
    actAs(STAFF, { ...ALL_PROPERTIES, allowedRegions: ["West Central"] });
    storageMock.getProperty.mockResolvedValue(WEST_PROPERTY);

    const { status } = await request("POST", "/api/residents", {
      body: { propertyId: WEST_PROPERTY.id, firstName: "A", lastName: "B", email: "not-an-email" },
    });

    expect(status).toBe(400);
    expect(storageMock.createResident).not.toHaveBeenCalled();
  });

  it("does not let a patch move a resident to another house or region", async () => {
    actAs(STAFF, { ...ALL_PROPERTIES, allowedRegions: ["West Central"] });
    storageMock.getResident.mockResolvedValue({ id: "res-1", region: "West Central", propertyId: WEST_PROPERTY.id });
    storageMock.updateResident.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({ id, ...patch }));

    const { status } = await request("PATCH", "/api/residents/res-1", {
      body: { isActive: false, propertyId: EAST_PROPERTY.id, region: "East Central", buildingAddress: "999 Evil St" },
    });

    expect(status).toBe(200);
    const patch = storageMock.updateResident.mock.calls[0][1];
    expect(patch).not.toHaveProperty("propertyId");
    expect(patch).not.toHaveProperty("region");
    expect(patch).not.toHaveProperty("buildingAddress");
    expect(patch).toMatchObject({ isActive: false });
  });
});

describe("moving a resident out", () => {
  const ALL_PROPERTIES = { canViewProperties: true, canManageProperties: true };
  const WEST_RESIDENT = {
    id: "res-1",
    firstName: "Maria",
    lastName: "Gonzalez",
    propertyId: "prop-1",
    email: "maria@spo.org",
    region: "West Central",
    buildingAddress: "1 Main St",
    isActive: true,
  };
  const MARIA_LOGIN = { id: "u-maria", email: "maria@spo.org", role: "resident", isActive: true, propertyId: "prop-1" };

  it("marks the resident moved out on the requested date", async () => {
    actAs(STAFF, { ...ALL_PROPERTIES, allowedRegions: ["West Central"] });
    storageMock.getResident.mockResolvedValue(WEST_RESIDENT);
    storageMock.updateResident.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({ ...WEST_RESIDENT, ...patch }));

    const { status } = await request("POST", "/api/residents/res-1/move-out", {
      body: { moveOutDate: "2026-05-15", deactivateAccount: false },
    });

    expect(status).toBe(200);
    expect(storageMock.updateResident).toHaveBeenCalledWith(
      "res-1",
      expect.objectContaining({ isActive: false, moveOutDate: new Date("2026-05-15") }),
      // A person's edit, so a later sheet sync that changes it is flagged.
      { by: STAFF.email, at: expect.any(Date) },
    );
    expect(storageMock.deactivateAndUnlinkUser).not.toHaveBeenCalled();
  });

  it("deactivates a matching resident login when asked to", async () => {
    actAs(STAFF, { ...ALL_PROPERTIES, allowedRegions: ["West Central"] });
    storageMock.getResident.mockResolvedValue(WEST_RESIDENT);
    storageMock.updateResident.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({ ...WEST_RESIDENT, ...patch }));
    storageMock.getActiveResidentAccountByEmail.mockResolvedValue(MARIA_LOGIN);
    storageMock.deactivateAndUnlinkUser.mockResolvedValue({ ...MARIA_LOGIN, isActive: false, propertyId: null });

    const { status, body } = await request("POST", "/api/residents/res-1/move-out", {
      body: { moveOutDate: "2026-05-15", deactivateAccount: true },
    });

    expect(status).toBe(200);
    expect(storageMock.getActiveResidentAccountByEmail).toHaveBeenCalledWith("maria@spo.org");
    expect(storageMock.deactivateAndUnlinkUser).toHaveBeenCalledWith("u-maria");
    expect((body as { accountDeactivated: boolean }).accountDeactivated).toBe(true);
  });

  it("unlinks the login it switches off from the house, and records the unlink", async () => {
    // The house link is what reaches the house's requests, walkthroughs and
    // codes. Left in place, an admin reactivating the login later would hand
    // all of that back to somebody who no longer lives there.
    actAs(STAFF, { ...ALL_PROPERTIES, allowedRegions: ["West Central"] });
    storageMock.getResident.mockResolvedValue(WEST_RESIDENT);
    storageMock.updateResident.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({ ...WEST_RESIDENT, ...patch }));
    storageMock.getActiveResidentAccountByEmail.mockResolvedValue(MARIA_LOGIN);
    storageMock.deactivateAndUnlinkUser.mockResolvedValue({ ...MARIA_LOGIN, isActive: false, propertyId: null });

    const { status } = await request("POST", "/api/residents/res-1/move-out", {
      body: { moveOutDate: "2026-05-15", deactivateAccount: true },
    });

    expect(status).toBe(200);
    // One write for both columns: two separate writes could leave the login
    // switched off but still linked, and a retry cannot find an inactive login.
    expect(storageMock.deactivateAndUnlinkUser).toHaveBeenCalledWith("u-maria");
    expect(storageMock.updateUserActiveStatus).not.toHaveBeenCalled();
    expect(storageMock.updateUserProperty).not.toHaveBeenCalled();
    const events = storageMock.createAuditEvent.mock.calls.map((call) => call[0]);
    expect(events).toContainEqual(
      expect.objectContaining({
        action: "user.property_changed",
        entityId: "u-maria",
        details: expect.objectContaining({ from: "prop-1", to: null }),
      }),
    );
    expect(events).toContainEqual(expect.objectContaining({ action: "user.status_changed", entityId: "u-maria" }));
  });

  // The roster row speaks only for a login with its exact email that is linked
  // to its own house. The lookup is by email, so both conditions are checked
  // on whatever it returns.
  async function moveOutWithLogin(resident: Record<string, unknown>, login: Record<string, unknown>) {
    actAs(STAFF, { ...ALL_PROPERTIES, allowedRegions: ["West Central"] });
    storageMock.getResident.mockResolvedValue(resident);
    storageMock.updateResident.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({ ...resident, ...patch }));
    storageMock.getActiveResidentAccountByEmail.mockResolvedValue(login);
    storageMock.deactivateAndUnlinkUser.mockResolvedValue({ ...login, isActive: false, propertyId: null });
    return request("POST", "/api/residents/res-1/move-out", {
      body: { moveOutDate: "2026-05-15", deactivateAccount: true },
    });
  }

  it("leaves a login linked to another house untouched", async () => {
    const { status, body } = await moveOutWithLogin(WEST_RESIDENT, { ...MARIA_LOGIN, propertyId: "prop-other" });

    expect(status).toBe(200);
    expect(storageMock.deactivateAndUnlinkUser).not.toHaveBeenCalled();
    expect((body as { accountDeactivated: boolean }).accountDeactivated).toBe(false);
  });

  it("leaves a login linked to no house untouched", async () => {
    const { status } = await moveOutWithLogin(WEST_RESIDENT, { ...MARIA_LOGIN, propertyId: null });

    expect(status).toBe(200);
    expect(storageMock.deactivateAndUnlinkUser).not.toHaveBeenCalled();
  });

  it("leaves a login whose email is not the roster email untouched, even in the same house", async () => {
    const { status, body } = await moveOutWithLogin(
      { ...WEST_RESIDENT, email: "mary_k@spo.org" },
      { ...MARIA_LOGIN, email: "mary.k@spo.org" },
    );

    expect(status).toBe(200);
    expect(storageMock.deactivateAndUnlinkUser).not.toHaveBeenCalled();
    expect((body as { accountDeactivated: boolean }).accountDeactivated).toBe(false);
  });

  it("deactivates the house's login whose email differs from the roster only in case", async () => {
    const { status, body } = await moveOutWithLogin(WEST_RESIDENT, { ...MARIA_LOGIN, email: "Maria@SPO.org" });

    expect(status).toBe(200);
    expect(storageMock.deactivateAndUnlinkUser).toHaveBeenCalledWith("u-maria");
    expect((body as { accountDeactivated: boolean }).accountDeactivated).toBe(true);
  });

  it("never touches a login when none matches", async () => {
    actAs(STAFF, { ...ALL_PROPERTIES, allowedRegions: ["West Central"] });
    storageMock.getResident.mockResolvedValue(WEST_RESIDENT);
    storageMock.updateResident.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({ ...WEST_RESIDENT, ...patch }));
    storageMock.getActiveResidentAccountByEmail.mockResolvedValue(undefined);

    const { status, body } = await request("POST", "/api/residents/res-1/move-out", {
      body: { moveOutDate: "2026-05-15", deactivateAccount: true },
    });

    expect(status).toBe(200);
    expect(storageMock.deactivateAndUnlinkUser).not.toHaveBeenCalled();
    expect((body as { accountDeactivated: boolean }).accountDeactivated).toBe(false);
  });

  it("refuses staff outside the resident's region, changing nothing", async () => {
    actAs(STAFF, { ...ALL_PROPERTIES, allowedRegions: ["East Central"] });
    storageMock.getResident.mockResolvedValue(WEST_RESIDENT);

    const { status } = await request("POST", "/api/residents/res-1/move-out", {
      body: { moveOutDate: "2026-05-15", deactivateAccount: true },
    });

    expect(status).toBe(403);
    expect(storageMock.updateResident).not.toHaveBeenCalled();
    expect(storageMock.deactivateAndUnlinkUser).not.toHaveBeenCalled();
  });

  it("refuses a resident, changing nothing", async () => {
    actAs(ALICE, ALL_MAINTENANCE);

    const { status } = await request("POST", "/api/residents/res-1/move-out", {
      body: { moveOutDate: "2026-05-15", deactivateAccount: true },
    });

    expect(status).toBe(403);
    expect(storageMock.updateResident).not.toHaveBeenCalled();
    expect(storageMock.deactivateAndUnlinkUser).not.toHaveBeenCalled();
  });

  it("tells staff in region whether the resident has an active login", async () => {
    actAs(STAFF, { ...ALL_PROPERTIES, allowedRegions: ["West Central"] });
    storageMock.getResident.mockResolvedValue(WEST_RESIDENT);
    storageMock.getActiveResidentAccountByEmail.mockResolvedValue(MARIA_LOGIN);

    const { status, body } = await get("/api/residents/res-1/account-status");
    expect(status).toBe(200);
    expect(body).toEqual({ hasActiveAccount: true });
  });

  it("reports no login when the only match is linked to another house", async () => {
    actAs(STAFF, { ...ALL_PROPERTIES, allowedRegions: ["West Central"] });
    storageMock.getResident.mockResolvedValue(WEST_RESIDENT);
    storageMock.getActiveResidentAccountByEmail.mockResolvedValue({ ...MARIA_LOGIN, propertyId: "prop-other" });

    const { status, body } = await get("/api/residents/res-1/account-status");
    expect(status).toBe(200);
    expect(body).toEqual({ hasActiveAccount: false });
  });

  it("reports no login when the match is not the roster email", async () => {
    actAs(STAFF, { ...ALL_PROPERTIES, allowedRegions: ["West Central"] });
    storageMock.getResident.mockResolvedValue({ ...WEST_RESIDENT, email: "mary_k@spo.org" });
    storageMock.getActiveResidentAccountByEmail.mockResolvedValue({ ...MARIA_LOGIN, email: "mary.k@spo.org" });

    const { status, body } = await get("/api/residents/res-1/account-status");
    expect(status).toBe(200);
    expect(body).toEqual({ hasActiveAccount: false });
  });

  it("hides account status from staff outside the region", async () => {
    actAs(STAFF, { ...ALL_PROPERTIES, allowedRegions: ["East Central"] });
    storageMock.getResident.mockResolvedValue(WEST_RESIDENT);

    const { status } = await get("/api/residents/res-1/account-status");
    expect(status).toBe(403);
    expect(storageMock.getActiveResidentAccountByEmail).not.toHaveBeenCalled();
  });
});

describe("deleting a resident", () => {
  const ALL_PROPERTIES = { canViewProperties: true, canManageProperties: true };
  const WEST_RESIDENT = {
    id: "res-1",
    propertyId: "prop-1",
    firstName: "Maria",
    lastName: "Gonzalez",
    email: "maria@spo.org",
    phone: "555-0100",
    region: "West Central",
    buildingAddress: "1 Main St",
    isActive: true,
  };

  it("records who was removed from which house, and nothing more personal", async () => {
    actAs(STAFF, { ...ALL_PROPERTIES, allowedRegions: ["West Central"] });
    storageMock.getResident.mockResolvedValue(WEST_RESIDENT);

    const { status } = await request("DELETE", "/api/residents/res-1");

    expect(status).toBe(200);
    expect(storageMock.deleteResident).toHaveBeenCalledWith("res-1");
    expect(storageMock.createAuditEvent).toHaveBeenCalledTimes(1);
    const event = storageMock.createAuditEvent.mock.calls[0][0];
    expect(event).toMatchObject({
      action: "resident.deleted",
      actorId: STAFF.id,
      entityType: "resident",
      entityId: "res-1",
      summary: "Removed Maria Gonzalez from the roster at 1 Main St",
    });
    // The contact details went with the row; the log must not keep them.
    expect(JSON.stringify(event)).not.toContain("maria@spo.org");
    expect(JSON.stringify(event)).not.toContain("555-0100");
  });

  it("records nothing when the delete is refused", async () => {
    actAs(STAFF, { ...ALL_PROPERTIES, allowedRegions: ["East Central"] });
    storageMock.getResident.mockResolvedValue(WEST_RESIDENT);

    const { status } = await request("DELETE", "/api/residents/res-1");

    expect(status).toBe(403);
    expect(storageMock.deleteResident).not.toHaveBeenCalled();
    expect(storageMock.createAuditEvent).not.toHaveBeenCalled();
  });
});

/**
 * Deleting a house takes its roster with it by cascade, and the roster takes
 * every HH fee, deposit and deduction. So a house that still has any of those
 * is refused, before anything is deleted, and a delete that does go through is
 * on the record.
 */
describe("deleting a house", () => {
  const ALL_PROPERTIES = { canViewProperties: true, canManageProperties: true };
  const WEST_HOUSE = { id: "prop-1", name: "Cleveland House", address: "1 Main St, St Paul, MN 55101", region: "West Central" };
  const NOTHING_LEFT = { residents: 0, hhFees: 0, deposits: 0, deductions: 0 };

  beforeEach(() => {
    storageMock.getProperty.mockResolvedValue(WEST_HOUSE);
    storageMock.getPropertyDeleteBlockers.mockResolvedValue(NOTHING_LEFT);
    storageMock.deleteProperty.mockResolvedValue([]);
  });

  it.each([
    ["residents on the roster", { residents: 2 }],
    ["HH fees", { hhFees: 1 }],
    ["deposits", { deposits: 1 }],
    ["deposit deductions", { deductions: 3 }],
  ])("refuses while the house still has %s, and deletes nothing", async (_what, left) => {
    actAs(STAFF, { ...ALL_PROPERTIES, allowedRegions: ["West Central"] });
    storageMock.getPropertyDeleteBlockers.mockResolvedValue({ ...NOTHING_LEFT, ...left });

    const { status, body } = await request("DELETE", "/api/properties/prop-1");

    expect(status).toBe(409);
    expect(body.message).toMatch(/can't be deleted/);
    expect(storageMock.getPropertyDeleteBlockers).toHaveBeenCalledWith("prop-1");
    expect(storageMock.deleteProperty).not.toHaveBeenCalled();
    expect(storageMock.createAuditEvent).not.toHaveBeenCalled();
  });

  it("says what is still on the house, in words a person can act on", async () => {
    actAs(ADMIN);
    storageMock.getPropertyDeleteBlockers.mockResolvedValue({ residents: 1, hhFees: 12, deposits: 1, deductions: 0 });

    const { status, body } = await request("DELETE", "/api/properties/prop-1");

    expect(status).toBe(409);
    expect(body.message).toBe(
      "Cleveland House can't be deleted: it still has 1 resident on its roster (moved-out residents count), 12 HH fee records and 1 deposit. Deleting the house would erase them.",
    );
  });

  it("deletes an empty house and records who deleted which house -- the positive control", async () => {
    actAs(STAFF, { ...ALL_PROPERTIES, allowedRegions: ["West Central"] });

    const { status } = await request("DELETE", "/api/properties/prop-1");

    expect(status).toBe(200);
    expect(storageMock.deleteProperty).toHaveBeenCalledWith("prop-1");
    expect(storageMock.createAuditEvent).toHaveBeenCalledTimes(1);
    expect(storageMock.createAuditEvent.mock.calls[0][0]).toMatchObject({
      action: "property.deleted",
      actorId: STAFF.id,
      entityType: "property",
      entityId: "prop-1",
      summary: "Deleted Cleveland House (1 Main St, St Paul, MN 55101)",
    });
  });

  it("refuses a resident account, and deletes nothing", async () => {
    actAs(ALICE, { canManageProperties: true, allowedRegions: ["West Central"] });

    expect((await request("DELETE", "/api/properties/prop-1")).status).toBe(403);
    expect(storageMock.deleteProperty).not.toHaveBeenCalled();
    expect(storageMock.createAuditEvent).not.toHaveBeenCalled();
  });

  it("refuses staff without the manage-properties flag, and deletes nothing", async () => {
    actAs(STAFF, { canViewProperties: true, allowedRegions: ["West Central"] });

    expect((await request("DELETE", "/api/properties/prop-1")).status).toBe(403);
    expect(storageMock.deleteProperty).not.toHaveBeenCalled();
    expect(storageMock.createAuditEvent).not.toHaveBeenCalled();
  });

  it("refuses staff outside the house's region, and deletes nothing", async () => {
    actAs(STAFF, { ...ALL_PROPERTIES, allowedRegions: ["East Central"] });

    expect((await request("DELETE", "/api/properties/prop-1")).status).toBe(403);
    expect(storageMock.deleteProperty).not.toHaveBeenCalled();
    expect(storageMock.createAuditEvent).not.toHaveBeenCalled();
  });
});

/**
 * A walkthrough room or photo belongs to a walkthrough, and the walkthrough
 * is what carries the region. These routes used to check the region the
 * request body named, or the room's loose propertyId, so a hand-made request
 * could add a room to another region's walkthrough or plant a photo in
 * another region's room. The scope is now read off the walkthrough, and the
 * body's region, house and property are overwritten from it.
 */
describe("walkthrough rooms and photos are scoped by their walkthrough, not the body", () => {
  const WT_WEST = { id: "wt-west", region: "West Central", buildingAddress: "1 Main St", propertyId: "prop-w" };
  const WT_SOUTH = { id: "wt-south", region: "Southwest", buildingAddress: "9 South Rd", propertyId: "prop-s" };
  const ROOM_WEST = { id: "room-west", walkthroughId: "wt-west", propertyId: "prop-w", buildingAddress: "1 Main St", name: "Kitchen", displayOrder: 0 };
  // The loose propertyId names a West house; the walkthrough says Southwest.
  const ROOM_SOUTH = { id: "room-south", walkthroughId: "wt-south", propertyId: "prop-w", buildingAddress: "9 South Rd", name: "Porch", displayOrder: 0 };
  const PHOTO_WEST = { id: "wp-west", roomId: "room-west", imageUrl: "/uploads/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jpg", region: "West Central", buildingAddress: "1 Main St", location: "Kitchen" };
  // A photo whose own region claims West, sitting in a Southwest room.
  const PHOTO_IN_SOUTH = { ...PHOTO_WEST, id: "wp-south", roomId: "room-south" };
  const westRA = { canViewWalkthroughs: true, canManageWalkthroughs: true, allowedRegions: ["West Central"] };
  const photoBody = (roomId: string) => ({
    roomId,
    imageUrl: "/uploads/0123456789abcdef0123456789abcdef.jpg",
    region: "West Central",
    buildingAddress: "1 Main St",
    location: "Kitchen",
    uploadedBy: "x",
  });

  beforeEach(() => {
    const walkthroughs: Record<string, unknown> = { [WT_WEST.id]: WT_WEST, [WT_SOUTH.id]: WT_SOUTH };
    const rooms: Record<string, unknown> = { [ROOM_WEST.id]: ROOM_WEST, [ROOM_SOUTH.id]: ROOM_SOUTH };
    const photos: Record<string, unknown> = { [PHOTO_WEST.id]: PHOTO_WEST, [PHOTO_IN_SOUTH.id]: PHOTO_IN_SOUTH };
    storageMock.getWalkthrough.mockImplementation(async (id: string) => walkthroughs[id]);
    storageMock.getWalkthroughRoom.mockImplementation(async (id: string) => rooms[id]);
    storageMock.getWalkthroughPhoto.mockImplementation(async (id: string) => photos[id]);
    storageMock.getProperty.mockResolvedValue({ id: "prop-w", region: "West Central", address: "1 Main St" });
    storageMock.createWalkthroughRoom.mockImplementation(async (r: unknown) => ({ id: "room-new", ...(r as object) }));
    storageMock.updateWalkthroughRoom.mockImplementation(async (id: string, r: unknown) => ({ ...(rooms[id] as object), ...(r as object) }));
    storageMock.createWalkthroughPhoto.mockImplementation(async (p: unknown) => ({ id: "wp-new", ...(p as object) }));
    storageMock.updateWalkthroughPhoto.mockImplementation(async (id: string, p: unknown) => ({ ...(photos[id] as object), ...(p as object) }));
    // The photo file is the caller's own upload, whatever else a test is about.
    storageMock.getUploadByStorageKey.mockResolvedValue({ storageKey: "0123456789abcdef0123456789abcdef.jpg", uploadedBy: STAFF.id });
  });

  // -- rooms -------------------------------------------------------------------

  it("refuses a room added to another region's walkthrough, whatever property the body names, and writes nothing", async () => {
    actAs(STAFF, westRA);
    const { status } = await request("POST", "/api/walkthrough-rooms", {
      body: { walkthroughId: WT_SOUTH.id, propertyId: "prop-w", buildingAddress: "1 Main St", name: "Shed", displayOrder: 9 },
    });
    expect(status).toBe(403);
    expect(storageMock.createWalkthroughRoom).not.toHaveBeenCalled();
  });

  it("refuses a room with no walkthrough, and writes nothing", async () => {
    actAs(STAFF, westRA);
    const { status } = await request("POST", "/api/walkthrough-rooms", {
      body: { buildingAddress: "1 Main St", name: "Shed", displayOrder: 9 },
    });
    expect(status).toBe(400);
    expect(storageMock.createWalkthroughRoom).not.toHaveBeenCalled();
  });

  it("adds a room to a walkthrough in the caller's region, taking house and property from the walkthrough", async () => {
    actAs(STAFF, westRA);
    const { status } = await request("POST", "/api/walkthrough-rooms", {
      body: { walkthroughId: WT_WEST.id, propertyId: "prop-s", buildingAddress: "9 South Rd", name: "Shed", displayOrder: 9 },
    });
    expect(status).toBe(200);
    expect(storageMock.createWalkthroughRoom).toHaveBeenCalledWith(
      expect.objectContaining({ walkthroughId: WT_WEST.id, propertyId: "prop-w", buildingAddress: "1 Main St" }),
    );
  });

  it("refuses an edit to a room in another region's walkthrough even when its loose propertyId names the caller's house", async () => {
    actAs(STAFF, westRA);
    expect((await request("PATCH", `/api/walkthrough-rooms/${ROOM_SOUTH.id}`, { body: { standingNote: "x" } })).status).toBe(403);
    expect(storageMock.updateWalkthroughRoom).not.toHaveBeenCalled();
  });

  it("never moves a room to another walkthrough through an edit", async () => {
    actAs(STAFF, westRA);
    await request("PATCH", `/api/walkthrough-rooms/${ROOM_WEST.id}`, {
      body: { walkthroughId: WT_SOUTH.id, propertyId: "prop-s", buildingAddress: "9 South Rd", standingNote: "x" },
    });
    // The rest of the edit goes through, so this is not passing on a refusal.
    expect(storageMock.updateWalkthroughRoom).toHaveBeenCalledTimes(1);
    for (const [, patch] of storageMock.updateWalkthroughRoom.mock.calls) {
      expect(patch).not.toHaveProperty("walkthroughId");
      expect(patch).not.toHaveProperty("propertyId");
      expect(patch).not.toHaveProperty("buildingAddress");
    }
  });

  it("edits a room's standing note in the caller's region -- the positive control", async () => {
    actAs(STAFF, westRA);
    expect((await request("PATCH", `/api/walkthrough-rooms/${ROOM_WEST.id}`, { body: { standingNote: "Photograph the crack." } })).status).toBe(200);
    expect(storageMock.updateWalkthroughRoom).toHaveBeenCalledWith(ROOM_WEST.id, expect.objectContaining({ standingNote: "Photograph the crack." }));
  });

  it("refuses deleting a room in another region's walkthrough even when its loose propertyId names the caller's house", async () => {
    actAs(STAFF, westRA);
    expect((await request("DELETE", `/api/walkthrough-rooms/${ROOM_SOUTH.id}`)).status).toBe(403);
    expect(storageMock.deleteWalkthroughRoom).not.toHaveBeenCalled();
  });

  it("deletes a room in the caller's region -- the positive control", async () => {
    actAs(STAFF, westRA);
    storageMock.deleteWalkthroughRoom.mockResolvedValue([]);
    expect((await request("DELETE", `/api/walkthrough-rooms/${ROOM_WEST.id}`)).status).toBe(200);
    expect(storageMock.deleteWalkthroughRoom).toHaveBeenCalledWith(ROOM_WEST.id);
  });

  // -- photos ------------------------------------------------------------------

  it("refuses a photo in another region's room whatever region the body names, and writes nothing", async () => {
    actAs(STAFF, westRA);
    expect((await request("POST", "/api/walkthrough-photos", { body: photoBody(ROOM_SOUTH.id) })).status).toBe(403);
    expect(storageMock.createWalkthroughPhoto).not.toHaveBeenCalled();
  });

  it("refuses a photo for a room that does not exist, and writes nothing", async () => {
    actAs(STAFF, westRA);
    expect((await request("POST", "/api/walkthrough-photos", { body: photoBody("room-nope") })).status).toBe(404);
    expect(storageMock.createWalkthroughPhoto).not.toHaveBeenCalled();
  });

  it("stores a photo in the caller's region with the region and house of its walkthrough, not the body's", async () => {
    actAs(STAFF, westRA);
    const { status } = await request("POST", "/api/walkthrough-photos", {
      body: { ...photoBody(ROOM_WEST.id), region: "Southwest", buildingAddress: "9 South Rd" },
    });
    expect(status).toBe(200);
    expect(storageMock.createWalkthroughPhoto).toHaveBeenCalledWith(
      expect.objectContaining({ roomId: ROOM_WEST.id, region: "West Central", buildingAddress: "1 Main St" }),
    );
  });

  it("never moves a photo to another room through an edit", async () => {
    actAs(STAFF, westRA);
    await request("PATCH", `/api/walkthrough-photos/${PHOTO_WEST.id}`, { body: { roomId: ROOM_SOUTH.id, buildingAddress: "9 South Rd", notes: "x" } });
    expect(storageMock.updateWalkthroughPhoto).toHaveBeenCalledTimes(1);
    for (const [, patch] of storageMock.updateWalkthroughPhoto.mock.calls) {
      expect(patch).not.toHaveProperty("roomId");
      expect(patch).not.toHaveProperty("region");
      expect(patch).not.toHaveProperty("buildingAddress");
    }
  });

  it("refuses an edit to a photo in another region's room even when the photo's own region says otherwise", async () => {
    actAs(STAFF, westRA);
    expect((await request("PATCH", `/api/walkthrough-photos/${PHOTO_IN_SOUTH.id}`, { body: { notes: "x" } })).status).toBe(403);
    expect(storageMock.updateWalkthroughPhoto).not.toHaveBeenCalled();
  });

  it("edits a photo's notes in the caller's region -- the positive control", async () => {
    actAs(STAFF, westRA);
    expect((await request("PATCH", `/api/walkthrough-photos/${PHOTO_WEST.id}`, { body: { notes: "Crack by the window." } })).status).toBe(200);
    expect(storageMock.updateWalkthroughPhoto).toHaveBeenCalledWith(PHOTO_WEST.id, expect.objectContaining({ notes: "Crack by the window." }));
  });
});

describe("deleting a record removes the files it held", () => {
  const WEST_PHOTO = { id: "wp-1", roomId: "room-1", imageUrl: "/uploads/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jpg", region: "West Central" };
  const WEST_PROPERTY_ROW = { id: "prop-1", name: "Cleveland House", address: "1 Main St", region: "West Central" };

  it("removes a deleted walkthrough photo's file and its upload record", async () => {
    actAs(ADMIN);
    storageMock.getWalkthroughPhoto.mockResolvedValue(WEST_PHOTO);
    storageMock.deleteWalkthroughPhoto.mockResolvedValue([WEST_PHOTO.imageUrl]);

    expect((await request("DELETE", "/api/walkthrough-photos/wp-1")).status).toBe(200);
    expect(fileStoreMock.removeUpload).toHaveBeenCalledWith("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jpg");
    expect(storageMock.deleteUpload).toHaveBeenCalledWith("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jpg");
  });

  it("removes every file a deleted house takes with it", async () => {
    actAs(ADMIN);
    storageMock.getProperty.mockResolvedValue(WEST_PROPERTY_ROW);
    storageMock.getPropertyDeleteBlockers.mockResolvedValue({ residents: 0, hhFees: 0, deposits: 0, deductions: 0 });
    storageMock.deleteProperty.mockResolvedValue([
      "/uploads/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.jpg",
      "/uploads/cccccccccccccccccccccccccccccccc.jpg",
    ]);

    expect((await request("DELETE", "/api/properties/prop-1")).status).toBe(200);
    expect(fileStoreMock.removeUpload.mock.calls.map((call) => call[0])).toEqual([
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.jpg",
      "cccccccccccccccccccccccccccccccc.jpg",
    ]);
  });

  it("still answers 200 when the file store fails, because the row is already gone", async () => {
    actAs(ADMIN);
    storageMock.getWalkthroughPhoto.mockResolvedValue(WEST_PHOTO);
    storageMock.deleteWalkthroughPhoto.mockResolvedValue([WEST_PHOTO.imageUrl]);
    fileStoreMock.removeUpload.mockRejectedValue(new Error("bucket unreachable"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      expect((await request("DELETE", "/api/walkthrough-photos/wp-1")).status).toBe(200);
      expect(storageMock.deleteWalkthroughPhoto).toHaveBeenCalledWith("wp-1");
      // The object is still there, so its record of what it is stays too.
      expect(storageMock.deleteUpload).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("removes nothing when the delete is refused", async () => {
    actAs(STAFF, { canManageWalkthroughs: true, allowedRegions: ["East Central"] });
    storageMock.getWalkthroughPhoto.mockResolvedValue(WEST_PHOTO);

    expect((await request("DELETE", "/api/walkthrough-photos/wp-1")).status).toBe(403);
    expect(storageMock.deleteWalkthroughPhoto).not.toHaveBeenCalled();
    expect(fileStoreMock.removeUpload).not.toHaveBeenCalled();
  });
});

describe("resident finances (regional leads only)", () => {
  const WEST_PROPERTY = { id: "prop-west", name: "Cleveland House", region: "West Central", address: "1 Main St" };
  const WEST_RESIDENT = { id: "res-w", propertyId: "prop-west", region: "West Central", buildingAddress: "1 Main St", firstName: "Maria", lastName: "Diaz", isActive: true };
  const EAST_RESIDENT = { id: "res-e", propertyId: "prop-east", region: "East Central", buildingAddress: "2 River Rd", firstName: "Sam", lastName: "Cole", isActive: true };

  it("refuses a resident the rent list even with every permission", async () => {
    actAs(ALICE, { canViewProperties: true, canManageProperties: true, canViewMaintenance: true });
    const { status } = await get("/api/rent-payments");
    expect(status).toBe(403);
  });

  it("takes region and property from the resident on a rent charge, ignoring the body", async () => {
    actAs(STAFF, { canViewFinancials: true, canManageFinancials: true, allowedRegions: ["West Central"] });
    storageMock.getResident.mockResolvedValue(WEST_RESIDENT);
    storageMock.createRentPayment.mockImplementation(async (data: Record<string, unknown>) => ({ id: "rp-1", ...data }));

    const { status } = await request("POST", "/api/rent-payments", {
      body: { residentId: WEST_RESIDENT.id, period: "2026-08", amount: 500, region: "East Central", propertyId: "prop-evil", buildingAddress: "999 Evil St" },
    });

    expect(status).toBe(200);
    expect(storageMock.createRentPayment).toHaveBeenCalledWith(
      expect.objectContaining({ region: "West Central", propertyId: "prop-west", buildingAddress: "1 Main St", amount: "500" }),
    );
  });

  it("refuses recording rent for a resident in another region", async () => {
    actAs(STAFF, { canViewFinancials: true, canManageFinancials: true, allowedRegions: ["West Central"] });
    storageMock.getResident.mockResolvedValue(EAST_RESIDENT);

    const { status } = await request("POST", "/api/rent-payments", {
      body: { residentId: EAST_RESIDENT.id, period: "2026-08", amount: 500 },
    });

    expect(status).toBe(403);
    expect(storageMock.createRentPayment).not.toHaveBeenCalled();
  });

  it("generates charges only for current residents who lack one, using the given amount", async () => {
    actAs(STAFF, { canViewFinancials: true, canManageFinancials: true, allowedRegions: ["West Central"] });
    storageMock.getProperty.mockResolvedValue(WEST_PROPERTY);
    storageMock.getResidentsByProperty.mockResolvedValue([
      { ...WEST_RESIDENT, id: "res-a", isActive: true },
      { ...WEST_RESIDENT, id: "res-b", isActive: true },
      { ...WEST_RESIDENT, id: "res-gone", isActive: false }, // moved out — skipped
    ]);
    // res-a already has a charge for the month; res-b does not.
    storageMock.getRentPaymentForResidentPeriod.mockImplementation(async (id: string) => (id === "res-a" ? { id: "existing" } : undefined));
    storageMock.createRentPayment.mockImplementation(async (data: Record<string, unknown>) => ({ id: "new", ...data }));

    const { status, body } = await request("POST", "/api/rent-payments/generate", {
      body: { propertyId: WEST_PROPERTY.id, period: "2026-08", amount: 450 },
    });

    expect(status).toBe(200);
    expect(body.created).toBe(1); // only res-b
    expect(storageMock.createRentPayment).toHaveBeenCalledTimes(1);
    expect(storageMock.createRentPayment).toHaveBeenCalledWith(expect.objectContaining({ residentId: "res-b", amount: "450" }));
  });

  it.each(["2026-13", "2026-00"])("refuses to generate HH fees for month %s (#163)", async (period) => {
    actAs(STAFF, { canViewFinancials: true, canManageFinancials: true, allowedRegions: ["West Central"] });
    storageMock.getProperty.mockResolvedValue(WEST_PROPERTY);
    storageMock.getResidentsByProperty.mockResolvedValue([{ ...WEST_RESIDENT, id: "res-a", isActive: true }]);

    const { status } = await request("POST", "/api/rent-payments/generate", {
      body: { propertyId: WEST_PROPERTY.id, period, amount: 450 },
    });

    expect(status).toBe(400);
    expect(storageMock.createRentPayment).not.toHaveBeenCalled();
  });

  it.each(["2026-13", "2026-00"])("refuses a single HH-fee charge for month %s (#163)", async (period) => {
    actAs(STAFF, { canViewFinancials: true, canManageFinancials: true, allowedRegions: ["West Central"] });
    storageMock.getResident.mockResolvedValue(WEST_RESIDENT);

    const { status } = await request("POST", "/api/rent-payments", {
      body: { residentId: WEST_RESIDENT.id, period, amount: 500 },
    });

    expect(status).toBe(400);
    expect(storageMock.createRentPayment).not.toHaveBeenCalled();
  });

  it("still takes December (#163)", async () => {
    // The positive control for the month refusals above.
    actAs(STAFF, { canViewFinancials: true, canManageFinancials: true, allowedRegions: ["West Central"] });
    storageMock.getProperty.mockResolvedValue(WEST_PROPERTY);
    storageMock.getResidentsByProperty.mockResolvedValue([{ ...WEST_RESIDENT, id: "res-a", isActive: true }]);
    storageMock.getRentPaymentForResidentPeriod.mockResolvedValue(undefined);
    storageMock.createRentPayment.mockImplementation(async (data: Record<string, unknown>) => ({ id: "new", ...data }));

    const { status } = await request("POST", "/api/rent-payments/generate", {
      body: { propertyId: WEST_PROPERTY.id, period: "2026-12", amount: 450 },
    });

    expect(status).toBe(200);
    expect(storageMock.createRentPayment).toHaveBeenCalledTimes(1);
  });

  it("refuses to generate rent without an amount when the house has no prior charge", async () => {
    actAs(STAFF, { canViewFinancials: true, canManageFinancials: true, allowedRegions: ["West Central"] });
    storageMock.getProperty.mockResolvedValue(WEST_PROPERTY);
    storageMock.getLatestRentAmountForProperty.mockResolvedValue(undefined);

    const { status } = await request("POST", "/api/rent-payments/generate", {
      body: { propertyId: WEST_PROPERTY.id, period: "2026-08" },
    });

    expect(status).toBe(400);
    expect(storageMock.createRentPayment).not.toHaveBeenCalled();
  });

  it("does not let a rent patch change the resident, house, month or region", async () => {
    actAs(STAFF, { canViewFinancials: true, canManageFinancials: true, allowedRegions: ["West Central"] });
    storageMock.getRentPayment.mockResolvedValue({ id: "rp-1", region: "West Central" });
    storageMock.updateRentPayment.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({ id, ...patch }));

    const { status } = await request("PATCH", "/api/rent-payments/rp-1", {
      body: { status: "paid", residentId: "res-evil", propertyId: "prop-evil", period: "1999-01", region: "East Central" },
    });

    expect(status).toBe(200);
    const patch = storageMock.updateRentPayment.mock.calls[0][1];
    for (const forbidden of ["residentId", "propertyId", "period", "region", "buildingAddress"]) {
      expect(patch).not.toHaveProperty(forbidden);
    }
    expect(patch).toMatchObject({ status: "paid" });
  });

  it("refuses a resident the deposit list", async () => {
    actAs(ALICE, { canManageProperties: true });
    const { status } = await get("/api/security-deposits");
    expect(status).toBe(403);
  });

  it("refuses a new deposit recording more returned than held (#163)", async () => {
    actAs(STAFF, { canViewFinancials: true, canManageFinancials: true, allowedRegions: ["West Central"] });
    storageMock.getResident.mockResolvedValue(WEST_RESIDENT);
    storageMock.getSecurityDepositByResident.mockResolvedValue(undefined);

    const { status } = await request("POST", "/api/security-deposits", {
      body: { residentId: WEST_RESIDENT.id, amountHeld: 300, amountReturned: 300.01 },
    });

    expect(status).toBe(400);
    expect(storageMock.createSecurityDeposit).not.toHaveBeenCalled();
  });

  it("refuses a deposit edit returning more than the stored amount held (#163)", async () => {
    // Checked over the row as it will be: the edit sends only what changed.
    actAs(STAFF, { canViewFinancials: true, canManageFinancials: true, allowedRegions: ["West Central"] });
    storageMock.getSecurityDeposit.mockResolvedValue({ id: "dep-1", region: "West Central", buildingAddress: "1 Main St", status: "held", amountHeld: "300.00", amountReturned: null });

    const { status } = await request("PATCH", "/api/security-deposits/dep-1", { body: { amountReturned: 450 } });

    expect(status).toBe(400);
    expect(storageMock.updateSecurityDeposit).not.toHaveBeenCalled();
  });

  it("refuses lowering the amount held below what was already returned (#163)", async () => {
    actAs(STAFF, { canViewFinancials: true, canManageFinancials: true, allowedRegions: ["West Central"] });
    storageMock.getSecurityDeposit.mockResolvedValue({ id: "dep-1", region: "West Central", buildingAddress: "1 Main St", status: "returned", amountHeld: "300.00", amountReturned: "300.00" });

    const { status } = await request("PATCH", "/api/security-deposits/dep-1", { body: { amountHeld: 200 } });

    expect(status).toBe(400);
    expect(storageMock.updateSecurityDeposit).not.toHaveBeenCalled();
  });

  it("takes a deposit returned in full (#163)", async () => {
    // The positive control: exactly the amount held is fine.
    actAs(STAFF, { canViewFinancials: true, canManageFinancials: true, allowedRegions: ["West Central"] });
    storageMock.getSecurityDeposit.mockResolvedValue({ id: "dep-1", region: "West Central", buildingAddress: "1 Main St", status: "held", amountHeld: "300.00", amountReturned: null });
    storageMock.updateSecurityDeposit.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({ id, ...patch }));

    const { status } = await request("PATCH", "/api/security-deposits/dep-1", { body: { status: "returned", amountReturned: 300 } });

    expect(status).toBe(200);
    expect(storageMock.updateSecurityDeposit).toHaveBeenCalledTimes(1);
  });

  it("refuses a second deposit for a resident who already has one", async () => {
    actAs(STAFF, { canViewFinancials: true, canManageFinancials: true, allowedRegions: ["West Central"] });
    storageMock.getResident.mockResolvedValue(WEST_RESIDENT);
    storageMock.getSecurityDepositByResident.mockResolvedValue({ id: "dep-existing" });

    const { status } = await request("POST", "/api/security-deposits", {
      body: { residentId: WEST_RESIDENT.id, amountHeld: 300 },
    });

    expect(status).toBe(409);
    expect(storageMock.createSecurityDeposit).not.toHaveBeenCalled();
  });

  it("takes region and property from the resident on a deposit, ignoring the body", async () => {
    actAs(STAFF, { canViewFinancials: true, canManageFinancials: true, allowedRegions: ["West Central"] });
    storageMock.getResident.mockResolvedValue(WEST_RESIDENT);
    storageMock.getSecurityDepositByResident.mockResolvedValue(undefined);
    storageMock.createSecurityDeposit.mockImplementation(async (data: Record<string, unknown>) => ({ id: "dep-1", ...data }));

    const { status } = await request("POST", "/api/security-deposits", {
      body: { residentId: WEST_RESIDENT.id, amountHeld: 300, region: "East Central", propertyId: "prop-evil" },
    });

    expect(status).toBe(200);
    expect(storageMock.createSecurityDeposit).toHaveBeenCalledWith(
      expect.objectContaining({ region: "West Central", propertyId: "prop-west", amountHeld: "300" }),
    );
  });

  it("records who recorded a rent charge", async () => {
    actAs(STAFF, { canViewFinancials: true, canManageFinancials: true, allowedRegions: ["West Central"] });
    storageMock.getResident.mockResolvedValue(WEST_RESIDENT);
    storageMock.createRentPayment.mockImplementation(async (data: Record<string, unknown>) => ({ id: "rp-1", ...data }));

    const { status } = await request("POST", "/api/rent-payments", {
      body: { residentId: WEST_RESIDENT.id, period: "2026-08", amount: 500 },
    });

    expect(status).toBe(200);
    expect(storageMock.createAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "rent_payment.created",
        entityType: "rent_payment",
        entityId: "rp-1",
        actorEmail: STAFF.email,
      }),
    );
  });

  it("records who changed a deposit — the withholding case leaves a trail", async () => {
    actAs(STAFF, { canViewFinancials: true, canManageFinancials: true, allowedRegions: ["West Central"] });
    storageMock.getSecurityDeposit.mockResolvedValue({ id: "dep-1", region: "West Central", buildingAddress: "1 Main St", status: "held" });
    storageMock.updateSecurityDeposit.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({ id, ...patch }));

    const { status } = await request("PATCH", "/api/security-deposits/dep-1", {
      body: { status: "withheld", amountReturned: 0, deductionsNotes: "damage to wall" },
    });

    expect(status).toBe(200);
    expect(storageMock.createAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "security_deposit.updated",
        entityId: "dep-1",
        details: expect.objectContaining({ status: "withheld" }),
      }),
    );
  });
});

describe("card and bank numbers in finance free text (#51)", () => {
  // The standard published test PAN and the Federal Reserve's routing number:
  // stand-ins for what somebody might paste, never real credentials.
  const CARD = "4111 1111 1111 1111";
  const ROUTING = "routing 021000021";
  const PROPERTY = { id: "prop-west", name: "Cleveland House", region: "West Central", address: "1 Main St" };
  const RESIDENT = { id: "res-w", firstName: "Maria", lastName: "Diaz", propertyId: "prop-west", region: "West Central", buildingAddress: "1 Main St", isActive: true };

  beforeEach(() => {
    actAs(STAFF, { canViewFinancials: true, canManageFinancials: true, allowedRegions: ["West Central"] });
    storageMock.getResident.mockResolvedValue(RESIDENT);
    storageMock.getProperty.mockResolvedValue(PROPERTY);
    storageMock.getResidentsByProperty.mockResolvedValue([RESIDENT]);
    storageMock.getSecurityDepositByResident.mockResolvedValue(undefined);
    storageMock.getRentPayment.mockResolvedValue({ id: "rp-1", region: "West Central", period: "2026-08", buildingAddress: "1 Main St" });
    storageMock.getSecurityDeposit.mockResolvedValue({ id: "dep-1", region: "West Central", buildingAddress: "1 Main St", status: "held", amountHeld: "300.00", amountReturned: null });
    storageMock.getDepositDeduction.mockResolvedValue({ id: "ded-1", residentId: "res-w", description: "Hole in wall", amount: "75.00", region: "West Central", buildingAddress: "1 Main St" });
    storageMock.createRentPayment.mockImplementation(async (data: Record<string, unknown>) => ({ id: "rp-1", ...data }));
    storageMock.updateRentPayment.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({ id, ...patch }));
    storageMock.createSecurityDeposit.mockImplementation(async (data: Record<string, unknown>) => ({ id: "dep-1", ...data }));
    storageMock.updateSecurityDeposit.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({ id, ...patch }));
    storageMock.createDepositDeduction.mockImplementation(async (data: Record<string, unknown>) => ({ id: "ded-1", ...data }));
    storageMock.createDepositDeductions.mockImplementation(async (rows: Record<string, unknown>[]) => rows.map((row, i) => ({ id: `ded-${i}`, ...row })));
    storageMock.updateDepositDeduction.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({ id, ...patch }));
  });

  // Each write path, the field it carries, the storage call it must never
  // reach, and a body with an honest value in that field.
  const paths: Array<{ name: string; method: "POST" | "PATCH"; url: string; write: string; body: (value: string) => Record<string, unknown> }> = [
    { name: "a new HH fee's reference", method: "POST", url: "/api/rent-payments", write: "createRentPayment", body: (v) => ({ residentId: "res-w", period: "2026-08", amount: 500, reference: v }) },
    { name: "a new HH fee's notes", method: "POST", url: "/api/rent-payments", write: "createRentPayment", body: (v) => ({ residentId: "res-w", period: "2026-08", amount: 500, notes: v }) },
    { name: "an HH fee edit's reference", method: "PATCH", url: "/api/rent-payments/rp-1", write: "updateRentPayment", body: (v) => ({ status: "paid", reference: v }) },
    { name: "an HH fee edit's notes", method: "PATCH", url: "/api/rent-payments/rp-1", write: "updateRentPayment", body: (v) => ({ notes: v }) },
    { name: "a new deposit's close-out reference", method: "POST", url: "/api/security-deposits", write: "createSecurityDeposit", body: (v) => ({ residentId: "res-w", amountHeld: 300, closeoutReference: v }) },
    { name: "a new deposit's earlier notes", method: "POST", url: "/api/security-deposits", write: "createSecurityDeposit", body: (v) => ({ residentId: "res-w", amountHeld: 300, deductionsNotes: v }) },
    { name: "a deposit edit's close-out reference", method: "PATCH", url: "/api/security-deposits/dep-1", write: "updateSecurityDeposit", body: (v) => ({ closeoutReference: v }) },
    { name: "a deposit edit's earlier notes", method: "PATCH", url: "/api/security-deposits/dep-1", write: "updateSecurityDeposit", body: (v) => ({ deductionsNotes: v }) },
    { name: "a new deduction's description", method: "POST", url: "/api/deposit-deductions", write: "createDepositDeduction", body: (v) => ({ residentId: "res-w", description: v, amount: 75, chargeDate: "2026-06-01" }) },
    { name: "a deduction edit's description", method: "PATCH", url: "/api/deposit-deductions/ded-1", write: "updateDepositDeduction", body: (v) => ({ description: v }) },
    { name: "a split charge's description", method: "POST", url: "/api/deposit-deductions/split", write: "createDepositDeductions", body: (v) => ({ propertyId: "prop-west", description: v, amount: 90, chargeDate: "2026-06-01", residentIds: ["res-w"] }) },
  ];

  it.each(paths)("refuses a card number in $name, without writing", async ({ method, url, write, body }) => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { status, body: response } = await request(method, url, { body: body(CARD) });

    expect(status).toBe(400);
    expect(storageMock[write as keyof typeof storageMock]).not.toHaveBeenCalled();
    expect(storageMock.createAuditEvent).not.toHaveBeenCalled();
    // The refusal says what to record instead, and repeats nothing typed --
    // neither to the caller nor into the log.
    expect(JSON.stringify(response)).toContain("QuickBooks or Ramp reference");
    expect(JSON.stringify(response)).not.toContain("1111");
    expect(JSON.stringify(warned.mock.calls)).not.toContain("1111");
    warned.mockRestore();
  });

  it.each(paths)("refuses a labelled routing number in $name, without writing", async ({ method, url, write, body }) => {
    const { status, body: response } = await request(method, url, { body: body(ROUTING) });

    expect(status).toBe(400);
    expect(storageMock[write as keyof typeof storageMock]).not.toHaveBeenCalled();
    expect(JSON.stringify(response)).not.toContain("021000021");
  });

  it.each(paths)("still takes a processor reference in $name", async ({ method, url, write, body }) => {
    // The positive control: the same request with an honest value writes,
    // so the refusals above are the rule and not a broken fixture.
    const { status } = await request(method, url, { body: body("Ramp txn 4829301756") });

    expect(status).toBe(200);
    expect(storageMock[write as keyof typeof storageMock]).toHaveBeenCalledTimes(1);
  });
});

describe("the resource hub", () => {
  const WEST = { id: "prop-west", name: "Cleveland House", region: "West Central", address: "1 Main St" };

  const LINKS = [
    { id: "l-national", title: "Deep clean checklist", url: "https://drive.google.com/a", region: null, category: "Housekeeping", isActive: true, displayOrder: 0 },
    { id: "l-west", title: "West Central contacts", url: "https://drive.google.com/b", region: "West Central", category: "General", isActive: true, displayOrder: 0 },
    { id: "l-east", title: "East Central contacts", url: "https://drive.google.com/c", region: "East Central", category: "General", isActive: true, displayOrder: 0 },
    { id: "l-off", title: "Retired memo", url: "https://drive.google.com/d", region: null, category: "General", isActive: false, displayOrder: 0 },
  ];

  beforeEach(() => {
    storageMock.getAllResourceLinks.mockResolvedValue(LINKS);
    storageMock.getProperty.mockResolvedValue(WEST);
    storageMock.createResourceLink.mockImplementation(async (link) => ({ id: "l-new", ...link }));
  });

  it("refuses an anonymous caller", async () => {
    expect((await get("/api/resource-links")).status).toBe(401);
  });

  it("refuses a resident who has not been granted the hub, without reading", async () => {
    // Leaders and stewards get their capabilities gated on a flag, exactly as
    // walkthrough completion is. Holding the walkthrough flag is not the same
    // grant and buys nothing here.
    actAs({ ...ALICE, propertyId: "prop-west" } as typeof ALICE, { canCompleteWalkthroughs: true });
    expect((await get("/api/resource-links")).status).toBe(403);
    expect(storageMock.getAllResourceLinks).not.toHaveBeenCalled();
  });

  it("gives a household leader the national links and their own region's", async () => {
    // For many students this is one of their few interactions with SPO as an
    // organisation, so a granted leader reaches it -- but only what applies.
    actAs({ ...ALICE, propertyId: "prop-west" } as typeof ALICE, { canViewResourceHub: true });
    const { status, body } = await get("/api/resource-links");
    expect(status).toBe(200);
    expect(body.map((link: { id: string }) => link.id).sort()).toEqual(["l-national", "l-west"]);
  });

  it("never gives a resident another region's links", async () => {
    // Their permissions row names a region deliberately: a resident's scope is
    // their HOUSE's region, never whatever a permissions row happens to say.
    actAs({ ...ALICE, propertyId: "prop-west" } as typeof ALICE, {
      canViewResourceHub: true,
      allowedRegions: ["East Central"],
    });
    const { body } = await get("/api/resource-links");
    expect(body.map((link: { id: string }) => link.id)).not.toContain("l-east");
  });

  it("gives a resident with no linked house the national links only", async () => {
    // Fails closed to the widest thing that is safe for everybody, rather than
    // to nothing -- a granted leader with a broken link should still find the
    // fire extinguisher guidance.
    actAs(ALICE, { canViewResourceHub: true });
    const { body } = await get("/api/resource-links");
    expect(body.map((link: { id: string }) => link.id)).toEqual(["l-national"]);
  });

  it("hides a retired link from the people who read the hub", async () => {
    actAs(STAFF, { canViewProperties: true, allowedRegions: ["West Central"] });
    const { body } = await get("/api/resource-links");
    expect(body.map((link: { id: string }) => link.id)).not.toContain("l-off");

    actAs({ ...ALICE, propertyId: "prop-west" } as typeof ALICE, { canViewResourceHub: true });
    const resident = await get("/api/resource-links");
    expect(resident.body.map((link: { id: string }) => link.id)).not.toContain("l-off");
  });

  it("still shows a retired link to an admin, so it can be brought back", async () => {
    // An admin is the only person who can hide one. If hiding it also hid it
    // from them, hiding would be indistinguishable from deleting.
    actAs(ADMIN);
    const { body } = await get("/api/resource-links");
    expect(body.map((link: { id: string }) => link.id)).toContain("l-off");
  });

  it("gives staff their regions' links plus the national ones", async () => {
    actAs(STAFF, { canViewProperties: true, allowedRegions: ["West Central"] });
    const { body } = await get("/api/resource-links");
    expect(body.map((link: { id: string }) => link.id).sort()).toEqual(["l-national", "l-west"]);
  });

  it("refuses a staff account holding no property permission", async () => {
    // The third layer. Without it an active staff account with an empty
    // permissions row reads every regional link while holding no flag at all.
    actAs(STAFF, { canViewMaintenance: true, allowedRegions: ["West Central"] });
    expect((await get("/api/resource-links")).status).toBe(403);
  });

  // ── Managing them is national, so it is admin-only ───────────────────────

  it("refuses a regional lead the write routes, without writing", async () => {
    // A national link reaches every region, exactly as the walkthrough
    // template does -- so it takes the same grant.
    actAs(STAFF, { canManageProperties: true, allowedRegions: ["West Central"] });
    const { status } = await request("POST", "/api/resource-links", {
      body: { title: "x", url: "https://example.com", category: "General" },
    });
    expect(status).toBe(403);
    expect(storageMock.createResourceLink).not.toHaveBeenCalled();
  });

  it("refuses a resident the write routes, even one granted the hub", async () => {
    // Reading the hub is not editing what everybody sees.
    actAs(ALICE, { canViewResourceHub: true });
    const { status } = await request("POST", "/api/resource-links", {
      body: { title: "x", url: "https://example.com", category: "General" },
    });
    expect(status).toBe(403);
    expect(storageMock.createResourceLink).not.toHaveBeenCalled();
  });

  it("refuses a javascript: URL, without storing it", async () => {
    // Every viewer of this page clicks these, residents included.
    actAs(ADMIN);
    const { status } = await request("POST", "/api/resource-links", {
      body: { title: "x", url: "javascript:alert(1)", category: "General" },
    });
    expect(status).toBe(400);
    expect(storageMock.createResourceLink).not.toHaveBeenCalled();
  });

  // The positive control.
  it("lets an admin add one", async () => {
    actAs(ADMIN);
    const { status } = await request("POST", "/api/resource-links", {
      body: { title: "Deep clean checklist", url: "https://drive.google.com/a", category: "Housekeeping" },
    });
    expect(status).toBe(200);
    expect(storageMock.createResourceLink).toHaveBeenCalled();
  });

  it("refuses a region that is not one of SPO's, without storing it (#164)", async () => {
    // A link saved as "northwest" was shown to nobody in Northwest.
    actAs(ADMIN);
    const { status } = await request("POST", "/api/resource-links", {
      body: { title: "x", url: "https://example.com", category: "General", region: "northwest" },
    });
    expect(status).toBe(400);
    expect(storageMock.createResourceLink).not.toHaveBeenCalled();
  });

  it("takes a region spelled as the list spells it (#164)", async () => {
    actAs(ADMIN);
    const { status } = await request("POST", "/api/resource-links", {
      body: { title: "x", url: "https://example.com", category: "General", region: "Northwest" },
    });
    expect(status).toBe(200);
    expect(storageMock.createResourceLink).toHaveBeenCalledWith(expect.objectContaining({ region: "Northwest" }));
  });

  // ── The three named slots (amendment to 8.1) ─────────────────────────────

  it("refuses a slot key the page has no place for, without storing it", async () => {
    actAs(ADMIN);
    const { status } = await request("POST", "/api/resource-links", {
      body: { title: "x", url: "https://example.com", category: "Safety", slotKey: "parking_policy" },
    });
    expect(status).toBe(400);
    expect(storageMock.createResourceLink).not.toHaveBeenCalled();
  });

  it("refuses a slotted link scoped to one region, because the slots are national", async () => {
    actAs(ADMIN);
    const { status, body } = await request("POST", "/api/resource-links", {
      body: { title: "x", url: "https://example.com", category: "Safety", slotKey: "active_shooter", region: "West Central" },
    });
    expect(status).toBe(400);
    expect(body.message).toMatch(/every region/i);
    expect(storageMock.createResourceLink).not.toHaveBeenCalled();
  });

  it("refuses a second link claiming a slot another link already holds", async () => {
    actAs(ADMIN);
    storageMock.getAllResourceLinks.mockResolvedValue([
      ...LINKS,
      { id: "l-conduct", title: "Code of conduct 2025", url: "https://drive.google.com/e", region: null, category: "General", isActive: true, displayOrder: 0, slotKey: "code_of_conduct" },
    ]);
    const { status, body } = await request("POST", "/api/resource-links", {
      body: { title: "Code of conduct 2026", url: "https://drive.google.com/f", category: "General", slotKey: "code_of_conduct" },
    });
    expect(status).toBe(400);
    expect(body.message).toContain("Code of conduct 2025");
    expect(storageMock.createResourceLink).not.toHaveBeenCalled();
  });

  it("refuses moving a link into a slot another link holds, without writing", async () => {
    actAs(ADMIN);
    storageMock.getAllResourceLinks.mockResolvedValue([
      ...LINKS,
      { id: "l-conduct", title: "Code of conduct 2025", url: "https://drive.google.com/e", region: null, category: "General", isActive: true, displayOrder: 0, slotKey: "code_of_conduct" },
    ]);
    storageMock.getResourceLink.mockResolvedValue(LINKS[0]);
    const { status } = await request("PATCH", "/api/resource-links/l-national", { body: { slotKey: "code_of_conduct" } });
    expect(status).toBe(400);
    expect(storageMock.updateResourceLink).not.toHaveBeenCalled();
  });

  it("refuses narrowing a slotted link to one region on edit, checked over the stored row", async () => {
    // An edit sends only the field it changes, so the region check has to
    // read the slot off the stored row, not off the body.
    actAs(ADMIN);
    storageMock.getResourceLink.mockResolvedValue({ ...LINKS[0], id: "l-conduct", slotKey: "code_of_conduct" });
    const { status } = await request("PATCH", "/api/resource-links/l-conduct", { body: { region: "West Central" } });
    expect(status).toBe(400);
    expect(storageMock.updateResourceLink).not.toHaveBeenCalled();
  });

  // Positive controls: an admin binds a slot, and re-saving the holder itself
  // is not a clash.
  it("lets an admin bind a national link to a slot", async () => {
    actAs(ADMIN);
    const { status } = await request("POST", "/api/resource-links", {
      body: { title: "Household Code of Conduct", url: "https://drive.google.com/e", category: "General", slotKey: "code_of_conduct" },
    });
    expect(status).toBe(200);
    expect(storageMock.createResourceLink).toHaveBeenCalledWith(expect.objectContaining({ slotKey: "code_of_conduct" }));
  });

  it("lets an admin edit the link that holds a slot without tripping over itself", async () => {
    actAs(ADMIN);
    const holder = { ...LINKS[0], id: "l-conduct", slotKey: "code_of_conduct" };
    storageMock.getAllResourceLinks.mockResolvedValue([...LINKS, holder]);
    storageMock.getResourceLink.mockResolvedValue(holder);
    storageMock.updateResourceLink.mockResolvedValue(holder);
    const { status } = await request("PATCH", "/api/resource-links/l-conduct", { body: { slotKey: "code_of_conduct", title: "Code of Conduct" } });
    expect(status).toBe(200);
    expect(storageMock.updateResourceLink).toHaveBeenCalled();
  });

  it("gives a household leader with no house the slotted national links", async () => {
    // The slots are what a leader with a broken house link most needs to
    // still find -- the fire extinguisher guidance is one of them.
    actAs(ALICE, { canViewResourceHub: true });
    storageMock.getAllResourceLinks.mockResolvedValue([
      ...LINKS,
      { id: "l-fire", title: "Fire Extinguisher guidelines", url: "https://drive.google.com/g", region: null, category: "Safety", isActive: true, displayOrder: 0, slotKey: "fire_extinguisher" },
    ]);
    const { body } = await get("/api/resource-links");
    expect(body.map((link: { id: string }) => link.id).sort()).toEqual(["l-fire", "l-national"]);
  });
});

describe("a resident reading their own house", () => {
  const WEST = {
    id: "prop-west",
    name: "Cleveland House",
    region: "West Central",
    address: "1 Main St",
    leaseDocumentUrl: "https://drive.google.com/lease",
    depositAmount: "500.00",
    notes: "Staff-only notes",
  };

  beforeEach(() => {
    storageMock.getProperty.mockResolvedValue(WEST);
    storageMock.getResidentsByProperty.mockResolvedValue([]);
  });

  it("refuses an anonymous caller", async () => {
    expect((await get("/api/my-property")).status).toBe(401);
  });

  it("refuses a resident who has not been granted the hub, without a lookup", async () => {
    actAs({ ...ALICE, propertyId: "prop-west" } as typeof ALICE, { canCompleteWalkthroughs: true });
    expect((await get("/api/my-property")).status).toBe(403);
    expect(storageMock.getProperty).not.toHaveBeenCalled();
  });

  it("gives a granted resident their lease link and nothing financial", async () => {
    // A projection of named fields, not the row: a column added to properties
    // later must not silently start reaching a resident.
    actAs({ ...ALICE, propertyId: "prop-west" } as typeof ALICE, { canViewResourceHub: true });
    const { status, body } = await get("/api/my-property");
    expect(status).toBe(200);
    expect(body.leaseDocumentUrl).toBe("https://drive.google.com/lease");
    expect(body).not.toHaveProperty("depositAmount");
    expect(body).not.toHaveProperty("notes");
    expect(body).not.toHaveProperty("depositReturnDays");
  });

  it("answers null for a granted resident linked to no house, without a lookup", async () => {
    actAs(ALICE, { canViewResourceHub: true });
    const { status, body } = await get("/api/my-property");
    expect(status).toBe(200);
    expect(body).toBeNull();
    expect(storageMock.getProperty).not.toHaveBeenCalled();
  });

  it("answers null for staff, who have the full property list already", async () => {
    actAs(STAFF, { canViewProperties: true, allowedRegions: ["West Central"] });
    expect((await get("/api/my-property")).body).toBeNull();
  });
});

/**
 * House facts and access codes (ADR-0002).
 *
 * The portal refuses to hold credentials, and a door code looks like one. It
 * holds these anyway, under three constraints this block proves over HTTP: a
 * code reaches that house's household and staff and nobody else; a change
 * records which code on which house and never the value; and the last-changed
 * date moves only when the value does.
 */
describe("house facts and access codes", () => {
  const WEST = {
    id: "prop-west",
    name: "Cleveland House",
    region: "West Central",
    address: "1 Main St",
    ownership: "rented",
    leaseDocumentUrl: null,
    maintenancePortalUrl: "https://landlord.example.com/portal",
    rentalCompanyContactId: "c-landlord",
    notes: "Staff-only notes",
  };
  const EAST = { id: "prop-east", name: "Toledo House", region: "East Central", address: "2 Elm St", ownership: "owned", notes: "Staff-only notes" };

  const LANDLORD = {
    id: "c-landlord",
    name: "Pat Landlord",
    company: "Elm Rentals",
    phone: "555-0100",
    email: "pat@example.com",
    region: "West Central",
  };

  const LAST_YEAR = new Date("2025-01-15T00:00:00.000Z");
  const EXISTING = {
    id: "facts-west",
    propertyId: "prop-west",
    doorCode: "4321",
    doorCodeUpdatedAt: LAST_YEAR,
    gateCode: null,
    gateCodeUpdatedAt: null,
    alarmCode: "9876",
    alarmCodeUpdatedAt: LAST_YEAR,
    securityNotes: "Camera over the back door",
    parkingRules: "Driveway only",
    surfaceCare: null,
    doNots: null,
    rubbishDay: "Tuesday",
    otherNotes: null,
  };

  /** The full block, as the staff form always sends every field. */
  const SAME_AS_EXISTING = {
    doorCode: "4321",
    gateCode: null,
    alarmCode: "9876",
    securityNotes: "Camera over the back door",
    parkingRules: "Driveway only",
    surfaceCare: null,
    doNots: null,
    rubbishDay: "Tuesday",
    otherNotes: null,
  };

  const put = (path: string, body: unknown) => request("PUT", path, { body });

  /** The row the route asked storage to write. */
  function written() {
    const calls = storageMock.upsertPropertyFacts.mock.calls;
    expect(calls).toHaveLength(1);
    return calls[0][1];
  }

  beforeEach(() => {
    storageMock.getProperty.mockImplementation(async (id: string) =>
      id === "prop-west" ? WEST : id === "prop-east" ? EAST : undefined,
    );
    storageMock.getMaintenanceContact.mockImplementation(async (id: string) =>
      id === "c-landlord" ? LANDLORD : undefined,
    );
    storageMock.getPropertyFacts.mockImplementation(async (propertyId: string) =>
      propertyId === "prop-west" ? EXISTING : undefined,
    );
    storageMock.upsertPropertyFacts.mockImplementation(async (propertyId: string, facts) => ({
      id: "facts-west",
      propertyId,
      ...facts,
    }));
    rosterIs([ALICE_ON_WEST_ROSTER]);
  });

  // The household is whoever is on the house's roster today. Storage answers
  // the roster by house, so the mock does too.
  const ALICE_ON_WEST_ROSTER = { id: "res-alice", propertyId: "prop-west", email: "alice@example.com", isActive: true };
  function rosterIs(rows: Array<{ propertyId: string; email: string; isActive: boolean }>) {
    storageMock.getResidentsByProperty.mockImplementation(async (propertyId: string) =>
      rows.filter((row) => row.propertyId === propertyId),
    );
  }

  // ── Who may read ─────────────────────────────────────────────────────────

  it("refuses an anonymous caller", async () => {
    expect((await get("/api/properties/prop-west/facts")).status).toBe(401);
    expect((await put("/api/properties/prop-west/facts", SAME_AS_EXISTING)).status).toBe(401);
  });

  it("refuses a resident the staff read route, even for their own house", async () => {
    // A household reads its facts through the hub projection and nothing
    // else. The staff route is region-scoped, and a resident must not acquire
    // a region path here any more than on walkthroughs.
    actAs({ ...ALICE, propertyId: "prop-west" } as typeof ALICE, { canViewResourceHub: true });
    const { status } = await get("/api/properties/prop-west/facts");
    expect(status).toBe(403);
    expect(storageMock.getPropertyFacts).not.toHaveBeenCalled();
  });

  it("refuses a resident even when their row carries staff property flags and every region", async () => {
    // The row a resident should never hold, but the one that would get past
    // the flag and region layers: only the staff check stands in its way.
    actAs({ ...ALICE, propertyId: "prop-west" } as typeof ALICE, {
      canViewProperties: true,
      canManageProperties: true,
      canViewResourceHub: true,
      allowedRegions: ["all"],
    });
    const { status } = await get("/api/properties/prop-west/facts");
    expect(status).toBe(403);
    expect(storageMock.getProperty).not.toHaveBeenCalled();
    expect(storageMock.getPropertyFacts).not.toHaveBeenCalled();
  });

  it("gives a resident of another house nothing of this house's facts", async () => {
    // Bob lives in the east house. His own-house projection is the only read
    // he has, and it answers only for the house on his account -- so the
    // west house's codes are never even looked up on his behalf.
    actAs({ ...BOB, propertyId: "prop-east" } as typeof BOB, { canViewResourceHub: true });
    const { status, body } = await get("/api/my-property");
    expect(status).toBe(200);
    expect(body.id).toBe("prop-east");
    expect(body.facts).toBeNull();
    expect(storageMock.getPropertyFacts).not.toHaveBeenCalledWith("prop-west");
    expect(JSON.stringify(body)).not.toContain("4321");
  });

  it("gives a household leader their own house's facts, codes and dates included", async () => {
    actAs({ ...ALICE, propertyId: "prop-west" } as typeof ALICE, { canViewResourceHub: true });
    const { status, body } = await get("/api/my-property");
    expect(status).toBe(200);
    expect(body.facts).toEqual({
      doorCode: "4321",
      doorCodeUpdatedAt: LAST_YEAR.toISOString(),
      gateCode: null,
      gateCodeUpdatedAt: null,
      alarmCode: "9876",
      alarmCodeUpdatedAt: LAST_YEAR.toISOString(),
      securityNotes: "Camera over the back door",
      parkingRules: "Driveway only",
      surfaceCare: null,
      doNots: null,
      rubbishDay: "Tuesday",
      otherNotes: null,
    });
  });

  // The house link on the account is not enough for the codes: the login
  // has to be on the house's roster today, by the same exact email rule that
  // move-out uses. A linked login off the roster still gets the rest of the
  // hub's house card, just not the facts.
  describe("the codes follow the roster, not only the house link", () => {
    const LINKED_ALICE = { ...ALICE, propertyId: "prop-west" } as typeof ALICE;

    async function expectNoFacts() {
      actAs(LINKED_ALICE, { canViewResourceHub: true });
      const { status, body } = await get("/api/my-property");
      expect(status).toBe(200);
      expect(body.id).toBe("prop-west");
      expect(body.facts).toBeNull();
      expect(JSON.stringify(body)).not.toContain("4321");
      expect(storageMock.getPropertyFacts).not.toHaveBeenCalled();
    }

    it("withholds them from a linked login with no roster row (never rostered, or removed from it)", async () => {
      rosterIs([]);
      await expectNoFacts();
    });

    it("withholds them from a linked login whose roster row is moved out", async () => {
      rosterIs([{ ...ALICE_ON_WEST_ROSTER, isActive: false }]);
      await expectNoFacts();
    });

    it("withholds them from a linked login rostered at another house", async () => {
      rosterIs([{ ...ALICE_ON_WEST_ROSTER, propertyId: "prop-east" }]);
      await expectNoFacts();
    });

    it("withholds them when the house's roster row carries a different email", async () => {
      rosterIs([{ ...ALICE_ON_WEST_ROSTER, email: "alice.k@example.com" }]);
      await expectNoFacts();
    });

    it("withholds them once the roster row's stop date has passed, even while it is still marked active", async () => {
      rosterIs([{ ...ALICE_ON_WEST_ROSTER, isActive: true, moveOutDate: new Date("2020-01-01T00:00:00Z") }]);
      await expectNoFacts();
    });

    it("gives them to a login on the house's active roster, email case aside", async () => {
      rosterIs([{ ...ALICE_ON_WEST_ROSTER, email: "Alice@Example.com" }]);
      actAs(LINKED_ALICE, { canViewResourceHub: true });
      const { status, body } = await get("/api/my-property");
      expect(status).toBe(200);
      expect(body.facts.doorCode).toBe("4321");
      expect(storageMock.getPropertyFacts).toHaveBeenCalledWith("prop-west");
    });
  });

  it("carries who to call and the portal for a rented house, from the property's own fields", async () => {
    // Read from the existing property columns, never retyped into the facts.
    actAs({ ...ALICE, propertyId: "prop-west" } as typeof ALICE, { canViewResourceHub: true });
    const { body } = await get("/api/my-property");
    expect(body.rentalCompany).toEqual({ name: "Pat Landlord", company: "Elm Rentals", phone: "555-0100" });
    expect(body.maintenancePortalUrl).toBe("https://landlord.example.com/portal");
  });

  it("never lets staff notes into the projection", async () => {
    // Staff notes and house facts are visibly different fields precisely so a
    // staff-only remark never reaches the household.
    actAs({ ...ALICE, propertyId: "prop-west" } as typeof ALICE, { canViewResourceHub: true });
    const { body } = await get("/api/my-property");
    expect(body).not.toHaveProperty("notes");
    expect(body.facts).not.toHaveProperty("notes");
    expect(JSON.stringify(body)).not.toContain("Staff-only notes");
  });

  it("resolves the house from the account, never from a permissions row naming another region", async () => {
    // Same rule as the resource links: a resident's scope is their HOUSE, and
    // a permissions row that happens to name a region grants nothing here.
    actAs({ ...ALICE, propertyId: "prop-west" } as typeof ALICE, {
      canViewResourceHub: true,
      allowedRegions: ["East Central"],
    });
    const { status, body } = await get("/api/my-property");
    expect(status).toBe(200);
    expect(body.id).toBe("prop-west");
    expect(body.facts.doorCode).toBe("4321");
    expect(storageMock.getPropertyFacts).toHaveBeenCalledWith("prop-west");
    expect(storageMock.getPropertyFacts).not.toHaveBeenCalledWith("prop-east");
  });

  it("still keeps the facts behind the hub grant", async () => {
    actAs({ ...ALICE, propertyId: "prop-west" } as typeof ALICE, { canCompleteWalkthroughs: true });
    expect((await get("/api/my-property")).status).toBe(403);
    expect(storageMock.getPropertyFacts).not.toHaveBeenCalled();
  });

  it("answers no facts for a house that has none recorded", async () => {
    actAs({ ...BOB, propertyId: "prop-east" } as typeof BOB, { canViewResourceHub: true });
    const { body } = await get("/api/my-property");
    expect(body.facts).toBeNull();
    expect(body.rentalCompany).toBeNull();
  });

  it("gives staff in the region the facts, and refuses staff outside it", async () => {
    actAs(STAFF, { canViewProperties: true, allowedRegions: ["West Central"] });
    const inRegion = await get("/api/properties/prop-west/facts");
    expect(inRegion.status).toBe(200);
    expect(inRegion.body.doorCode).toBe("4321");

    actAs(STAFF, { canViewProperties: true, allowedRegions: ["East Central"] });
    expect((await get("/api/properties/prop-west/facts")).status).toBe(403);
  });

  it("answers an empty block, not an error, for a house with no facts yet", async () => {
    actAs(ADMIN);
    const { status, body } = await get("/api/properties/prop-east/facts");
    expect(status).toBe(200);
    expect(body).toBeNull();
  });

  it("answers 404 for a house that does not exist", async () => {
    actAs(ADMIN);
    expect((await get("/api/properties/prop-nowhere/facts")).status).toBe(404);
    expect((await put("/api/properties/prop-nowhere/facts", SAME_AS_EXISTING)).status).toBe(404);
    expect(storageMock.upsertPropertyFacts).not.toHaveBeenCalled();
  });

  // ── Who may write ────────────────────────────────────────────────────────

  it("refuses a resident the write, without writing", async () => {
    actAs({ ...ALICE, propertyId: "prop-west" } as typeof ALICE, {
      canViewResourceHub: true,
      canCompleteWalkthroughs: true,
    });
    const { status } = await put("/api/properties/prop-west/facts", { ...SAME_AS_EXISTING, doorCode: "0000" });
    expect(status).toBe(403);
    expect(storageMock.upsertPropertyFacts).not.toHaveBeenCalled();
    expect(storageMock.createAuditEvent).not.toHaveBeenCalled();
  });

  it("refuses staff outside the region the write, without writing", async () => {
    actAs(STAFF, { canManageProperties: true, allowedRegions: ["East Central"] });
    const { status } = await put("/api/properties/prop-west/facts", { ...SAME_AS_EXISTING, doorCode: "0000" });
    expect(status).toBe(403);
    expect(storageMock.upsertPropertyFacts).not.toHaveBeenCalled();
    expect(storageMock.createAuditEvent).not.toHaveBeenCalled();
  });

  it("refuses staff holding only the view permission", async () => {
    actAs(STAFF, { canViewProperties: true, allowedRegions: ["West Central"] });
    const { status } = await put("/api/properties/prop-west/facts", SAME_AS_EXISTING);
    expect(status).toBe(403);
    expect(storageMock.upsertPropertyFacts).not.toHaveBeenCalled();
  });

  // The positive control.
  it("lets staff in the region save the block", async () => {
    actAs(STAFF, { canManageProperties: true, allowedRegions: ["West Central"] });
    const { status, body } = await put("/api/properties/prop-west/facts", {
      ...SAME_AS_EXISTING,
      parkingRules: "Driveway only; the street is permit parking",
    });
    expect(status).toBe(200);
    expect(body.parkingRules).toBe("Driveway only; the street is permit parking");
    expect(storageMock.upsertPropertyFacts).toHaveBeenCalledWith("prop-west", expect.objectContaining({
      parkingRules: "Driveway only; the street is permit parking",
    }));
  });

  it("refuses a code longer than a code, without writing", async () => {
    actAs(ADMIN);
    const { status } = await put("/api/properties/prop-west/facts", { ...SAME_AS_EXISTING, doorCode: "x".repeat(33) });
    expect(status).toBe(400);
    expect(storageMock.upsertPropertyFacts).not.toHaveBeenCalled();
  });

  // ── The audit rule: which code, which house, never the value ─────────────

  it("records a door code change naming the house and the code, never the value", async () => {
    actAs(ADMIN);
    await put("/api/properties/prop-west/facts", { ...SAME_AS_EXISTING, doorCode: "5555" });

    expect(storageMock.createAuditEvent).toHaveBeenCalledTimes(1);
    const event = storageMock.createAuditEvent.mock.calls[0][0];
    expect(event).toMatchObject({
      action: "property.access_code_changed",
      entityType: "property",
      entityId: "prop-west",
      actorId: ADMIN.id,
    });
    expect(event.summary).toContain("Door code");
    expect(event.summary).toContain("Cleveland House");
    // Neither the new code nor the old one, anywhere in the row.
    const recorded = JSON.stringify(event);
    expect(recorded).not.toContain("5555");
    expect(recorded).not.toContain("4321");
  });

  it("records one event per code that changed", async () => {
    actAs(ADMIN);
    await put("/api/properties/prop-west/facts", { ...SAME_AS_EXISTING, doorCode: "5555", alarmCode: "1111" });

    const summaries = storageMock.createAuditEvent.mock.calls.map((call) => call[0].summary as string).sort();
    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toContain("Alarm code");
    expect(summaries[1]).toContain("Door code");
    for (const call of storageMock.createAuditEvent.mock.calls) {
      const recorded = JSON.stringify(call[0]);
      expect(recorded).not.toContain("5555");
      expect(recorded).not.toContain("1111");
      expect(recorded).not.toContain("9876");
    }
  });

  it("treats clearing a code as a change", async () => {
    // A code that is gone is a code that changed; the household should see
    // the date move and the trail should say so.
    actAs(ADMIN);
    await put("/api/properties/prop-west/facts", { ...SAME_AS_EXISTING, alarmCode: null });

    expect(storageMock.createAuditEvent).toHaveBeenCalledTimes(1);
    expect(storageMock.createAuditEvent.mock.calls[0][0].summary).toContain("Alarm code");
    expect(written().alarmCode).toBeNull();
    expect(written().alarmCodeUpdatedAt).not.toEqual(LAST_YEAR);
  });

  it("records nothing when only the rubbish day changed", async () => {
    actAs(ADMIN);
    const { status } = await put("/api/properties/prop-west/facts", { ...SAME_AS_EXISTING, rubbishDay: "Wednesday" });
    expect(status).toBe(200);
    expect(storageMock.createAuditEvent).not.toHaveBeenCalled();
  });

  it("records nothing when the same block is saved again", async () => {
    actAs(ADMIN);
    await put("/api/properties/prop-west/facts", SAME_AS_EXISTING);
    expect(storageMock.createAuditEvent).not.toHaveBeenCalled();
  });

  // ── The last-changed date moves only with the value ──────────────────────

  it("leaves a code's last-changed date alone when the same code is saved again", async () => {
    actAs(ADMIN);
    await put("/api/properties/prop-west/facts", { ...SAME_AS_EXISTING, rubbishDay: "Wednesday" });

    expect(written().doorCodeUpdatedAt).toEqual(LAST_YEAR);
    expect(written().alarmCodeUpdatedAt).toEqual(LAST_YEAR);
    expect(written().gateCodeUpdatedAt).toBeNull();
  });

  it("stamps the last-changed date from the server when the code changes", async () => {
    actAs(ADMIN);
    const before = Date.now();
    await put("/api/properties/prop-west/facts", {
      ...SAME_AS_EXISTING,
      doorCode: "5555",
      // A client-supplied date is ignored outright, not merely overridden.
      doorCodeUpdatedAt: "2001-01-01T00:00:00.000Z",
    });

    const stamped = written().doorCodeUpdatedAt as Date;
    expect(stamped.getTime()).toBeGreaterThanOrEqual(before);
    // The other codes did not change, so their dates did not either.
    expect(written().alarmCodeUpdatedAt).toEqual(LAST_YEAR);
  });

  it("stamps a code set for the first time on a house with no facts yet", async () => {
    actAs(ADMIN);
    const before = Date.now();
    await put("/api/properties/prop-east/facts", { ...SAME_AS_EXISTING, doorCode: "2468", alarmCode: null });

    expect((written().doorCodeUpdatedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
    expect(written().alarmCodeUpdatedAt).toBeNull();
    expect(storageMock.createAuditEvent).toHaveBeenCalledTimes(1);
    expect(storageMock.createAuditEvent.mock.calls[0][0].summary).toContain("Toledo House");
  });
});

describe("liability paperwork", () => {
  const WEST_RESIDENT = { id: "res-a", firstName: "Alice", lastName: "Ng", propertyId: "prop-west", region: "West Central", buildingAddress: "1 Main St", isActive: true };
  const EAST_RESIDENT = { id: "res-e", firstName: "Eve", lastName: "Ito", propertyId: "prop-east", region: "East Central", buildingAddress: "9 Elm", isActive: true };

  const westLead = (permissions: Record<string, unknown> = { canManageProperties: true }) =>
    actAs(STAFF, { ...permissions, allowedRegions: ["West Central"] });

  beforeEach(() => {
    storageMock.getResident.mockImplementation(async (id: string) =>
      id === "res-a" ? WEST_RESIDENT : id === "res-e" ? EAST_RESIDENT : undefined,
    );
    storageMock.getAllResidentDocuments.mockResolvedValue([]);
    storageMock.setResidentDocument.mockImplementation(async (residentId, documentKey, patch) => ({
      id: "doc-1", residentId, documentKey, ...patch,
    }));
  });

  const setDoc = (residentId: string, key: string, body: unknown) =>
    request("PUT", `/api/residents/${residentId}/documents/${key}`, { body });

  it("refuses a resident, without writing", async () => {
    // Paperwork status is staff-recorded. A resident marking their own waiver
    // signed would be the record certifying itself.
    actAs(ALICE, { canCompleteWalkthroughs: true });
    const { status } = await setDoc("res-a", "liability_waiver", { signedOn: "2026-08-01" });
    expect(status).toBe(403);
    expect(storageMock.setResidentDocument).not.toHaveBeenCalled();
  });

  it("refuses a resident in another region, without writing", async () => {
    westLead();
    const { status } = await setDoc("res-e", "liability_waiver", { signedOn: "2026-08-01" });
    expect(status).toBe(403);
    expect(storageMock.setResidentDocument).not.toHaveBeenCalled();
  });

  it("refuses a document key SPO does not ask for", async () => {
    westLead();
    const { status } = await setDoc("res-a", "blood_oath", { signedOn: "2026-08-01" });
    expect(status).toBe(400);
    expect(storageMock.setResidentDocument).not.toHaveBeenCalled();
  });

  it("records who said so and when, from the session", async () => {
    westLead();
    const { status } = await setDoc("res-a", "liability_waiver", {
      signedOn: "2026-08-01",
      recordedByEmail: "someone@else.com",
    });
    expect(status).toBe(200);
    const [, , patch] = storageMock.setResidentDocument.mock.calls[0];
    expect(patch.recordedByUserId).toBe(STAFF.id);
    expect(patch.recordedByEmail).toBe(STAFF.email);
    expect(patch.region).toBe("West Central");
  });

  it("records an audit event naming the resident and the document", async () => {
    // That row is what gets cited in a dispute, and without an event the only
    // record of who set it is the row it overwrites.
    westLead();
    await setDoc("res-a", "liability_waiver", { signedOn: "2026-08-01" });
    expect(storageMock.createAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "resident.document_recorded",
        entityType: "resident",
        entityId: "res-a",
        summary: expect.stringContaining("Alice"),
      }),
    );
  });

  it("can record that something is not signed, by clearing the date", async () => {
    // Correcting a mistake has to be possible; the row existing is not itself
    // evidence, only a date is.
    westLead();
    const { status } = await setDoc("res-a", "liability_waiver", { signedOn: null });
    expect(status).toBe(200);
    const [, , patch] = storageMock.setResidentDocument.mock.calls[0];
    expect(patch.signedOn).toBeNull();
  });
});

describe("reading paperwork across a region", () => {
  beforeEach(() => {
    storageMock.getAllResidentDocuments.mockResolvedValue([
      { id: "d-west", residentId: "res-a", documentKey: "liability_waiver", region: "West Central" },
      { id: "d-east", residentId: "res-e", documentKey: "liability_waiver", region: "East Central" },
    ]);
  });

  it("refuses an anonymous caller", async () => {
    expect((await get("/api/resident-documents")).status).toBe(401);
  });

  it("refuses a resident, without reading it", async () => {
    // Somebody's signed waiver is not theirs to browse, and certainly not
    // their housemates'.
    actAs(ALICE, { canCompleteWalkthroughs: true });
    expect((await get("/api/resident-documents")).status).toBe(403);
    expect(storageMock.getAllResidentDocuments).not.toHaveBeenCalled();
  });

  it("refuses staff holding no property permission", async () => {
    actAs(STAFF, { canViewMaintenance: true, allowedRegions: ["West Central"] });
    expect((await get("/api/resident-documents")).status).toBe(403);
  });

  it("gives a regional lead their own regions' rows only", async () => {
    actAs(STAFF, { canViewProperties: true, allowedRegions: ["West Central"] });
    const { status, body } = await get("/api/resident-documents");
    expect(status).toBe(200);
    expect(body.map((row: { id: string }) => row.id)).toEqual(["d-west"]);
  });
});

describe("the maintenance rollups", () => {
  beforeEach(() => {
    storageMock.getAllMaintenanceRequests.mockResolvedValue([
      { id: "req-west", location: "Kitchen", category: "Plumbing", buildingAddress: "1 Main St", region: "West Central", status: "completed", type: "request" },
      { id: "req-west-2", location: "Kitchen", category: "Plumbing", buildingAddress: "1 Main St", region: "West Central", status: "completed", type: "request" },
      { id: "req-east", location: "Kitchen", category: "Plumbing", buildingAddress: "9 Elm", region: "East Central", status: "completed", type: "request" },
      { id: "req-east-2", location: "Kitchen", category: "Plumbing", buildingAddress: "9 Elm", region: "East Central", status: "completed", type: "request" },
    ]);
    storageMock.getAllRequestContactLinks.mockResolvedValue([
      { contactId: "c1", requestId: "req-west" },
      { contactId: "c2", requestId: "req-east" },
    ]);
  });

  it("refuses an anonymous caller", async () => {
    expect((await get("/api/maintenance-aggregates")).status).toBe(401);
  });

  it("refuses a resident, without reading anything", async () => {
    actAs(ALICE, { canCompleteWalkthroughs: true });
    expect((await get("/api/maintenance-aggregates")).status).toBe(403);
    expect(storageMock.getAllMaintenanceRequests).not.toHaveBeenCalled();
  });

  it("refuses staff holding no maintenance permission", async () => {
    actAs(STAFF, { canViewProperties: true, allowedRegions: ["West Central"] });
    expect((await get("/api/maintenance-aggregates")).status).toBe(403);
  });

  it("rolls up only the caller's own regions", async () => {
    // A rollup must never widen what somebody can see -- the East Central
    // house repeats too, and must not appear.
    actAs(STAFF, { canViewMaintenance: true, allowedRegions: ["West Central"] });
    const { status, body } = await get("/api/maintenance-aggregates");
    expect(status).toBe(200);
    expect(body.recurringIssues).toHaveLength(1);
    expect(body.recurringIssues[0].buildingAddress).toBe("1 Main St");
  });

  it("drops a contractor link whose request the caller cannot see", async () => {
    actAs(STAFF, { canViewMaintenance: true, allowedRegions: ["West Central"] });
    const { body } = await get("/api/maintenance-aggregates");
    expect(body.contractorLoad.map((row: { contactId: string }) => row.contactId)).toEqual(["c1"]);
  });
});

describe("startup budgets", () => {
  const WEST = { id: "prop-west", name: "Cleveland House", region: "West Central", address: "1 Main St" };
  const EAST = { id: "prop-east", name: "Como House", region: "East Central", address: "9 Elm" };

  beforeEach(() => {
    storageMock.getProperty.mockImplementation(async (id: string) =>
      id === "prop-west" ? WEST : id === "prop-east" ? EAST : undefined,
    );
    storageMock.getAllPropertyBudgets.mockResolvedValue([
      { id: "b-west", propertyId: "prop-west", year: 2026, amount: "2500.00", region: "West Central" },
      { id: "b-east", propertyId: "prop-east", year: 2026, amount: "3000.00", region: "East Central" },
    ]);
    storageMock.upsertPropertyBudget.mockImplementation(async (budget) => ({ id: "b-new", ...budget }));
  });

  it("gives a household leader their own house's figure and nobody else's", async () => {
    // A startup budget is an OPERATING figure, not deposit or rent data, so a
    // leader may see their own -- and only their own.
    actAs({ ...ALICE, propertyId: "prop-west" } as typeof ALICE, { canViewResourceHub: true });
    const { status, body } = await get("/api/property-budgets");
    expect(status).toBe(200);
    expect(body.map((b: { id: string }) => b.id)).toEqual(["b-west"]);
  });

  it("gives a resident with no linked house nothing", async () => {
    actAs(ALICE, { canViewResourceHub: true });
    expect((await get("/api/property-budgets")).body).toEqual([]);
  });

  it("refuses a resident who has not been granted the hub, without reading", async () => {
    actAs({ ...ALICE, propertyId: "prop-west" } as typeof ALICE, { canCompleteWalkthroughs: true });
    expect((await get("/api/property-budgets")).status).toBe(403);
    expect(storageMock.getAllPropertyBudgets).not.toHaveBeenCalled();
  });

  it("gives a regional lead their regions' figures", async () => {
    actAs(STAFF, { canViewProperties: true, allowedRegions: ["West Central"] });
    const { body } = await get("/api/property-budgets");
    expect(body.map((b: { id: string }) => b.id)).toEqual(["b-west"]);
  });

  it("refuses a staff account holding no property permission, without reading", async () => {
    actAs(STAFF, { canViewMaintenance: true, allowedRegions: ["West Central"] });
    expect((await get("/api/property-budgets")).status).toBe(403);
    expect(storageMock.getAllPropertyBudgets).not.toHaveBeenCalled();
  });

  it("refuses a resident the write route, even one granted the hub", async () => {
    actAs({ ...ALICE, propertyId: "prop-west" } as typeof ALICE, { canViewResourceHub: true });
    const { status } = await request("PUT", "/api/properties/prop-west/budget", {
      body: { year: 2026, amount: 2500 },
    });
    expect(status).toBe(403);
    expect(storageMock.upsertPropertyBudget).not.toHaveBeenCalled();
  });

  it("refuses a house in another region, without writing", async () => {
    actAs(STAFF, { canManageProperties: true, allowedRegions: ["West Central"] });
    const { status } = await request("PUT", "/api/properties/prop-east/budget", {
      body: { year: 2026, amount: 3000 },
    });
    expect(status).toBe(403);
    expect(storageMock.upsertPropertyBudget).not.toHaveBeenCalled();
  });

  it("records an audit event for a budget, naming the house and the amount", async () => {
    actAs(STAFF, { canManageProperties: true, allowedRegions: ["West Central"] });
    await request("PUT", "/api/properties/prop-west/budget", { body: { year: 2026, amount: 2500 } });
    expect(storageMock.createAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "property.budget_set",
        entityType: "property",
        entityId: "prop-west",
        summary: expect.stringContaining("Cleveland House"),
      }),
    );
  });

  it("takes the region from the house, never the body", async () => {
    actAs(STAFF, { canManageProperties: true, allowedRegions: ["West Central"] });
    const { status } = await request("PUT", "/api/properties/prop-west/budget", {
      body: { year: 2026, amount: 2500, region: "East Central" },
    });
    expect(status).toBe(200);
    const [budget] = storageMock.upsertPropertyBudget.mock.calls[0];
    expect(budget.region).toBe("West Central");
    expect(budget.propertyId).toBe("prop-west");
  });
});

describe("repair & maintenance budgets", () => {
  const WEST = { id: "prop-west", name: "Cleveland House", region: "West Central", address: "1 Main St", ownership: "owned" };
  const EAST = { id: "prop-east", name: "Como House", region: "East Central", address: "9 Elm", ownership: "owned" };
  const RENTED = { id: "prop-rented", name: "Rented House", region: "West Central", address: "5 Oak", ownership: "rented" };

  beforeEach(() => {
    storageMock.getProperty.mockImplementation(async (id: string) =>
      ({ "prop-west": WEST, "prop-east": EAST, "prop-rented": RENTED })[id],
    );
    storageMock.getAllRepairBudgets.mockResolvedValue([
      { id: "rb-west", propertyId: "prop-west", fiscalYear: 2027, amount: "10500.00", region: "West Central" },
      { id: "rb-east", propertyId: "prop-east", fiscalYear: 2027, amount: "11000.00", region: "East Central" },
    ]);
    storageMock.getRepairBudget.mockResolvedValue(undefined);
    storageMock.upsertRepairBudget.mockImplementation(async (budget) => ({ id: "rb-new", ...budget, amount: String(budget.amount) }));
  });

  it("refuses a resident the list outright, even one holding every grant, without reading", async () => {
    // Unlike the startup budget, this figure is never the household's.
    actAs({ ...ALICE, propertyId: "prop-west" } as typeof ALICE, {
      canViewResourceHub: true,
      canViewProperties: true,
      canManageProperties: true,
    });
    expect((await get("/api/repair-budgets")).status).toBe(403);
    expect(storageMock.getAllRepairBudgets).not.toHaveBeenCalled();
  });

  it("gives a regional lead their regions' figures only", async () => {
    actAs(STAFF, { canViewProperties: true, allowedRegions: ["West Central"] });
    const { status, body } = await get("/api/repair-budgets");
    expect(status).toBe(200);
    expect(body.map((b: { id: string }) => b.id)).toEqual(["rb-west"]);
  });

  it("refuses staff without a property permission, without reading", async () => {
    actAs(STAFF, { canViewMaintenance: true, allowedRegions: ["West Central"] });
    expect((await get("/api/repair-budgets")).status).toBe(403);
    expect(storageMock.getAllRepairBudgets).not.toHaveBeenCalled();
  });

  it("refuses a regional lead the write, even with every property and finance grant, without writing", async () => {
    actAs(STAFF, {
      canManageProperties: true,
      canManagePropertySetup: true,
      canManageFinancials: true,
      allowedRegions: ["West Central"],
    });
    const { status } = await request("PUT", "/api/properties/prop-west/repair-budget", {
      body: { fiscalYear: 2027, amount: 10500 },
    });
    expect(status).toBe(403);
    expect(storageMock.upsertRepairBudget).not.toHaveBeenCalled();
    expect(storageMock.getProperty).not.toHaveBeenCalled();
  });

  it("lets an admin set a budget, taking region and house from the property, never the body", async () => {
    actAs(ADMIN);
    const { status } = await request("PUT", "/api/properties/prop-west/repair-budget", {
      body: { fiscalYear: 2027, amount: 10500, region: "East Central", propertyId: "prop-east" },
    });
    expect(status).toBe(200);
    const [budget] = storageMock.upsertRepairBudget.mock.calls[0];
    expect(budget).toMatchObject({ propertyId: "prop-west", region: "West Central", fiscalYear: 2027 });
  });

  it("refuses a budget for a rented house, without writing", async () => {
    actAs(ADMIN);
    const { status, body } = await request("PUT", "/api/properties/prop-rented/repair-budget", {
      body: { fiscalYear: 2027, amount: 5000 },
    });
    expect(status).toBe(400);
    expect(body.message).toMatch(/owns/);
    expect(storageMock.upsertRepairBudget).not.toHaveBeenCalled();
  });

  it("audits a change as money, with the figure it replaced", async () => {
    actAs(ADMIN);
    storageMock.getRepairBudget.mockResolvedValue({ id: "rb-west", propertyId: "prop-west", fiscalYear: 2027, amount: "10000.00" });
    await request("PUT", "/api/properties/prop-west/repair-budget", { body: { fiscalYear: 2027, amount: 10500 } });
    expect(storageMock.createAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "property.repair_budget_set",
        entityId: "prop-west",
        summary: "Changed the FY2027 repair budget for Cleveland House from 10000.00 to 10500",
      }),
    );
  });
});

describe("QuickBooks", () => {
  const TOKEN_KEY_HEX = "ab".repeat(32);
  const TOKEN_KEY = Buffer.from(TOKEN_KEY_HEX, "hex");
  const QB_ENV = {
    QUICKBOOKS_CLIENT_ID: "client-id",
    QUICKBOOKS_CLIENT_SECRET: "client-secret",
    QUICKBOOKS_REDIRECT_URI: "https://portal.example.org/api/quickbooks/callback",
    QUICKBOOKS_TOKEN_KEY: TOKEN_KEY_HEX,
  };
  const savedEnv: Record<string, string | undefined> = {};
  const WEST = { id: "prop-west", name: "Cleveland House", region: "West Central", address: "1 Main St", ownership: "owned" };
  const EAST = { id: "prop-east", name: "Como House", region: "East Central", address: "9 Elm", ownership: "owned" };
  const RENTED = { id: "prop-rented", name: "Rented House", region: "West Central", address: "5 Oak", ownership: "rented" };

  /** Every write a refused QuickBooks request must never make. */
  const QB_WRITES = ["updateQuickbooksIntegration", "setPropertyQuickbooksLink", "deletePropertyQuickbooksLink", "upsertPropertySpend"];

  beforeAll(() => {
    for (const [name, value] of Object.entries(QB_ENV)) {
      savedEnv[name] = process.env[name];
      process.env[name] = value;
    }
  });
  afterAll(() => {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  beforeEach(() => {
    storageMock.getProperty.mockImplementation(async (id: string) =>
      ({ "prop-west": WEST, "prop-east": EAST, "prop-rented": RENTED })[id],
    );
    storageMock.getQuickbooksIntegration.mockResolvedValue({
      id: "default",
      realmId: "9130",
      companyName: "SPO Inc",
      encryptedRefreshToken: encryptToken("refresh-old", TOKEN_KEY),
      repairAccountIds: ["57"],
      connectedAt: new Date("2026-09-01T00:00:00Z"),
    });
    storageMock.updateQuickbooksIntegration.mockImplementation(async (patch) => patch);
    storageMock.getAllPropertyQuickbooksLinks.mockResolvedValue([
      { propertyId: "prop-west", kind: "class", externalId: "101", externalName: "Cleveland", region: "West Central" },
      { propertyId: "prop-east", kind: "class", externalId: "102", externalName: "Como", region: "East Central" },
    ]);
    storageMock.setPropertyQuickbooksLink.mockImplementation(async (link) => link);
    storageMock.getAllPropertySpend.mockResolvedValue([
      { id: "s-west", propertyId: "prop-west", fiscalYear: 2027, amount: "500.00", region: "West Central", syncedAt: new Date() },
      { id: "s-east", propertyId: "prop-east", fiscalYear: 2027, amount: "900.00", region: "East Central", syncedAt: new Date() },
    ]);
    qbApi.refresh.mockResolvedValue({ accessToken: "access-1", refreshToken: "refresh-new", refreshTokenExpiresAt: null });
    qbApi.listClasses.mockResolvedValue([{ id: "101", name: "Cleveland" }, { id: "102", name: "Como" }]);
    qbApi.listExpenseAccounts.mockResolvedValue([{ id: "57", name: "Repairs", type: "Expense" }]);
    qbApi.authorizeUrl.mockImplementation((state: string) => `https://appcenter.intuit.com/connect/oauth2?state=${state}`);
    qbApi.exchangeCode.mockResolvedValue({ accessToken: "access-1", refreshToken: "refresh-first", refreshTokenExpiresAt: null });
    qbApi.companyName.mockResolvedValue("SPO Inc");
  });

  const ADMIN_ROUTES: [string, string, unknown?][] = [
    ["GET", "/api/quickbooks/status"],
    ["POST", "/api/quickbooks/connect"],
    ["GET", "/api/quickbooks/callback?code=c&realmId=9130&state=s"],
    ["POST", "/api/quickbooks/disconnect"],
    ["GET", "/api/quickbooks/accounts"],
    ["PUT", "/api/quickbooks/accounts", { accountIds: ["57"] }],
    ["GET", "/api/quickbooks/classes"],
    ["GET", "/api/quickbooks/links"],
    ["PUT", "/api/properties/prop-west/quickbooks-link", { classId: "101" }],
    ["DELETE", "/api/properties/prop-west/quickbooks-link"],
    ["POST", "/api/quickbooks/sync"],
  ];

  it.each(ADMIN_ROUTES)(
    "refuses %s %s to a regional lead holding every grant, before any QuickBooks call or write",
    async (method, path, body) => {
      actAs(STAFF, {
        canViewProperties: true,
        canManageProperties: true,
        canManageFinancials: true,
        canManageUsers: true,
        allowedRegions: ["all"],
      });
      const { status } = await request(method, path, { body });
      expect(status).toBe(403);
      for (const fn of Object.values(qbApi)) expect(fn).not.toHaveBeenCalled();
      for (const write of QB_WRITES) expect(storageMock[write]).not.toHaveBeenCalled();
    },
  );

  it("gives an admin the live class list, storing the rotated refresh token encrypted (positive control)", async () => {
    actAs(ADMIN);
    const { status, body } = await get("/api/quickbooks/classes");
    expect(status).toBe(200);
    expect(body).toHaveLength(2);
    expect(qbApi.refresh).toHaveBeenCalledWith("refresh-old");
    const [patch] = storageMock.updateQuickbooksIntegration.mock.calls[0];
    expect(patch.encryptedRefreshToken).not.toContain("refresh-new");
    expect(decryptToken(patch.encryptedRefreshToken, TOKEN_KEY)).toBe("refresh-new");
  });

  it("never sends the stored token to the browser, encrypted or not", async () => {
    actAs(ADMIN);
    const { status, body } = await get("/api/quickbooks/status");
    expect(status).toBe(200);
    expect(body.companyName).toBe("SPO Inc");
    expect(JSON.stringify(body)).not.toMatch(/refresh|v1:/i);
  });

  it("connects only when Intuit returns the state this admin's session was given, once", async () => {
    actAs(ADMIN);
    await request("POST", "/api/quickbooks/connect");
    const [state] = qbApi.authorizeUrl.mock.calls[0];

    const ok = await get(`/api/quickbooks/callback?code=c&realmId=9130&state=${state}`);
    expect(ok.status).toBe(302);
    expect(ok.headers.get("location")).toBe("/settings?quickbooks=connected#quickbooks");
    const stored = storageMock.updateQuickbooksIntegration.mock.calls.at(-1)![0];
    expect(stored.realmId).toBe("9130");
    expect(decryptToken(stored.encryptedRefreshToken, TOKEN_KEY)).toBe("refresh-first");
    expect(storageMock.createAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: "quickbooks.connected" }));

    // The same state a second time is refused: it was used up.
    qbApi.exchangeCode.mockClear();
    const replay = await get(`/api/quickbooks/callback?code=c&realmId=9130&state=${state}`);
    expect(replay.headers.get("location")).toBe("/settings?quickbooks=failed#quickbooks");
    expect(qbApi.exchangeCode).not.toHaveBeenCalled();
  });

  it("refuses a callback whose state this session never issued, without exchanging the code", async () => {
    actAs(ADMIN);
    await request("POST", "/api/quickbooks/connect");
    const { status, headers } = await get("/api/quickbooks/callback?code=c&realmId=9130&state=someone-elses");
    expect(status).toBe(302);
    expect(headers.get("location")).toBe("/settings?quickbooks=failed#quickbooks");
    expect(qbApi.exchangeCode).not.toHaveBeenCalled();
    expect(storageMock.updateQuickbooksIntegration).not.toHaveBeenCalled();
  });

  it("clears the house links and accounts when a different company is connected", async () => {
    actAs(ADMIN);
    storageMock.getQuickbooksIntegration.mockResolvedValue({ id: "default", realmId: "1111", repairAccountIds: ["57"] });
    await request("POST", "/api/quickbooks/connect");
    const [state] = qbApi.authorizeUrl.mock.calls[0];
    await get(`/api/quickbooks/callback?code=c&realmId=9130&state=${state}`);
    expect(storageMock.deletePropertyQuickbooksLink).toHaveBeenCalledTimes(2);
    expect(storageMock.updateQuickbooksIntegration.mock.calls.at(-1)![0].repairAccountIds).toEqual([]);
  });

  it("links a house under QuickBooks's own name for the class, never the caller's", async () => {
    actAs(ADMIN);
    const { status } = await request("PUT", "/api/properties/prop-west/quickbooks-link", {
      body: { classId: "101", externalName: "Made up", region: "East Central" },
    });
    expect(status).toBe(200);
    expect(storageMock.setPropertyQuickbooksLink).toHaveBeenCalledWith({
      propertyId: "prop-west",
      kind: "class",
      externalId: "101",
      externalName: "Cleveland",
      region: "West Central",
    });
  });

  it("refuses a class QuickBooks does not have, and a rented house, without linking", async () => {
    actAs(ADMIN);
    expect((await request("PUT", "/api/properties/prop-west/quickbooks-link", { body: { classId: "999" } })).status).toBe(400);
    expect((await request("PUT", "/api/properties/prop-rented/quickbooks-link", { body: { classId: "101" } })).status).toBe(400);
    expect(storageMock.setPropertyQuickbooksLink).not.toHaveBeenCalled();
  });

  it("audits the repair-account choice as a money decision", async () => {
    actAs(ADMIN);
    const { status } = await request("PUT", "/api/quickbooks/accounts", { body: { accountIds: ["57", "58", "57"] } });
    expect(status).toBe(200);
    expect(storageMock.updateQuickbooksIntegration).toHaveBeenCalledWith({ repairAccountIds: ["57", "58"] });
    expect(storageMock.createAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: "quickbooks.accounts_changed" }));
  });

  it("raises a lost connection for an admin only, and reads the connection for nobody without a use for it", async () => {
    for (const name of ["getAllMaintenanceSchedules", "getAllRentPayments", "getAllSecurityDeposits", "getAllDepositDeductions", "getAllResidents", "getAllTasks", "getAllProperties", "getAllPropertySetupItems", "getAllAssets"]) {
      storageMock[name].mockResolvedValue([]);
    }
    storageMock.getQuickbooksIntegration.mockResolvedValue({
      id: "default",
      realmId: "9130",
      encryptedRefreshToken: null,
      connectedAt: new Date("2026-09-01T00:00:00Z"),
      repairAccountIds: [],
    });

    // No property flag: no budget to judge, so the connection is not read.
    actAs(STAFF, { canViewMaintenance: true, canViewFinancials: true, canViewAssets: true, allowedRegions: ["all"] });
    const staff = await get("/api/action-items");
    expect(staff.status).toBe(200);
    expect(staff.body.some((i: { source: string }) => i.source === "integration")).toBe(false);
    expect(storageMock.getQuickbooksIntegration).not.toHaveBeenCalled();

    // The property flag reads it, to know whether spend is current -- and
    // still never sees the admin's item.
    actAs(STAFF, { canViewProperties: true, allowedRegions: ["all"] });
    const withBudgets = await get("/api/action-items");
    expect(withBudgets.body.some((i: { source: string }) => i.source === "integration")).toBe(false);

    actAs(ADMIN);
    const admin = await get("/api/action-items");
    expect(admin.body.find((i: { source: string }) => i.source === "integration")?.title).toBe("QuickBooks connection lost");
  });

  it("gives a regional lead their regions' spend and links only", async () => {
    actAs(STAFF, { canViewProperties: true, allowedRegions: ["West Central"] });
    const { status, body } = await get("/api/property-spend");
    expect(status).toBe(200);
    expect(body.spend.map((s: { id: string }) => s.id)).toEqual(["s-west"]);
    expect(body.linkedPropertyIds).toEqual(["prop-west"]);
  });

  it("refuses the spend to a resident with every grant, and to staff without a property grant, without reading", async () => {
    actAs({ ...ALICE, propertyId: "prop-west" } as typeof ALICE, { canViewProperties: true, canViewResourceHub: true });
    expect((await get("/api/property-spend")).status).toBe(403);
    actAs(STAFF, { canViewMaintenance: true, allowedRegions: ["West Central"] });
    expect((await get("/api/property-spend")).status).toBe(403);
    expect(storageMock.getAllPropertySpend).not.toHaveBeenCalled();
  });
});

describe("resident roster sync", () => {
  const SHEET_ENV = {
    GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: "sync@spo.iam.gserviceaccount.com", private_key: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n" }),
    RESIDENT_SHEET_ID: "1AbCdEfGhIjKlMnOpQrStUvWxYz",
    RESIDENT_SHEET_TAB: "Residents",
  };
  const savedEnv: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const [name, value] of Object.entries(SHEET_ENV)) {
      savedEnv[name] = process.env[name];
      process.env[name] = value;
    }
  });
  afterAll(() => {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  beforeEach(() => {
    storageMock.getRecentRosterSyncRuns.mockResolvedValue([]);
    storageMock.getLastSuccessfulRosterSyncRun.mockResolvedValue(undefined);
    storageMock.getRosterReviewItems.mockResolvedValue([]);
    storageMock.getAllResidents.mockResolvedValue([]);
    storageMock.getAllProperties.mockResolvedValue([
      { id: "prop-como", name: "Como Men's House", address: "981 Como Ave", region: "Northwest", ownership: "owned" },
    ]);
    storageMock.getAllResidentSheetLinks.mockResolvedValue([]);
    storageMock.createRosterSyncRun.mockImplementation(async (run) => ({ id: "run-1", createdAt: new Date(), ...run }));
    storageMock.applyRosterPlan.mockResolvedValue([]);
  });

  const csv = (text: string) => {
    const form = new FormData();
    form.append("file", new Blob([text], { type: "text/csv" }), "roster.csv");
    return form;
  };
  const postCsv = async (dryRun: boolean, text: string) => {
    const res = await fetch(`${baseUrl}/api/roster-sync/csv?dryRun=${dryRun}`, { method: "POST", body: csv(text) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const GOOD_CSV = "Full Name,Email,House\nSam O'Connor,sam@example.org,981 Como Ave\n";

  it.each([
    ["GET", "/api/roster-sync/status"],
    ["POST", "/api/roster-sync/run", { dryRun: true }],
    ["POST", "/api/roster-review-items/rv-1/reviewed"],
  ] as [string, string, unknown?][])("refuses %s %s to a regional lead holding every grant, without a read or a write", async (method, path, body) => {
    actAs(STAFF, { canManageProperties: true, canManageUsers: true, allowedRegions: ["all"] });
    expect((await request(method, path, { body })).status).toBe(403);
    expect(storageMock.getAllResidents).not.toHaveBeenCalled();
    expect(storageMock.applyRosterPlan).not.toHaveBeenCalled();
    expect(storageMock.markRosterReviewItemReviewed).not.toHaveBeenCalled();
    expect(storageMock.createRosterSyncRun).not.toHaveBeenCalled();
  });

  it("refuses the CSV to a regional lead before the parser reads a byte", async () => {
    actAs(STAFF, { canManageProperties: true, allowedRegions: ["all"] });
    expect((await postCsv(false, GOOD_CSV)).status).toBe(403);
    expect(multerEntered).not.toHaveBeenCalled();
    expect(storageMock.applyRosterPlan).not.toHaveBeenCalled();
  });

  it("previews an admin's CSV without writing, then applies it (positive control)", async () => {
    actAs(ADMIN);
    const preview = await postCsv(true, GOOD_CSV);
    expect(preview.status).toBe(200);
    expect(preview.body.run).toMatchObject({ ok: true, dryRun: true, created: 1 });
    expect(multerEntered).toHaveBeenCalledWith("/api/roster-sync/csv");
    expect(storageMock.applyRosterPlan).not.toHaveBeenCalled();

    const applied = await postCsv(false, GOOD_CSV);
    expect(applied.body.run).toMatchObject({ ok: true, dryRun: false, created: 1 });
    expect(storageMock.applyRosterPlan).toHaveBeenCalledTimes(1);
  });

  it("refuses an admin's CSV with a banking column, writing nothing", async () => {
    actAs(ADMIN);
    const { status, body } = await postCsv(false, "Full Name,Email,House,Bank Routing\nSam O'Connor,sam@example.org,981 Como Ave,123456789\n");
    expect(status).toBe(200);
    expect(body.run).toMatchObject({ ok: false, refusedColumns: ["Bank Routing"] });
    expect(JSON.stringify(body)).not.toContain("123456789");
    expect(storageMock.applyRosterPlan).not.toHaveBeenCalled();
  });

  it("tells an admin which sheet and service account, but never the key", async () => {
    actAs(ADMIN);
    const { status, body } = await get("/api/roster-sync/status");
    expect(status).toBe(200);
    expect(body.sheet).toEqual({ tab: "Residents", serviceAccountEmail: "sync@spo.iam.gserviceaccount.com" });
    expect(JSON.stringify(body)).not.toContain("PRIVATE KEY");
  });

  it("marks a resident edit as a person's, so the sync can tell it from its own", async () => {
    actAs(STAFF, { canManageProperties: true, allowedRegions: ["Northwest"] });
    storageMock.getResident.mockResolvedValue({ id: "r-1", region: "Northwest" });
    storageMock.updateResident.mockResolvedValue({ id: "r-1" });
    const { status } = await request("PATCH", "/api/residents/r-1", { body: { notes: "Quiet" } });
    expect(status).toBe(200);
    expect(storageMock.updateResident).toHaveBeenCalledWith("r-1", expect.anything(), { by: STAFF.email, at: expect.any(Date) });
  });
});

describe("move-out checklist and state deposit deadlines", () => {
  const RESIDENT = { id: "r-1", firstName: "Rachel", lastName: "Bauer", region: "Northwest", buildingAddress: "981 Como Ave", email: "rachel@example.org" };
  const TICKED = { roomInspected: true, belongingsRemoved: true, keysReturned: true, damageNotes: "Two holes by the desk", notes: null };

  beforeEach(() => {
    storageMock.getResident.mockResolvedValue(RESIDENT);
    storageMock.getMoveOutChecklist.mockResolvedValue(undefined);
    storageMock.getMoveOutPhotos.mockResolvedValue([]);
    storageMock.upsertMoveOutChecklist.mockImplementation(async (row) => row);
    storageMock.createMoveOutPhoto.mockImplementation(async (row) => ({ id: "mo-1", ...row }));
    storageMock.getAllDepositReturnRules.mockResolvedValue([]);
  });

  it("refuses the checklist to a resident -- even the one moving out -- and to staff without the property flag, without reading", async () => {
    actAs({ ...ALICE, email: RESIDENT.email } as typeof ALICE, { canViewProperties: true, canManageProperties: true });
    expect((await get("/api/residents/r-1/move-out-checklist")).status).toBe(403);
    actAs(STAFF, { canViewMaintenance: true, allowedRegions: ["Northwest"] });
    expect((await get("/api/residents/r-1/move-out-checklist")).status).toBe(403);
    expect(storageMock.getMoveOutChecklist).not.toHaveBeenCalled();
  });

  it("refuses another region's resident, writing nothing", async () => {
    actAs(STAFF, { canManageProperties: true, allowedRegions: ["Southwest"] });
    const { status } = await request("PUT", "/api/residents/r-1/move-out-checklist", { body: { ...TICKED, complete: true } });
    expect(status).toBe(403);
    expect(storageMock.upsertMoveOutChecklist).not.toHaveBeenCalled();
  });

  it("refuses to mark it complete until all three checks are ticked", async () => {
    actAs(STAFF, { canManageProperties: true, allowedRegions: ["Northwest"] });
    const { status } = await request("PUT", "/api/residents/r-1/move-out-checklist", { body: { ...TICKED, keysReturned: false, complete: true } });
    expect(status).toBe(400);
    expect(storageMock.upsertMoveOutChecklist).not.toHaveBeenCalled();
  });

  it("records who completed it and when, and audits it (positive control)", async () => {
    actAs(STAFF, { canManageProperties: true, allowedRegions: ["Northwest"] });
    const { status } = await request("PUT", "/api/residents/r-1/move-out-checklist", { body: { ...TICKED, complete: true, region: "Elsewhere" } });
    expect(status).toBe(200);
    expect(storageMock.upsertMoveOutChecklist).toHaveBeenCalledWith(
      expect.objectContaining({ residentId: "r-1", region: "Northwest", completedByEmail: STAFF.email, completedAt: expect.any(Date) }),
    );
    expect(storageMock.createAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: "resident.move_out_checklist_completed" }));
  });

  it("refuses a photo that is not the caller's own upload, storing nothing", async () => {
    actAs(STAFF, { canManageProperties: true, allowedRegions: ["Northwest"] });
    storageMock.getUploadByStorageKey.mockResolvedValue({ storageKey: "0123456789abcdef0123456789abcdef.jpg", uploadedBy: "someone-else" });
    const { status } = await request("POST", "/api/residents/r-1/move-out-photos", {
      body: { imageUrl: "/uploads/0123456789abcdef0123456789abcdef.jpg" },
    });
    // ownUploadFromClient's answer everywhere: "not one you uploaded".
    expect(status).toBe(400);
    expect(storageMock.createMoveOutPhoto).not.toHaveBeenCalled();
  });

  it("stores the caller's own upload as a photo (positive control)", async () => {
    actAs(STAFF, { canManageProperties: true, allowedRegions: ["Northwest"] });
    storageMock.getUploadByStorageKey.mockResolvedValue({ storageKey: "0123456789abcdef0123456789abcdef.jpg", uploadedBy: STAFF.id });
    const { status } = await request("POST", "/api/residents/r-1/move-out-photos", {
      body: { imageUrl: "/uploads/0123456789abcdef0123456789abcdef.jpg" },
    });
    expect(status).toBe(200);
    expect(storageMock.createMoveOutPhoto).toHaveBeenCalledWith(expect.objectContaining({ residentId: "r-1", region: "Northwest" }));
  });

  it("keeps the state deadlines to admins, writing nothing for anyone else", async () => {
    actAs(STAFF, { canManageFinancials: true, canManageProperties: true, allowedRegions: ["all"] });
    expect((await get("/api/deposit-return-rules")).status).toBe(403);
    expect((await request("PUT", "/api/deposit-return-rules/MN", { body: { days: 21 } })).status).toBe(403);
    expect(storageMock.setDepositReturnRule).not.toHaveBeenCalled();
  });

  it("lets an admin set and clear a state's days, audited with the old value", async () => {
    actAs(ADMIN);
    storageMock.getAllDepositReturnRules.mockResolvedValue([{ state: "MN", days: 14 }]);
    expect((await request("PUT", "/api/deposit-return-rules/mn", { body: { days: 21 } })).status).toBe(200);
    expect(storageMock.setDepositReturnRule).toHaveBeenCalledWith("MN", 21, ADMIN.email);
    expect(storageMock.createAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: "deposit_rule.changed", summary: "Set the MN deposit return deadline to 21 days (was 14)" }),
    );
    expect((await request("PUT", "/api/deposit-return-rules/MN", { body: { days: null } })).status).toBe(200);
    expect(storageMock.setDepositReturnRule).toHaveBeenLastCalledWith("MN", null, ADMIN.email);
    expect((await request("PUT", "/api/deposit-return-rules/MN", { body: { days: 0 } })).status).toBe(400);
  });
});

describe("email health", () => {
  beforeEach(() => {
    storageMock.getEmailLogSince.mockResolvedValue([]);
  });

  it("refuses the panel and the test send to a regional lead holding every grant, sending nothing", async () => {
    actAs(STAFF, { canManageProperties: true, canManageUsers: true, canManageFinancials: true, allowedRegions: ["all"] });
    expect((await get("/api/email-health")).status).toBe(403);
    expect((await request("POST", "/api/email-health/test")).status).toBe(403);
    expect(storageMock.getEmailLogSince).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("sends the test to the admin pressing the button, and to nobody else (positive control)", async () => {
    actAs(ADMIN);
    const { status } = await request("POST", "/api/email-health/test", { body: { to: "someone-else@example.org" } });
    expect(status).toBe(200);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock).toHaveBeenCalledWith(expect.objectContaining({ template: "test", to: ADMIN.email }));
  });
});

describe("emailing a household", () => {
  const WEST = { id: "prop-west", name: "Cleveland House", region: "West Central", address: "1 Main St" };
  const EAST = { id: "prop-east", name: "Como House", region: "East Central", address: "9 Elm" };

  const HOUSE = [
    { id: "r1", firstName: "Alice", lastName: "Ng", email: "alice@example.com", isActive: true },
    { id: "r2", firstName: "Bob", lastName: "Ola", email: "bob@example.com", isActive: true },
    { id: "r3", firstName: "Carol", lastName: "Ek", email: "carol@example.com", isActive: false },
  ];

  const westLead = (permissions: Record<string, unknown> = { canManageProperties: true }) =>
    actAs(STAFF, { ...permissions, allowedRegions: ["West Central"] });

  beforeEach(() => {
    storageMock.getProperty.mockImplementation(async (id: string) =>
      id === "prop-west" ? WEST : id === "prop-east" ? EAST : undefined,
    );
    storageMock.getResidentsByProperty.mockResolvedValue(HOUSE);
  });

  const send = (propertyId: string, body: unknown) =>
    request("POST", `/api/properties/${propertyId}/email`, { body });

  const validEmail = { subject: "Boiler service", body: "The engineer comes Friday at 9am." };

  it("refuses an anonymous caller", async () => {
    expect((await send("prop-west", validEmail)).status).toBe(401);
  });

  it("refuses a resident, without reading the roster", async () => {
    actAs(ALICE, ALL_MAINTENANCE);
    expect((await send("prop-west", validEmail)).status).toBe(403);
    expect(storageMock.getResidentsByProperty).not.toHaveBeenCalled();
  });

  it("refuses a house in another region, without reading its roster", async () => {
    westLead();
    expect((await send("prop-east", validEmail)).status).toBe(403);
    expect(storageMock.getResidentsByProperty).not.toHaveBeenCalled();
  });

  it("refuses an empty subject or body", async () => {
    westLead();
    expect((await send("prop-west", { subject: "  ", body: "x" })).status).toBe(400);
    expect((await send("prop-west", { subject: "x", body: "  " })).status).toBe(400);
  });

  // The positive control.
  it("reports how many people it reached, counting active residents only", async () => {
    // A mail-out to people who moved out last spring is the kind of mistake
    // that gets a tool abandoned. Carol has moved out.
    westLead();
    const { status, body } = await send("prop-west", validEmail);
    expect(status).toBe(200);
    expect(body.recipients).toBe(2);
  });

  it("records the send in the audit trail, with the house and the count", async () => {
    westLead();
    await send("prop-west", validEmail);
    expect(storageMock.createAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "property.household_emailed",
        entityType: "property",
        entityId: "prop-west",
        summary: expect.stringContaining("Cleveland House"),
      }),
    );
    const [event] = storageMock.createAuditEvent.mock.calls[0];
    expect(event.summary).toContain("2");
  });

  it("does not put the message body in the audit summary", async () => {
    // The trail records that a house was emailed and by whom, not the text --
    // a summary is bounded, and a house mail-out can be long.
    westLead();
    await send("prop-west", { subject: "Boiler service", body: "SECRET-BODY-TEXT" });
    const [event] = storageMock.createAuditEvent.mock.calls[0];
    expect(JSON.stringify(event)).not.toContain("SECRET-BODY-TEXT");
  });

  it("succeeds and says nobody was reached when the house is empty", async () => {
    // Email being unconfigured, or a house having nobody on the roster, is a
    // normal state -- not a failure of the request that triggered it.
    westLead();
    storageMock.getResidentsByProperty.mockResolvedValue([]);
    const { status, body } = await send("prop-west", validEmail);
    expect(status).toBe(200);
    expect(body.recipients).toBe(0);
  });
});

describe("the deposit deduction ledger", () => {
  const WEST_PROPERTY = { id: "prop-west", name: "Cleveland House", region: "West Central", address: "1 Main St" };
  const ALICE_RESIDENT = { id: "res-a", firstName: "Alice", lastName: "Ng", propertyId: "prop-west", region: "West Central", buildingAddress: "1 Main St", isActive: true };
  const EAST_RESIDENT = { id: "res-e", firstName: "Eve", lastName: "Ito", propertyId: "prop-east", region: "East Central", buildingAddress: "9 Elm", isActive: true };

  const FINANCE = { canViewFinancials: true, canManageFinancials: true };
  const westLead = (permissions: Record<string, unknown> = FINANCE) =>
    actAs(STAFF, { ...permissions, allowedRegions: ["West Central"] });

  beforeEach(() => {
    storageMock.getResident.mockImplementation(async (id: string) =>
      id === "res-a" ? ALICE_RESIDENT : id === "res-e" ? EAST_RESIDENT : undefined,
    );
    storageMock.getProperty.mockResolvedValue(WEST_PROPERTY);
    storageMock.getResidentsByProperty.mockResolvedValue([ALICE_RESIDENT]);
    storageMock.getAllDepositDeductions.mockResolvedValue([]);
    storageMock.createDepositDeduction.mockImplementation(async (d) => ({ id: "ded-1", ...d }));
    storageMock.createDepositDeductions.mockImplementation(async (rows) =>
      rows.map((row: Record<string, unknown>, index: number) => ({ id: `ded-${index}`, ...row })),
    );
  });

  const deduct = (body: unknown) => request("POST", "/api/deposit-deductions", { body });

  const validDeduction = {
    residentId: "res-a",
    description: "Hole in bedroom wall",
    amount: 75,
    chargeDate: "2026-06-01",
  };

  // ── Residents never see any of this ──────────────────────────────────────

  it("refuses an anonymous caller on every route", async () => {
    expect((await get("/api/deposit-deductions")).status).toBe(401);
    expect((await deduct(validDeduction)).status).toBe(401);
  });

  it("refuses a resident outright, without reading or writing", async () => {
    // Residents never see deposits, deductions, balances or statements. Not
    // household leaders either.
    actAs({ ...ALICE, propertyId: "prop-west" } as typeof ALICE, {
      ...ALL_MAINTENANCE,
      canCompleteWalkthroughs: true,
      canViewFinancials: true,
      canManageFinancials: true,
    });
    expect((await get("/api/deposit-deductions")).status).toBe(403);
    expect((await deduct(validDeduction)).status).toBe(403);
    expect(storageMock.getAllDepositDeductions).not.toHaveBeenCalled();
    expect(storageMock.createDepositDeduction).not.toHaveBeenCalled();
  });

  it("refuses staff without the finance permission, without writing", async () => {
    westLead({ canViewProperties: true });
    expect((await deduct(validDeduction)).status).toBe(403);
    expect(storageMock.createDepositDeduction).not.toHaveBeenCalled();
  });

  it("refuses staff holding only the view finance flag, without writing", async () => {
    westLead({ canViewFinancials: true });
    expect((await deduct(validDeduction)).status).toBe(403);
    expect(storageMock.createDepositDeduction).not.toHaveBeenCalled();
  });

  it("refuses a deduction against a resident in another region, without writing", async () => {
    westLead();
    const { status } = await deduct({ ...validDeduction, residentId: "res-e" });
    expect(status).toBe(403);
    expect(storageMock.createDepositDeduction).not.toHaveBeenCalled();
  });

  // ── Server-owned fields ──────────────────────────────────────────────────

  it("records who entered it, from the session rather than the body", async () => {
    westLead();
    const { status } = await deduct({
      ...validDeduction,
      recordedByUserId: "u-somebody-else",
      recordedByEmail: "someone@else.com",
    });
    expect(status).toBe(200);
    const [row] = storageMock.createDepositDeduction.mock.calls[0];
    expect(row.recordedByUserId).toBe(STAFF.id);
    expect(row.recordedByEmail).toBe(STAFF.email);
  });

  it("takes the region and house from the resident, never from the body", async () => {
    westLead();
    await deduct({ ...validDeduction, region: "East Central", buildingAddress: "somewhere else" });
    const [row] = storageMock.createDepositDeduction.mock.calls[0];
    expect(row.region).toBe("West Central");
    expect(row.buildingAddress).toBe("1 Main St");
  });

  // ── Input validation ─────────────────────────────────────────────────────

  it("refuses a deduction with no description", async () => {
    westLead();
    expect((await deduct({ ...validDeduction, description: "  " })).status).toBe(400);
    expect(storageMock.createDepositDeduction).not.toHaveBeenCalled();
  });

  it("refuses a negative amount", async () => {
    // A negative deduction is a refund, and refunds are not what this is.
    westLead();
    expect((await deduct({ ...validDeduction, amount: -50 })).status).toBe(400);
    expect(storageMock.createDepositDeduction).not.toHaveBeenCalled();
  });

  it("accepts the number a form sends and stores it as the string the column takes", async () => {
    westLead();
    await deduct({ ...validDeduction, amount: 75.5 });
    const [row] = storageMock.createDepositDeduction.mock.calls[0];
    expect(row.amount).toBe("75.5");
  });

  // ── The audit trail ──────────────────────────────────────────────────────

  it("records an audit event naming the resident and the amount", async () => {
    westLead();
    await deduct(validDeduction);
    expect(storageMock.createAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "deposit_deduction.added",
        entityType: "deposit_deduction",
        summary: expect.stringContaining("Alice"),
      }),
    );
    const [event] = storageMock.createAuditEvent.mock.calls[0];
    expect(event.summary).toContain("75");
  });

  it("records one when a deduction is removed", async () => {
    westLead();
    storageMock.getDepositDeduction.mockResolvedValue({
      id: "ded-1", residentId: "res-a", description: "Hole in wall", amount: "75.00", region: "West Central", buildingAddress: "1 Main St",
    });
    const { status } = await request("DELETE", "/api/deposit-deductions/ded-1", {});
    expect(status).toBe(200);
    expect(storageMock.createAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: "deposit_deduction.deleted" }),
    );
  });

  // ── Editing one ──────────────────────────────────────────────────────────

  it("refuses a resident the edit route, without writing", async () => {
    actAs(ALICE, { ...ALL_MAINTENANCE, canManageFinancials: true });
    storageMock.getDepositDeduction.mockResolvedValue({
      id: "ded-1", residentId: "res-a", description: "x", amount: "10.00", region: "West Central",
    });
    const { status } = await request("PATCH", "/api/deposit-deductions/ded-1", { body: { amount: 5 } });
    expect(status).toBe(403);
    expect(storageMock.updateDepositDeduction).not.toHaveBeenCalled();
  });

  it("refuses staff holding only the view finance flag, without writing", async () => {
    westLead({ canViewFinancials: true });
    storageMock.getDepositDeduction.mockResolvedValue({
      id: "ded-1", residentId: "res-a", description: "x", amount: "10.00", region: "West Central",
    });
    const { status } = await request("PATCH", "/api/deposit-deductions/ded-1", { body: { amount: 5 } });
    expect(status).toBe(403);
    expect(storageMock.updateDepositDeduction).not.toHaveBeenCalled();
  });

  it("refuses an edit to one in another region, without writing", async () => {
    westLead();
    storageMock.getDepositDeduction.mockResolvedValue({
      id: "ded-9", residentId: "res-e", description: "x", amount: "10.00", region: "East Central",
    });
    const { status } = await request("PATCH", "/api/deposit-deductions/ded-9", { body: { amount: 5 } });
    expect(status).toBe(403);
    expect(storageMock.updateDepositDeduction).not.toHaveBeenCalled();
  });

  it("refuses to move a deduction onto a different resident", async () => {
    // Moving a charge between people is two acts on two balances, and the
    // trail should say so rather than showing one edit.
    westLead();
    storageMock.getDepositDeduction.mockResolvedValue({
      id: "ded-1", residentId: "res-a", description: "x", amount: "10.00", region: "West Central",
    });
    storageMock.updateDepositDeduction.mockImplementation(async (_id, patch) => ({
      id: "ded-1", residentId: "res-a", description: "x", amount: "10.00", ...patch,
    }));
    await request("PATCH", "/api/deposit-deductions/ded-1", { body: { residentId: "res-e", amount: 5 } });
    const [, patch] = storageMock.updateDepositDeduction.mock.calls[0];
    expect(patch).not.toHaveProperty("residentId");
  });

  // The positive control, and the audit event the spec asks for on an edit.
  it("records an audit event when a deduction is changed", async () => {
    westLead();
    storageMock.getDepositDeduction.mockResolvedValue({
      id: "ded-1", residentId: "res-a", description: "Hole in wall", amount: "75.00", region: "West Central",
    });
    storageMock.updateDepositDeduction.mockImplementation(async (_id, patch) => ({
      id: "ded-1", residentId: "res-a", description: "Hole in wall", amount: "50.00", ...patch,
    }));
    const { status } = await request("PATCH", "/api/deposit-deductions/ded-1", { body: { amount: 50 } });
    expect(status).toBe(200);
    expect(storageMock.updateDepositDeduction).toHaveBeenCalled();
    expect(storageMock.createAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: "deposit_deduction.updated" }),
    );
  });

  it("refuses a resident the delete route, without deleting", async () => {
    actAs(ALICE, { ...ALL_MAINTENANCE, canManageFinancials: true });
    storageMock.getDepositDeduction.mockResolvedValue({
      id: "ded-1", residentId: "res-a", description: "x", amount: "10.00", region: "West Central",
    });
    const { status } = await request("DELETE", "/api/deposit-deductions/ded-1", {});
    expect(status).toBe(403);
    expect(storageMock.deleteDepositDeduction).not.toHaveBeenCalled();
  });

  it("refuses to delete one in another region, without deleting", async () => {
    westLead();
    storageMock.getDepositDeduction.mockResolvedValue({
      id: "ded-9", residentId: "res-e", region: "East Central", amount: "10.00", description: "x",
    });
    const { status } = await request("DELETE", "/api/deposit-deductions/ded-9", {});
    expect(status).toBe(403);
    expect(storageMock.deleteDepositDeduction).not.toHaveBeenCalled();
  });
});

describe("splitting a common-area charge across a house", () => {
  const WEST_PROPERTY = { id: "prop-west", name: "Cleveland House", region: "West Central", address: "1 Main St" };
  const EAST_PROPERTY = { id: "prop-east", name: "Como House", region: "East Central", address: "9 Elm" };

  const HOUSE = ["res-a", "res-b", "res-c"].map((id, index) => ({
    id,
    firstName: `Person${index}`,
    lastName: "X",
    propertyId: "prop-west",
    region: "West Central",
    buildingAddress: "1 Main St",
    isActive: true,
  }));

  const FINANCE = { canViewFinancials: true, canManageFinancials: true };
  const westLead = (permissions: Record<string, unknown> = FINANCE) =>
    actAs(STAFF, { ...permissions, allowedRegions: ["West Central"] });

  beforeEach(() => {
    storageMock.getProperty.mockImplementation(async (id: string) =>
      id === "prop-west" ? WEST_PROPERTY : id === "prop-east" ? EAST_PROPERTY : undefined,
    );
    storageMock.getResidentsByProperty.mockResolvedValue(HOUSE);
    storageMock.createDepositDeductions.mockImplementation(async (rows) =>
      rows.map((row: Record<string, unknown>, index: number) => ({ id: `ded-${index}`, ...row })),
    );
  });

  const split = (body: unknown) => request("POST", "/api/deposit-deductions/split", { body });

  const validSplit = {
    propertyId: "prop-west",
    description: "Hole in the common room wall",
    amount: 100,
    chargeDate: "2026-06-01",
    residentIds: ["res-a", "res-b", "res-c"],
  };

  it("refuses a resident, without writing", async () => {
    actAs(ALICE, { ...ALL_MAINTENANCE, canManageFinancials: true });
    expect((await split(validSplit)).status).toBe(403);
    expect(storageMock.createDepositDeductions).not.toHaveBeenCalled();
  });

  it("refuses a house in another region, without writing", async () => {
    westLead();
    expect((await split({ ...validSplit, propertyId: "prop-east" })).status).toBe(403);
    expect(storageMock.createDepositDeductions).not.toHaveBeenCalled();
  });

  it("refuses a split naming the same person twice, without writing (#163)", async () => {
    // Otherwise they are charged two shares of one charge.
    westLead();
    expect((await split({ ...validSplit, residentIds: ["res-a", "res-b", "res-a"] })).status).toBe(400);
    expect(storageMock.createDepositDeductions).not.toHaveBeenCalled();
  });

  it("stores $100 across 3 as 33.34, 33.33, 33.33 — individual rows, not a divisor", async () => {
    // The important part: a later edit must not silently re-divide somebody's
    // settled balance, which is only true if the shares are stored per person.
    westLead();
    const { status } = await split(validSplit);
    expect(status).toBe(200);

    const [rows] = storageMock.createDepositDeductions.mock.calls[0];
    expect(rows.map((r: { amount: string }) => r.amount)).toEqual(["33.34", "33.33", "33.33"]);
    expect(rows).toHaveLength(3);
  });

  it("gives every row of a split the same group id, for provenance only", async () => {
    westLead();
    await split(validSplit);
    const [rows] = storageMock.createDepositDeductions.mock.calls[0];
    const groups = new Set(rows.map((r: { splitGroupId: string }) => r.splitGroupId));
    expect(groups.size).toBe(1);
    expect([...groups][0]).toBeTruthy();
  });

  it("writes the whole split in one call, so a house is never half-charged", async () => {
    westLead();
    await split(validSplit);
    expect(storageMock.createDepositDeductions).toHaveBeenCalledTimes(1);
    expect(storageMock.createDepositDeduction).not.toHaveBeenCalled();
  });

  it("charges only the people the RA named, not everybody in the house", async () => {
    // The RA can add or remove people before saving; the request is the truth
    // about who is on the hook, not the roster.
    westLead();
    await split({ ...validSplit, residentIds: ["res-a", "res-b"] });
    const [rows] = storageMock.createDepositDeductions.mock.calls[0];
    expect(rows.map((r: { residentId: string }) => r.residentId)).toEqual(["res-a", "res-b"]);
    expect(rows.map((r: { amount: string }) => r.amount)).toEqual(["50.00", "50.00"]);
  });

  it("carries the walkthrough item link onto every row of a split", async () => {
    // A split raised from the move-out worksheet stays traceable to the
    // item that found the damage, on each person's line.
    westLead();
    await split({ ...validSplit, walkthroughItemId: "item-hole" });
    const [rows] = storageMock.createDepositDeductions.mock.calls[0];
    expect(rows.map((r: { walkthroughItemId: string | null }) => r.walkthroughItemId)).toEqual(["item-hole", "item-hole", "item-hole"]);
  });

  it("refuses somebody who does not live in that house", async () => {
    westLead();
    const { status } = await split({ ...validSplit, residentIds: ["res-a", "res-outsider"] });
    expect(status).toBe(400);
    expect(storageMock.createDepositDeductions).not.toHaveBeenCalled();
  });

  it("refuses a split across nobody", async () => {
    westLead();
    expect((await split({ ...validSplit, residentIds: [] })).status).toBe(400);
    expect(storageMock.createDepositDeductions).not.toHaveBeenCalled();
  });

  it("records one audit event per person charged", async () => {
    westLead();
    await split(validSplit);
    const added = storageMock.createAuditEvent.mock.calls.filter(
      ([event]: [{ action: string }]) => event.action === "deposit_deduction.added",
    );
    expect(added).toHaveLength(3);
  });
});

describe("resident finances require the finance permission", () => {
  // Finance moved from role-gated (every staff member) to flag-gated, so the
  // later finance/admin split is a grant rather than a guard rewrite. Staff
  // rows are backfilled with both flags by the migration; these tests pin the
  // gate itself: no flag, no finance data, whatever the role.
  const FIN_RESIDENT = { id: "res-w", propertyId: "prop-west", region: "West Central", buildingAddress: "1 Main St", firstName: "Maria", lastName: "Diaz", isActive: true };

  it("refuses an RA whose row lacks the finance flags, and never reads the data", async () => {
    actAs(STAFF, { canViewProperties: true, canManageProperties: true, allowedRegions: ["all"] });

    expect((await get("/api/rent-payments")).status).toBe(403);
    expect(storageMock.getAllRentPayments).not.toHaveBeenCalled();

    expect((await get("/api/security-deposits")).status).toBe(403);
    expect(storageMock.getAllSecurityDeposits).not.toHaveBeenCalled();
  });

  it("lets a view-only RA read rent but not record it", async () => {
    actAs(STAFF, { canViewFinancials: true, allowedRegions: ["West Central"] });
    storageMock.getAllRentPayments.mockResolvedValue([]);
    storageMock.getResident.mockResolvedValue(FIN_RESIDENT);

    expect((await get("/api/rent-payments")).status).toBe(200);

    const { status } = await request("POST", "/api/rent-payments", {
      body: { residentId: FIN_RESIDENT.id, period: "2026-08", amount: 500 },
    });
    expect(status).toBe(403);
    expect(storageMock.createRentPayment).not.toHaveBeenCalled();
  });

  it("lets an RA with the manage flag record rent", async () => {
    actAs(STAFF, { canViewFinancials: true, canManageFinancials: true, allowedRegions: ["West Central"] });
    storageMock.getResident.mockResolvedValue(FIN_RESIDENT);
    storageMock.createRentPayment.mockImplementation(async (data: Record<string, unknown>) => ({ id: "rp-1", ...data }));

    const { status } = await request("POST", "/api/rent-payments", {
      body: { residentId: FIN_RESIDENT.id, period: "2026-08", amount: 500 },
    });
    expect(status).toBe(200);
    expect(storageMock.createRentPayment).toHaveBeenCalled();
  });

  it("lets an admin with no permissions row through — the admin bypass", async () => {
    actAs(ADMIN);
    storageMock.getAllRentPayments.mockResolvedValue([]);
    storageMock.getAllSecurityDeposits.mockResolvedValue([]);

    expect((await get("/api/rent-payments")).status).toBe(200);
    expect((await get("/api/security-deposits")).status).toBe(200);
  });

  it("applies the manage gate to deposits too", async () => {
    actAs(STAFF, { canViewFinancials: true, allowedRegions: ["West Central"] });
    storageMock.getResident.mockResolvedValue(FIN_RESIDENT);
    storageMock.getSecurityDepositByResident.mockResolvedValue(undefined);

    const { status } = await request("POST", "/api/security-deposits", {
      body: { residentId: FIN_RESIDENT.id, amountHeld: 300 },
    });
    expect(status).toBe(403);
    expect(storageMock.createSecurityDeposit).not.toHaveBeenCalled();
  });
});

describe("linking a resident account to a property", () => {
  it("carries propertyId through account creation", async () => {
    actAs(ADMIN);
    storageMock.upsertUser.mockImplementation(async (data: Record<string, unknown>) => ({ user: { id: "u-new", ...data } }));

    const { status } = await request("POST", "/api/users", {
      body: { email: "steward@example.com", role: "resident", propertyId: "prop-west" },
    });
    expect(status).toBe(200);
    expect(storageMock.upsertUser).toHaveBeenCalledWith(
      expect.objectContaining({ email: "steward@example.com", propertyId: "prop-west" }),
    );
  });

  it("records a re-link, not a new account, when the email already had an account", async () => {
    actAs(ADMIN);
    storageMock.upsertUser.mockImplementation(async (data: Record<string, unknown>) => ({
      user: { id: "u-new", ...data },
      relinkedFrom: { id: "u-old", email: "steward@example.com", role: "regional_administrator" },
    }));

    const { status } = await request("POST", "/api/users", {
      body: { id: "u-new", email: "steward@example.com", role: "resident" },
    });
    expect(status).toBe(200);
    expect(storageMock.createAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "user.relinked",
        entityId: "u-new",
        actorId: ADMIN.id,
        details: expect.objectContaining({ previousUserId: "u-old" }),
      }),
    );
    expect(storageMock.createAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({ action: "user.created" }));
  });

  it("records a new account as created, with no re-link -- the positive control", async () => {
    actAs(ADMIN);
    storageMock.upsertUser.mockImplementation(async (data: Record<string, unknown>) => ({ user: { id: "u-new", ...data } }));

    const { status } = await request("POST", "/api/users", { body: { email: "new@example.com", role: "resident" } });
    expect(status).toBe(200);
    expect(storageMock.createAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: "user.created" }));
    expect(storageMock.createAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({ action: "user.relinked" }));
  });

  it("lets an admin move an existing resident account to a house", async () => {
    actAs(ADMIN);
    storageMock.getUser.mockImplementation(async (id: string) =>
      id === ALICE.id ? ALICE : ADMIN,
    );
    storageMock.getProperty.mockResolvedValue({ id: "prop-west", name: "Como House", region: "West Central" });
    storageMock.updateUserProperty.mockResolvedValue({ ...ALICE, propertyId: "prop-west" });

    const { status } = await request("PATCH", `/api/users/${ALICE.id}/property`, {
      body: { propertyId: "prop-west" },
    });
    expect(status).toBe(200);
    expect(storageMock.updateUserProperty).toHaveBeenCalledWith(ALICE.id, "prop-west");
  });

  it("lets an admin clear the link with null", async () => {
    actAs(ADMIN);
    storageMock.getUser.mockImplementation(async (id: string) =>
      id === ALICE.id ? { ...ALICE, propertyId: "prop-west" } : ADMIN,
    );
    storageMock.updateUserProperty.mockResolvedValue({ ...ALICE, propertyId: null });

    const { status } = await request("PATCH", `/api/users/${ALICE.id}/property`, {
      body: { propertyId: null },
    });
    expect(status).toBe(200);
    expect(storageMock.updateUserProperty).toHaveBeenCalledWith(ALICE.id, null);
  });

  it("refuses a regional administrator, without touching the account", async () => {
    // Changing an account's house changes what that login can see; only
    // admins manage accounts.
    actAs(STAFF, { allowedRegions: ["all"] });

    const { status } = await request("PATCH", `/api/users/${ALICE.id}/property`, {
      body: { propertyId: "prop-west" },
    });
    expect(status).toBe(403);
    expect(storageMock.updateUserProperty).not.toHaveBeenCalled();
  });

  it("refuses a resident, without touching the account", async () => {
    actAs(ALICE);

    const { status } = await request("PATCH", `/api/users/${BOB.id}/property`, {
      body: { propertyId: "prop-west" },
    });
    expect(status).toBe(403);
    expect(storageMock.updateUserProperty).not.toHaveBeenCalled();
  });

  it("refuses a link to a property that does not exist", async () => {
    actAs(ADMIN);
    storageMock.getUser.mockImplementation(async (id: string) =>
      id === ALICE.id ? ALICE : ADMIN,
    );
    storageMock.getProperty.mockResolvedValue(undefined);

    const { status } = await request("PATCH", `/api/users/${ALICE.id}/property`, {
      body: { propertyId: "prop-gone" },
    });
    expect(status).toBe(404);
    expect(storageMock.updateUserProperty).not.toHaveBeenCalled();
  });

  it("refuses to link a staff account to a house", async () => {
    // Only resident logins carry a house; a staff account with one would be
    // meaningless data waiting to confuse a future rule.
    actAs(ADMIN);
    storageMock.getUser.mockImplementation(async (id: string) =>
      id === STAFF.id ? STAFF : ADMIN,
    );
    storageMock.getProperty.mockResolvedValue({ id: "prop-west", name: "Como House", region: "West Central" });

    const { status } = await request("PATCH", `/api/users/${STAFF.id}/property`, {
      body: { propertyId: "prop-west" },
    });
    expect(status).toBe(400);
    expect(storageMock.updateUserProperty).not.toHaveBeenCalled();
  });
});

describe("the removed JotForm webhook", () => {
  // The integration was removed outright (2026-08-26). The route must be gone,
  // not disabled: 404, never the old fail-closed 503, and nothing written.
  it("answers 404 and creates nothing", async () => {
    const { status } = await request("POST", "/api/webhooks/jotform", {
      body: { rawRequest: JSON.stringify({ q1_title: "sneaky" }) },
    });
    expect(status).toBe(404);
    expect(storageMock.createMaintenanceRequest).not.toHaveBeenCalled();
  });

  it("no longer exposes the config endpoint", async () => {
    actAs(ADMIN);
    expect((await get("/api/webhooks/jotform/config")).status).toBe(404);
  });
});

describe("tasks & action items (regional leads only)", () => {
  // A West-Central RA. Their region comes from their permissions row.
  const WEST = { allowedRegions: ["West Central"] };

  it("refuses a resident the action-items list even with every permission", async () => {
    actAs(ALICE, { canViewProperties: true, canManageProperties: true, canManageMaintenance: true });
    expect((await get("/api/action-items")).status).toBe(403);
  });

  it("refuses a resident the tasks list", async () => {
    actAs(ALICE, { canManageProperties: true });
    expect((await get("/api/tasks")).status).toBe(403);
  });

  it("shows an RA their own-region and all-region broadcasts, but not another region's or someone else's personal task", async () => {
    actAs(STAFF, WEST);
    storageMock.getAllTasks.mockResolvedValue([
      { id: "west", region: "West Central", assignedToUserId: null, createdBy: ADMIN.id, status: "open" },
      { id: "all", region: null, assignedToUserId: null, createdBy: ADMIN.id, status: "open" },
      { id: "east", region: "East Central", assignedToUserId: null, createdBy: ADMIN.id, status: "open" },
      { id: "mine", region: null, assignedToUserId: STAFF.id, createdBy: STAFF.id, status: "open" },
      { id: "theirs", region: null, assignedToUserId: ADMIN.id, createdBy: ADMIN.id, status: "open" },
      // Orphaned: its creator's account was deleted (createdBy set null). A
      // region broadcast still follows the region rule.
      { id: "orphan", region: "West Central", assignedToUserId: null, createdBy: null, status: "open" },
    ]);
    const { status, body } = await get("/api/tasks");
    expect(status).toBe(200);
    expect(body.map((t: { id: string }) => t.id).sort()).toEqual(["all", "mine", "orphan", "west"]);
  });

  it("hides a lease-derived task from an RA without the properties flag, but not an ordinary task in the same response (#170)", async () => {
    actAs(STAFF, WEST);
    storageMock.getAllTasks.mockResolvedValue([
      { id: "ordinary", region: "West Central", assignedToUserId: null, createdBy: ADMIN.id, status: "open", sourceKey: "walkthrough:apr:West Central:2026" },
      { id: "renewal", region: "West Central", assignedToUserId: null, createdBy: ADMIN.id, status: "open", sourceKey: "lease-renewal:prop-1:2026-10-01" },
      { id: "shutoff", region: "West Central", assignedToUserId: null, createdBy: ADMIN.id, status: "open", sourceKey: "utilities-lease:prop-1:2026-10-01" },
    ]);
    const { status, body } = await get("/api/tasks");
    expect(status).toBe(200);
    expect(body.map((t: { id: string }) => t.id)).toEqual(["ordinary"]);
  });

  it("shows a lease-derived task to an RA holding canViewProperties -- the positive control", async () => {
    actAs(STAFF, { ...WEST, canViewProperties: true });
    storageMock.getAllTasks.mockResolvedValue([
      { id: "renewal", region: "West Central", assignedToUserId: null, createdBy: ADMIN.id, status: "open", sourceKey: "lease-renewal:prop-1:2026-10-01" },
    ]);
    const { status, body } = await get("/api/tasks");
    expect(status).toBe(200);
    expect(body.map((t: { id: string }) => t.id)).toEqual(["renewal"]);
  });

  it("lets an RA broadcast a task to their own region", async () => {
    actAs(STAFF, WEST);
    storageMock.createTask.mockImplementation(async (data: Record<string, unknown>) => ({ id: "t-1", ...data }));
    const { status } = await request("POST", "/api/tasks", { body: { title: "Inspect furnaces", region: "West Central" } });
    expect(status).toBe(200);
    expect(storageMock.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ region: "West Central", assignedToUserId: null, createdBy: STAFF.id }),
    );
  });

  it("refuses an RA broadcasting to a region they cannot reach", async () => {
    actAs(STAFF, WEST);
    const { status } = await request("POST", "/api/tasks", { body: { title: "x", region: "East Central" } });
    expect(status).toBe(403);
    expect(storageMock.createTask).not.toHaveBeenCalled();
  });

  it("refuses an RA broadcasting to all regions, but lets an admin", async () => {
    actAs(STAFF, WEST);
    const denied = await request("POST", "/api/tasks", { body: { title: "x", region: null } });
    expect(denied.status).toBe(403);
    expect(storageMock.createTask).not.toHaveBeenCalled();

    actAs(ADMIN);
    storageMock.createTask.mockImplementation(async (data: Record<string, unknown>) => ({ id: "t-2", ...data }));
    const allowed = await request("POST", "/api/tasks", { body: { title: "All-hands notice", region: null } });
    expect(allowed.status).toBe(200);
    expect(storageMock.createTask).toHaveBeenCalledWith(expect.objectContaining({ region: null, createdBy: ADMIN.id }));
  });

  it("takes a personal task's owner from the actor, ignoring the body", async () => {
    actAs(STAFF, WEST);
    storageMock.createTask.mockImplementation(async (data: Record<string, unknown>) => ({ id: "t-3", ...data }));
    const { status } = await request("POST", "/api/tasks", { body: { title: "Call bank", assignedToUserId: "u-someone-else" } });
    expect(status).toBe(200);
    // A truthy assignee means "just me" — the server pins it to the actor.
    expect(storageMock.createTask).toHaveBeenCalledWith(expect.objectContaining({ assignedToUserId: STAFF.id }));
  });

  it("gives a personal task a region-free scope, whatever the body says", async () => {
    actAs(STAFF, WEST);
    storageMock.createTask.mockImplementation(async (data: Record<string, unknown>) => ({ id: "t-4", ...data }));
    const { status } = await request("POST", "/api/tasks", {
      body: { title: "Call Jane's parents", assignedToUserId: STAFF.id, region: "East Central" },
    });
    expect(status).toBe(200);
    expect(storageMock.createTask).toHaveBeenCalledWith(expect.objectContaining({ assignedToUserId: STAFF.id, region: null }));
  });

  describe("a personal task whose owner's account is gone", () => {
    const ORPHANED = { id: "t-o", title: "Call Jane's parents", region: null, assignedToUserId: null, createdBy: null, sourceKey: null, status: "open" };

    it("is not listed for staff", async () => {
      actAs(STAFF, { allowedRegions: ["all"] });
      storageMock.getAllTasks.mockResolvedValue([ORPHANED]);
      const { status, body } = await get("/api/tasks");
      expect(status).toBe(200);
      expect(body).toEqual([]);
    });

    it("cannot be edited by staff", async () => {
      actAs(STAFF, { allowedRegions: ["all"] });
      storageMock.getTask.mockResolvedValue(ORPHANED);
      const { status } = await request("PATCH", "/api/tasks/t-o", { body: { status: "done" } });
      expect(status).toBe(403);
      expect(storageMock.updateTask).not.toHaveBeenCalled();
    });

    it("is listed and editable for an admin", async () => {
      actAs(ADMIN);
      storageMock.getAllTasks.mockResolvedValue([ORPHANED]);
      expect((await get("/api/tasks")).body.map((t: { id: string }) => t.id)).toEqual(["t-o"]);

      storageMock.getTask.mockResolvedValue(ORPHANED);
      storageMock.updateTask.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({ id, ...patch }));
      const { status } = await request("PATCH", "/api/tasks/t-o", { body: { status: "done" } });
      expect(status).toBe(200);
      expect(storageMock.updateTask).toHaveBeenCalledWith("t-o", expect.objectContaining({ status: "done" }));
    });
  });

  it("does not let a task patch change who it is for, and stamps completion", async () => {
    actAs(STAFF, WEST);
    storageMock.getTask.mockResolvedValue({ id: "t-1", region: "West Central", assignedToUserId: null, createdBy: STAFF.id, status: "open" });
    storageMock.updateTask.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({ id, ...patch }));
    const { status } = await request("PATCH", "/api/tasks/t-1", {
      body: { status: "done", region: "East Central", assignedToUserId: "u-evil", createdBy: "u-evil" },
    });
    expect(status).toBe(200);
    const patch = storageMock.updateTask.mock.calls[0][1];
    for (const forbidden of ["region", "assignedToUserId", "createdBy"]) {
      expect(patch).not.toHaveProperty(forbidden);
    }
    expect(patch).toMatchObject({ status: "done", completedBy: STAFF.id });
  });

  it("refuses to patch a task in a region the RA cannot see", async () => {
    actAs(STAFF, WEST);
    storageMock.getTask.mockResolvedValue({ id: "t-e", region: "East Central", assignedToUserId: null, createdBy: ADMIN.id, status: "open" });
    const { status } = await request("PATCH", "/api/tasks/t-e", { body: { status: "done" } });
    expect(status).toBe(403);
    expect(storageMock.updateTask).not.toHaveBeenCalled();
  });

  it("lets only the creator (or an admin) delete a task", async () => {
    actAs(STAFF, WEST);
    storageMock.getTask.mockResolvedValue({ id: "t-x", region: "West Central", assignedToUserId: null, createdBy: ADMIN.id, status: "open" });
    const denied = await request("DELETE", "/api/tasks/t-x", {});
    expect(denied.status).toBe(403);
    expect(storageMock.deleteTask).not.toHaveBeenCalled();

    actAs(ADMIN);
    storageMock.getTask.mockResolvedValue({ id: "t-x", region: "West Central", assignedToUserId: null, createdBy: STAFF.id, status: "open" });
    const allowed = await request("DELETE", "/api/tasks/t-x", {});
    expect(allowed.status).toBe(200);
    expect(storageMock.deleteTask).toHaveBeenCalledWith("t-x");
  });

  it("builds region-scoped action items for an RA", async () => {
    actAs(STAFF, { ...WEST, canViewFinancials: true });
    storageMock.getAllMaintenanceRequests.mockResolvedValue([]);
    storageMock.getAllMaintenanceSchedules.mockResolvedValue([]);
    storageMock.getAllRentPayments.mockResolvedValue([
      { id: "rp-w", status: "unpaid", period: "2026-07", amount: "700", buildingAddress: "1 Main St", region: "West Central" },
      { id: "rp-e", status: "unpaid", period: "2026-07", amount: "700", buildingAddress: "9 Elm", region: "East Central" },
    ]);
    storageMock.getAllSecurityDeposits.mockResolvedValue([]);
    storageMock.getAllDepositDeductions.mockResolvedValue([]);
    storageMock.getAllResidents.mockResolvedValue([]);
    storageMock.getAllTasks.mockResolvedValue([]);
    storageMock.getAllProperties.mockResolvedValue([]);
    storageMock.getAllPropertySetupItems.mockResolvedValue([]);
    storageMock.getAllAssets.mockResolvedValue([]);
    const { status, body } = await get("/api/action-items");
    expect(status).toBe(200);
    // The East-Central rent is filtered out by region.
    expect(body.map((i: { id: string }) => i.id)).toEqual(["rp-w"]);
  });

  it("hides finance-derived action items from an RA without the finance flags", async () => {
    actAs(STAFF, WEST);
    storageMock.getAllMaintenanceRequests.mockResolvedValue([]);
    storageMock.getAllMaintenanceSchedules.mockResolvedValue([]);
    storageMock.getAllRentPayments.mockResolvedValue([
      { id: "rp-w", status: "unpaid", period: "2026-07", amount: "700", buildingAddress: "1 Main St", region: "West Central" },
    ]);
    storageMock.getAllSecurityDeposits.mockResolvedValue([]);
    storageMock.getAllResidents.mockResolvedValue([]);
    storageMock.getAllTasks.mockResolvedValue([]);
    storageMock.getAllProperties.mockResolvedValue([]);
    storageMock.getAllPropertySetupItems.mockResolvedValue([]);
    storageMock.getAllAssets.mockResolvedValue([]);
    const { status, body } = await get("/api/action-items");
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  // Amendment to 10.5: open work on the dashboard, one item per house.
  function mockOpenWork() {
    storageMock.getAllMaintenanceSchedules.mockResolvedValue([]);
    storageMock.getAllRentPayments.mockResolvedValue([]);
    storageMock.getAllSecurityDeposits.mockResolvedValue([]);
    storageMock.getAllResidents.mockResolvedValue([]);
    storageMock.getAllTasks.mockResolvedValue([]);
    storageMock.getAllPropertySetupItems.mockResolvedValue([]);
    storageMock.getAllAssets.mockResolvedValue([]);
    storageMock.getAllProperties.mockResolvedValue([
      { id: "prop-w", name: "Cleveland House", address: "1 Main St", region: "West Central", ownership: "owned" },
      { id: "prop-e", name: "Buckeye House", address: "9 Elm", region: "East Central", ownership: "owned" },
    ]);
    storageMock.getAllMaintenanceRequests.mockResolvedValue([
      { id: "w-repair", title: "Blinds", region: "West Central", buildingAddress: "1 Main St", status: "pending", type: "request", priority: "medium" },
      { id: "w-project", title: "Fence", region: "West Central", buildingAddress: "1 Main St", status: "in_progress", type: "project", priority: "medium" },
      { id: "e-repair", title: "Window", region: "East Central", buildingAddress: "9 Elm", status: "pending", type: "request", priority: "medium" },
    ]);
  }

  it("raises an RA's own region's open work by house, and never another region's", async () => {
    actAs(STAFF, { ...WEST, canViewMaintenance: true });
    mockOpenWork();
    const { status, body } = await get("/api/action-items");
    expect(status).toBe(200);
    const work = body.filter((i: { source: string }) => i.source === "maintenance");
    expect(work.map((i: { id: string }) => i.id)).toEqual(["1 Main St"]);
    expect(work[0].subtitle).toContain("1 repair, 1 project");
    expect(JSON.stringify(body)).not.toContain("9 Elm");
  });

  it("raises no open work at all for an RA with no regions -- fails closed, not open", async () => {
    // Holding the flag, so it is the empty region list refusing, not #158's flag rule.
    actAs(STAFF, { allowedRegions: [], canViewMaintenance: true });
    mockOpenWork();
    const { status, body } = await get("/api/action-items");
    expect(status).toBe(200);
    expect(body.filter((i: { source: string }) => i.source === "maintenance")).toEqual([]);
  });

  it("raises every region's open work for an admin", async () => {
    actAs(ADMIN);
    mockOpenWork();
    const { body } = await get("/api/action-items");
    const work = body.filter((i: { source: string }) => i.source === "maintenance");
    expect(work.map((i: { id: string }) => i.id).sort()).toEqual(["1 Main St", "9 Elm"]);
  });

  it("shows an RA a lease renewal in their region but not another region's", async () => {
    actAs(STAFF, { ...WEST, canViewProperties: true });
    storageMock.getAllMaintenanceRequests.mockResolvedValue([]);
    storageMock.getAllMaintenanceSchedules.mockResolvedValue([]);
    storageMock.getAllRentPayments.mockResolvedValue([]);
    storageMock.getAllSecurityDeposits.mockResolvedValue([]);
    storageMock.getAllResidents.mockResolvedValue([]);
    storageMock.getAllTasks.mockResolvedValue([]);
    const soon = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000);
    storageMock.getAllProperties.mockResolvedValue([
      { id: "prop-w", name: "Cleveland House", address: "1 Main St", region: "West Central", ownership: "rented", leaseRenewalDate: soon, renewalDecision: "undecided" },
      { id: "prop-e", name: "Buckeye House", address: "9 Elm", region: "East Central", ownership: "rented", leaseRenewalDate: soon, renewalDecision: "undecided" },
    ]);
    storageMock.getAllPropertySetupItems.mockResolvedValue([]);
    storageMock.getAllAssets.mockResolvedValue([]);
    const { status, body } = await get("/api/action-items");
    expect(status).toBe(200);
    expect(body.map((i: { id: string; source: string }) => i.id)).toEqual(["prop-w"]);
    expect(body[0].source).toBe("lease");
  });
});

describe("dashboard items follow the flag of the list they come from (#158)", () => {
  const WEST = { allowedRegions: ["West Central"] };
  const soon = () => new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);

  // QuickBooks on and current, so the budget source has a figure to judge.
  const QB_ENV = {
    QUICKBOOKS_CLIENT_ID: "client-id",
    QUICKBOOKS_CLIENT_SECRET: "client-secret",
    QUICKBOOKS_REDIRECT_URI: "https://portal.example.org/api/quickbooks/callback",
    QUICKBOOKS_TOKEN_KEY: "ab".repeat(32),
  };
  const savedEnv: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const [name, value] of Object.entries(QB_ENV)) {
      savedEnv[name] = process.env[name];
      process.env[name] = value;
    }
  });
  afterAll(() => {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  // One West-Central record behind every non-finance source, plus a task.
  function mockEverySource() {
    storageMock.getAllRentPayments.mockResolvedValue([]);
    storageMock.getAllSecurityDeposits.mockResolvedValue([]);
    storageMock.getAllDepositDeductions.mockResolvedValue([]);
    storageMock.getAllResidents.mockResolvedValue([]);
    storageMock.getAllMaintenanceSchedules.mockResolvedValue([
      { id: "sched-w", title: "Furnace service", isActive: true, nextDueDate: soon(), buildingAddress: "1 Main St", region: "West Central" },
    ]);
    storageMock.getAllProperties.mockResolvedValue([
      { id: "prop-w", name: "Cleveland House", address: "1 Main St", region: "West Central", ownership: "rented", leaseRenewalDate: soon(), renewalDecision: "undecided" },
      { id: "prop-w2", name: "Raven House", address: "2 Main St", region: "West Central", ownership: "owned" },
    ]);
    // Over its budget: the one pace verdict that holds on any date this runs.
    const fiscalYear = new Date().getUTCMonth() >= 5 ? new Date().getUTCFullYear() + 1 : new Date().getUTCFullYear();
    storageMock.getAllRepairBudgets.mockResolvedValue([{ id: "rb-w2", propertyId: "prop-w2", fiscalYear, amount: "10000.00", region: "West Central" }]);
    storageMock.getAllPropertySpend.mockResolvedValue([
      { id: "sp-w2", propertyId: "prop-w2", fiscalYear, amount: "12000.00", region: "West Central", syncedAt: new Date() },
    ]);
    storageMock.getAllPropertyQuickbooksLinks.mockResolvedValue([
      { propertyId: "prop-w2", kind: "class", externalId: "101", externalName: "Raven", region: "West Central" },
    ]);
    storageMock.getQuickbooksIntegration.mockResolvedValue({
      id: "default",
      realmId: "9130",
      encryptedRefreshToken: "v1:x:y:z",
      connectedAt: new Date(),
      lastSuccessAt: new Date(),
      repairAccountIds: ["57"],
    });
    storageMock.getAllPropertySetupItems.mockResolvedValue([{ propertyId: "prop-w", itemKey: "electric", status: "open" }]);
    storageMock.getAllAssets.mockResolvedValue([
      { id: "asset-w", name: "Boiler", category: "Water Heater", replacementDueDate: soon(), buildingAddress: "1 Main St", region: "West Central" },
    ]);
    storageMock.getAllMaintenanceRequests.mockResolvedValue([
      { id: "rq-w", title: "Blinds", region: "West Central", buildingAddress: "1 Main St", status: "pending", type: "request", priority: "medium" },
    ]);
    // A safety task, so the region summary's safety count has a task half to test.
    storageMock.getAllTasks.mockResolvedValue([
      { id: "task-w", title: "Walkthrough season", category: "safety", region: "West Central", assignedToUserId: null, createdBy: ADMIN.id, status: "open" },
    ]);
    storageMock.getAllUsers.mockResolvedValue([]);
    storageMock.getAllUserPermissions.mockResolvedValue([]);
  }

  const sources = (body: { source: string }[]) => Array.from(new Set(body.map((i) => i.source))).sort();

  it("gives staff holding no flags their tasks and nothing from a list they cannot open", async () => {
    // The sweep's account: staff tier, holding only the resident-tier walkthrough grant.
    actAs(STAFF, { ...WEST, canCompleteWalkthroughs: true });
    mockEverySource();
    const { status, body } = await get("/api/action-items");
    expect(status).toBe(200);
    expect(sources(body)).toEqual(["task"]);
    for (const hidden of ["Furnace service", "Cleveland House", "Boiler", "1 Main St"]) {
      expect(JSON.stringify(body)).not.toContain(hidden);
    }
  });

  it("gives each source to the flag its own list asks for", async () => {
    actAs(STAFF, { ...WEST, canViewMaintenance: true });
    mockEverySource();
    expect(sources((await get("/api/action-items")).body)).toEqual(["maintenance", "schedule", "task"]);

    actAs(STAFF, { ...WEST, canViewProperties: true });
    mockEverySource();
    expect(sources((await get("/api/action-items")).body)).toEqual(["budget", "lease", "setup", "task"]);

    actAs(STAFF, { ...WEST, canViewAssets: true });
    mockEverySource();
    expect(sources((await get("/api/action-items")).body)).toEqual(["asset", "task"]);
  });

  it("gives every source to staff holding every flag -- the positive control", async () => {
    actAs(STAFF, { ...WEST, canViewMaintenance: true, canViewProperties: true, canViewAssets: true });
    mockEverySource();
    expect(sources((await get("/api/action-items")).body)).toEqual(["asset", "budget", "lease", "maintenance", "schedule", "setup", "task"]);
  });

  it("does not read the requests, schedules or houses for a region summary the caller cannot open", async () => {
    actAs(STAFF, { ...WEST, canCompleteWalkthroughs: true });
    mockEverySource();
    const { status, body } = await get("/api/region-summary");
    expect(status).toBe(200);
    // The safety task still counts: tasks need only staff. The schedule does not.
    expect(body[0]).toMatchObject({ region: "West Central", openRequests: 0, openRepairs: 0, leaseRenewalsDue: 0, safetyPreventiveDue: 1 });
    expect(storageMock.getAllMaintenanceRequests).not.toHaveBeenCalled();
    expect(storageMock.getAllMaintenanceSchedules).not.toHaveBeenCalled();
    expect(storageMock.getAllProperties).not.toHaveBeenCalled();
    // #171: a caller without canViewMaintenance/canManageMaintenance gets 0
    // from the region's real open request, the source reads hidden, and that
    // 0 is what feeds attentionScore -- not a magnitude that got masked only
    // in the response and not in the score.
    expect(body[0].hidden.sort()).toEqual(["lease", "maintenance", "rent", "schedule"]);
    expect(body[0].attentionScore).toBe(1); // the one visible safety task only
  });

  it("counts them for staff holding the flags -- the positive control", async () => {
    actAs(STAFF, { ...WEST, canViewMaintenance: true, canViewProperties: true });
    mockEverySource();
    const { body } = await get("/api/region-summary");
    expect(body[0]).toMatchObject({ region: "West Central", openRequests: 1, openRepairs: 1, leaseRenewalsDue: 1, safetyPreventiveDue: 2 });
    expect(body[0].hidden.sort()).toEqual(["rent"]); // finance flags not held here
  });

  it("excludes a lease-derived task from the region summary's safety count for staff without the properties flag (#170)", async () => {
    actAs(STAFF, { ...WEST, canViewMaintenance: true });
    mockEverySource();
    // Alongside mockEverySource's ordinary safety task, a lease-derived one.
    storageMock.getAllTasks.mockResolvedValue([
      { id: "task-w", title: "Walkthrough season", category: "safety", region: "West Central", assignedToUserId: null, createdBy: ADMIN.id, status: "open", sourceKey: "walkthrough:apr:West Central:2026" },
      { id: "task-lease", title: "Turn off utilities — lease ending", category: "safety", region: "West Central", assignedToUserId: null, createdBy: ADMIN.id, status: "open", sourceKey: "utilities-lease:prop-1:2026-10-01" },
    ]);
    const { status, body } = await get("/api/region-summary");
    expect(status).toBe(200);
    // schedulesDue(1, canViewMaintenance) + the ordinary safety task(1); the
    // lease-derived one is hidden.
    expect(body[0]).toMatchObject({ region: "West Central", safetyPreventiveDue: 2 });
  });

  it("includes a lease-derived task in the safety count for staff holding canViewProperties -- the positive control", async () => {
    actAs(STAFF, { ...WEST, canViewMaintenance: true, canViewProperties: true });
    mockEverySource();
    storageMock.getAllTasks.mockResolvedValue([
      { id: "task-w", title: "Walkthrough season", category: "safety", region: "West Central", assignedToUserId: null, createdBy: ADMIN.id, status: "open", sourceKey: "walkthrough:apr:West Central:2026" },
      { id: "task-lease", title: "Turn off utilities — lease ending", category: "safety", region: "West Central", assignedToUserId: null, createdBy: ADMIN.id, status: "open", sourceKey: "utilities-lease:prop-1:2026-10-01" },
    ]);
    const { status, body } = await get("/api/region-summary");
    expect(status).toBe(200);
    // schedulesDue(1) + both safety tasks(2), now that the flag is held.
    expect(body[0]).toMatchObject({ region: "West Central", safetyPreventiveDue: 3 });
  });
});

describe("region summary (leadership rollup)", () => {
  function mockEmptyData() {
    storageMock.getAllMaintenanceRequests.mockResolvedValue([]);
    storageMock.getAllMaintenanceSchedules.mockResolvedValue([]);
    storageMock.getAllProperties.mockResolvedValue([]);
    storageMock.getAllRentPayments.mockResolvedValue([]);
    storageMock.getAllTasks.mockResolvedValue([]);
    storageMock.getAllUsers.mockResolvedValue([]);
    storageMock.getAllUserPermissions.mockResolvedValue([]);
  }

  it("refuses a resident", async () => {
    actAs(ALICE, { canViewProperties: true, canManageProperties: true });
    expect((await get("/api/region-summary")).status).toBe(403);
  });

  it("gives a regional admin only their region, named with its lead", async () => {
    actAs(STAFF, { canViewFinancials: true, canManageFinancials: true, canViewMaintenance: true, allowedRegions: ["West Central"] });
    mockEmptyData();
    storageMock.getAllUsers.mockResolvedValue([STAFF]);
    storageMock.getAllUserPermissions.mockResolvedValue([{ userId: STAFF.id, allowedRegions: ["West Central"] }]);
    storageMock.getAllMaintenanceRequests.mockResolvedValue([
      { id: "rq-w", region: "West Central", status: "pending" },
      { id: "rq-e", region: "East Central", status: "pending" }, // filtered out by region
    ]);

    const { status, body } = await get("/api/region-summary");
    expect(status).toBe(200);
    expect(body.map((s: { region: string }) => s.region)).toEqual(["West Central"]);
    expect(body[0].openRequests).toBe(1);
    expect(body[0].admins).toEqual([{ name: STAFF.email, email: STAFF.email }]);
  });

  it("gives an admin every region", async () => {
    actAs(ADMIN);
    mockEmptyData();
    const { status, body } = await get("/api/region-summary");
    expect(status).toBe(200);
    // One summary per canonical region (see shared/regions.ts).
    expect(body.length).toBe(7);
  });
});

describe("maintenance request photos", () => {
  const body = { title: "Leaky tap", description: "drips", category: "plumbing", priority: "medium", location: "Kitchen" };

  it("attaches only the submitter's own uploads to their new request", async () => {
    actAs(ALICE, ALL_MAINTENANCE);
    storageMock.getActiveResidentByEmail.mockResolvedValue({ region: "West Central", buildingAddress: "1 Main St" });
    storageMock.createMaintenanceRequest.mockImplementation(async (d: Record<string, unknown>) => ({ id: "req-new", ...d }));
    // "mine.png" belongs to Alice; "theirs.png" belongs to someone else.
    storageMock.getUploadByStorageKey.mockImplementation(async (key: string) =>
      key === "mine.png" ? { storageKey: key, uploadedBy: ALICE.id } : { storageKey: key, uploadedBy: "u-someone-else" },
    );

    const { status } = await request("POST", "/api/maintenance-requests", {
      body: { ...body, photoUrls: ["/uploads/mine.png", "/uploads/theirs.png"] },
    });

    expect(status).toBe(200);
    expect(storageMock.createMaintenanceRequestPhoto).toHaveBeenCalledTimes(1);
    expect(storageMock.createMaintenanceRequestPhoto).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "req-new", imageUrl: "/uploads/mine.png", uploadedBy: ALICE.email }),
    );
  });

  it("shows a resident only their own request's photos", async () => {
    actAs(ALICE, ALL_MAINTENANCE);
    storageMock.getAllMaintenanceRequests.mockResolvedValue([WEST_REQUEST, EAST_REQUEST]); // west = Alice's, east = Bob's
    storageMock.getAllMaintenanceRequestPhotos.mockResolvedValue([
      { id: "ph-west", requestId: "req-west", imageUrl: "/uploads/a.png" },
      { id: "ph-east", requestId: "req-east", imageUrl: "/uploads/b.png" },
    ]);

    const { status, body: photos } = await get("/api/maintenance-request-photos");
    expect(status).toBe(200);
    expect(photos.map((p: { id: string }) => p.id)).toEqual(["ph-west"]);
  });

  it("lets a resident delete a photo they added but not one on another resident's request", async () => {
    actAs(ALICE, ALL_MAINTENANCE);
    storageMock.getMaintenanceRequestPhoto.mockResolvedValue({ id: "ph-west", requestId: "req-west", uploadedBy: ALICE.email });
    storageMock.getMaintenanceRequest.mockResolvedValue(WEST_REQUEST);
    expect((await request("DELETE", "/api/maintenance-request-photos/ph-west", {})).status).toBe(200);

    storageMock.getMaintenanceRequestPhoto.mockResolvedValue({ id: "ph-east", requestId: "req-east", uploadedBy: BOB.email });
    storageMock.getMaintenanceRequest.mockResolvedValue(EAST_REQUEST); // Bob's — Alice can't even read it
    const denied = await request("DELETE", "/api/maintenance-request-photos/ph-east", {});
    expect(denied.status).toBe(403);
    // Only the first (own) delete went through — the denied one did not.
    expect(storageMock.deleteMaintenanceRequestPhoto).toHaveBeenCalledTimes(1);
    expect(storageMock.deleteMaintenanceRequestPhoto).toHaveBeenCalledWith("ph-west");
  });
});

// ---------------------------------------------------------------------------
// A request's thread, photos and files need the maintenance permission
// ---------------------------------------------------------------------------

/**
 * Staff reach a request by region AND a maintenance flag. The request page
 * always checked the flag; everything hanging off the request -- its thread,
 * its photos, a comment's attachment and the file behind it -- inherits the
 * request rule, so the flag has to be in that rule or taking maintenance
 * access away from somebody leaves the internal thread, costs and all, open to
 * them. Every refusal is paired with the work never happening, and each has a
 * positive control holding the flag.
 */
describe("a request's thread, photos and files need the maintenance permission for staff", () => {
  const REQ = { ...WEST_REQUEST, buildingAddress: "1 Main St" };
  const INTERNAL = { id: "c-1", requestId: REQ.id, body: "He quoted $4,200.", isInternal: true, authorUserId: "u-other" };
  const PHOTO = { id: "ph-1", requestId: REQ.id, imageUrl: "/uploads/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jpg", uploadedBy: "other@example.com" };
  const KEY = "0123456789abcdef0123456789abcdef.pdf";
  const noFlag = { canCompleteWalkthroughs: true, allowedRegions: ["West Central"] };
  const viewOnly = { canViewMaintenance: true, allowedRegions: ["West Central"] };
  const manage = { ...ALL_MAINTENANCE, allowedRegions: ["West Central"] };

  beforeEach(() => {
    storageMock.getMaintenanceRequest.mockResolvedValue(REQ);
    storageMock.getMaintenanceRequestComments.mockResolvedValue([INTERNAL]);
    storageMock.createMaintenanceRequestComment.mockImplementation(async (c: unknown) => ({ id: "c-new", ...(c as object) }));
    storageMock.getAllMaintenanceRequests.mockResolvedValue([REQ]);
    storageMock.getAllMaintenanceRequestPhotos.mockResolvedValue([PHOTO]);
    storageMock.getMaintenanceRequestPhoto.mockResolvedValue(PHOTO);
    storageMock.deleteMaintenanceRequestPhoto.mockResolvedValue([]);
    storageMock.findUploadReferences.mockResolvedValue([
      { kind: "maintenanceRequestComment", record: { ...INTERNAL, attachmentUrl: `/uploads/${KEY}` } },
    ]);
  });

  const aFile = () => {
    const form = new FormData();
    form.append("file", new Blob([new TextEncoder().encode("%PDF-1.4\n%quote\n")], { type: "application/pdf" }), "quote.pdf");
    return form;
  };

  it("refuses the thread to staff without the flag, and never reads it", async () => {
    actAs(STAFF, noFlag);
    expect((await get(`/api/maintenance-requests/${REQ.id}/comments`)).status).toBe(403);
    expect(storageMock.getMaintenanceRequestComments).not.toHaveBeenCalled();
  });

  it("refuses an internal post from staff without the flag, and writes nothing", async () => {
    actAs(STAFF, noFlag);
    const { status } = await request("POST", `/api/maintenance-requests/${REQ.id}/comments`, { body: { body: "Noted.", isInternal: true } });
    expect(status).toBe(403);
    expect(storageMock.createMaintenanceRequestComment).not.toHaveBeenCalled();
  });

  it("lists no request photos to staff without the flag", async () => {
    actAs(STAFF, noFlag);
    const { status, body } = await get("/api/maintenance-request-photos");
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it("refuses a photo delete from staff without the flag, and deletes nothing", async () => {
    actAs(STAFF, noFlag);
    expect((await request("DELETE", `/api/maintenance-request-photos/${PHOTO.id}`)).status).toBe(403);
    expect(storageMock.deleteMaintenanceRequestPhoto).not.toHaveBeenCalled();
  });

  it("refuses a photo delete from view-only staff, and deletes nothing", async () => {
    actAs(STAFF, viewOnly);
    expect((await request("DELETE", `/api/maintenance-request-photos/${PHOTO.id}`)).status).toBe(403);
    expect(storageMock.deleteMaintenanceRequestPhoto).not.toHaveBeenCalled();
  });

  it("refuses an attachment upload from staff without the flag before reading the body", async () => {
    actAs(STAFF, noFlag);
    const res = await fetch(`${baseUrl}/api/maintenance-requests/${REQ.id}/attachments`, { method: "POST", body: aFile() });
    expect(res.status).toBe(403);
    expect(multerEntered).not.toHaveBeenCalled();
    expect(fileStoreMock.putUpload).not.toHaveBeenCalled();
  });

  it("refuses an internal comment's file to staff without the flag, and never opens it", async () => {
    actAs(STAFF, noFlag);
    expect((await get(`/uploads/${KEY}`)).status).toBe(403);
    expect(fileStoreMock.openUploadStream).not.toHaveBeenCalled();
  });

  // -- positive controls: the same calls holding the flag ----------------------

  it("reads the thread, including the internal comment, for staff with the view flag", async () => {
    actAs(STAFF, viewOnly);
    const { status, body } = await get(`/api/maintenance-requests/${REQ.id}/comments`);
    expect(status).toBe(200);
    expect(body).toHaveLength(1);
  });

  it("posts an internal comment for staff with the view flag", async () => {
    actAs(STAFF, viewOnly);
    const { status } = await request("POST", `/api/maintenance-requests/${REQ.id}/comments`, { body: { body: "Noted.", isInternal: true } });
    expect(status).toBe(201);
    expect(storageMock.createMaintenanceRequestComment).toHaveBeenCalled();
  });

  it("lists the photo for staff with the view flag", async () => {
    actAs(STAFF, viewOnly);
    expect((await get("/api/maintenance-request-photos")).body).toHaveLength(1);
  });

  it("deletes a photo for staff with the manage flag", async () => {
    actAs(STAFF, manage);
    expect((await request("DELETE", `/api/maintenance-request-photos/${PHOTO.id}`)).status).toBe(200);
    expect(storageMock.deleteMaintenanceRequestPhoto).toHaveBeenCalledWith(PHOTO.id);
  });

  it("stores an attachment for staff with the view flag", async () => {
    actAs(STAFF, viewOnly);
    storageMock.createUpload.mockImplementation(async (u: unknown) => ({ id: "upload-1", ...(u as object) }));
    const res = await fetch(`${baseUrl}/api/maintenance-requests/${REQ.id}/attachments`, { method: "POST", body: aFile() });
    expect(res.status).toBe(200);
    expect(multerEntered).toHaveBeenCalled();
  });

  it("serves the internal comment's file to staff with the view flag", async () => {
    actAs(STAFF, viewOnly);
    expect((await get(`/uploads/${KEY}`)).status).toBe(200);
    expect(fileStoreMock.openUploadStream).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Every permission flag can actually be granted
// ---------------------------------------------------------------------------

/**
 * The permissions PATCH parses its body with a zod object, and a zod object
 * silently drops any key it does not list. Three flags added over three
 * phases were never added to that list, so the Settings toggle for the
 * resource hub saved nothing and nobody noticed until a Playwright spec tried
 * to grant it. The column list is read off the table so the next flag cannot
 * repeat this: a boolean column the route will not accept fails here.
 */
describe("granting every permission flag", () => {
  const patch = (path: string, body: unknown) => request("PATCH", path, { body });
  const FLAGS = Object.entries(getTableColumns(userPermissions))
    .filter(([, column]) => column.dataType === "boolean")
    .map(([name]) => name);

  it("names at least the flags this suite already knows about", () => {
    expect(FLAGS).toEqual(expect.arrayContaining(["canViewMaintenance", "canViewResourceHub", "canCompleteWalkthroughs", "canManagePropertySetup"]));
  });

  it.each(FLAGS)("stores %s when an admin sets it", async (flag) => {
    actAs(ADMIN);
    storageMock.getUserPermissions.mockResolvedValue(undefined);
    storageMock.upsertUserPermissions.mockImplementation(async (p: unknown) => p);
    const { status, body } = await patch("/api/users/u-alice/permissions", { [flag]: true });
    expect(status).toBe(200);
    expect(storageMock.upsertUserPermissions).toHaveBeenCalledWith(expect.objectContaining({ userId: "u-alice", [flag]: true }));
    expect(body[flag]).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A resident account's permissions row holds only resident grants
// ---------------------------------------------------------------------------

/**
 * A resident's row is read by the maintenance routes, walkthrough completion
 * and the resource hub, and by nothing else. A staff flag or a region on it
 * grants nothing today only because every staff route also checks the role,
 * so the row is refused at the door instead of left for one missed staff
 * check to turn into a region path.
 */
describe("setting a resident account's permissions", () => {
  const patch = (path: string, body: unknown) => request("PATCH", path, { body });
  const FLAGS = Object.entries(getTableColumns(userPermissions))
    .filter(([, column]) => column.dataType === "boolean")
    .map(([name]) => name);
  // Written out rather than imported: this is what the resident flows read.
  const RESIDENT_FLAGS = ["canViewMaintenance", "canCompleteWalkthroughs", "canViewResourceHub"];
  const STAFF_FLAGS = FLAGS.filter((flag) => !RESIDENT_FLAGS.includes(flag));

  /** The admin is signed in; the account being changed is `target`. */
  function adminChanging(target: typeof ALICE | typeof STAFF) {
    actAs(ADMIN);
    storageMock.getUser.mockImplementation(async (id: string) => (id === ADMIN.id ? ADMIN : id === target.id ? target : undefined));
    storageMock.getUserPermissions.mockResolvedValue(undefined);
    storageMock.upsertUserPermissions.mockImplementation(async (p: unknown) => p);
  }

  it("knows every staff flag the table has", () => {
    expect(STAFF_FLAGS).toEqual(expect.arrayContaining(["canViewProperties", "canManageProperties", "canManageMaintenance"]));
  });

  it.each(STAFF_FLAGS)("refuses %s on a resident account, writing nothing", async (flag) => {
    adminChanging(ALICE);
    const { status, body } = await patch("/api/users/u-alice/permissions", { [flag]: true });
    expect(status).toBe(400);
    expect(body.message).toMatch(/resident/i);
    expect(storageMock.upsertUserPermissions).not.toHaveBeenCalled();
    expect(storageMock.createAuditEvent).not.toHaveBeenCalled();
  });

  it("refuses any region on a resident account, writing nothing", async () => {
    adminChanging(ALICE);
    const { status } = await patch("/api/users/u-alice/permissions", {
      canViewResourceHub: true,
      allowedRegions: ["all"],
    });
    expect(status).toBe(400);
    expect(storageMock.upsertUserPermissions).not.toHaveBeenCalled();
  });

  it.each(RESIDENT_FLAGS)("stores %s on a resident account", async (flag) => {
    adminChanging(ALICE);
    const { status } = await patch("/api/users/u-alice/permissions", { [flag]: true });
    expect(status).toBe(200);
    expect(storageMock.upsertUserPermissions).toHaveBeenCalledWith(expect.objectContaining({ userId: "u-alice", [flag]: true }));
  });

  it("lets a resident's staff flags be switched off and regions cleared", async () => {
    // What the Settings dialog sends for a resident, so a row left over from
    // before the rule can be cleaned up by saving it.
    adminChanging(ALICE);
    const { status } = await patch("/api/users/u-alice/permissions", {
      canViewMaintenance: true,
      canViewProperties: false,
      canManageProperties: false,
      allowedRegions: [],
    });
    expect(status).toBe(200);
    expect(storageMock.upsertUserPermissions).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u-alice", canViewProperties: false, allowedRegions: [] }),
    );
  });

  it("still gives a staff account staff flags and regions", async () => {
    adminChanging(STAFF);
    const { status } = await patch("/api/users/u-staff/permissions", {
      canViewProperties: true,
      allowedRegions: ["West Central"],
    });
    expect(status).toBe(200);
    expect(storageMock.upsertUserPermissions).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u-staff", canViewProperties: true, allowedRegions: ["West Central"] }),
    );
  });

  it("answers 404 for an account that does not exist, writing nothing", async () => {
    adminChanging(ALICE);
    const { status } = await patch("/api/users/u-nobody/permissions", { canViewMaintenance: true });
    expect(status).toBe(404);
    expect(storageMock.upsertUserPermissions).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Every field that names a stored file checks who stored it
// ---------------------------------------------------------------------------

/**
 * A file is served to anyone who can read a record that points at it, so a
 * body naming somebody else's upload -- a vendor's W-9 in a repair's photo
 * field -- hands that file to everyone who can read the record. Comment
 * attachments, bid documents and request photoUrls already refuse that; this
 * holds every other writer to the same rule. An edit that resends the value
 * the record already holds is not a new reference and passes, so editing a
 * colleague's record does not fail over a file they attached.
 */
describe("every field that names a stored file checks the caller stored it", () => {
  const KEY = "0123456789abcdef0123456789abcdef.pdf";
  const FILE = `/uploads/${KEY}`;
  const uploadRow = (uploadedBy: string) => ({
    id: "upload-1",
    storageKey: KEY,
    originalName: "w9.pdf",
    contentType: "application/pdf",
    sizeBytes: 1024,
    uploadedBy,
  });
  const HOUSE = { id: "prop-1", name: "Cleveland House", address: "1 Main St", region: "West Central", ownership: "owned", photoUrl: null };
  const REQUEST_BODY = { title: "Leaky tap", description: "Drips overnight.", category: "plumbing", priority: "medium", location: "Kitchen" };
  const HOUSE_BODY = {
    name: "New House",
    streetAddress: "9 Oak Ave",
    city: "St Paul",
    state: "MN",
    zipCode: "55104",
    region: "West Central",
    chapter: "St Paul",
    ownership: "owned",
  };
  const BILLING = { id: "bill-1", companyName: "Acme", email: "a@acme.test", phone: "555", invoiceCost: "10.00", region: "West Central" };
  const echo = async (...args: unknown[]) => ({ id: "new", ...(args[args.length - 1] as object) });

  interface Writer {
    name: string;
    actor: typeof ADMIN;
    method: "POST" | "PATCH";
    path: string;
    field: string;
    body: (url: string) => Record<string, unknown>;
    write: keyof typeof storageMock;
    /** The stored row for an edit, with the field set to `value`. */
    existing?: (value: string | null) => void;
    setup?: () => void;
  }

  const writers: Writer[] = [
    {
      name: "a resident's new request, photoUrl",
      actor: ALICE,
      method: "POST",
      path: "/api/maintenance-requests",
      field: "photoUrl",
      body: (url) => ({ ...REQUEST_BODY, photoUrl: url }),
      write: "createMaintenanceRequest",
      setup: () => storageMock.getActiveResidentByEmail.mockResolvedValue({ region: "West Central", buildingAddress: "1 Main St" }),
    },
    {
      name: "a staff request, photoUrl",
      actor: ADMIN,
      method: "POST",
      path: "/api/maintenance-requests",
      field: "photoUrl",
      body: (url) => ({ ...REQUEST_BODY, region: "West Central", buildingAddress: "1 Main St", photoUrl: url }),
      write: "createMaintenanceRequest",
      setup: () => storageMock.getPropertyByAddress.mockResolvedValue(HOUSE),
    },
    {
      name: "a request edit, photoUrl",
      actor: ADMIN,
      method: "PATCH",
      path: "/api/maintenance-requests/req-west",
      field: "photoUrl",
      body: (url) => ({ photoUrl: url }),
      write: "updateMaintenanceRequest",
      existing: (value) => storageMock.getMaintenanceRequest.mockResolvedValue({ ...WEST_REQUEST, buildingAddress: "1 Main St", photoUrl: value }),
    },
    {
      name: "a walkthrough photo, imageUrl",
      actor: ADMIN,
      method: "POST",
      path: "/api/walkthrough-photos",
      field: "imageUrl",
      body: (url) => ({ roomId: "room-1", imageUrl: url, region: "West Central", buildingAddress: "1 Main St", location: "Kitchen", uploadedBy: "x" }),
      write: "createWalkthroughPhoto",
      // The photo's room and walkthrough, for the routes that scope by them.
      setup: () => {
        storageMock.getWalkthroughRoom.mockResolvedValue({ id: "room-1", walkthroughId: "wt-1" });
        storageMock.getWalkthrough.mockResolvedValue({ id: "wt-1", region: "West Central", buildingAddress: "1 Main St", propertyId: "prop-1" });
      },
    },
    {
      name: "a walkthrough photo edit, imageUrl",
      actor: ADMIN,
      method: "PATCH",
      path: "/api/walkthrough-photos/wp-1",
      field: "imageUrl",
      body: (url) => ({ imageUrl: url }),
      write: "updateWalkthroughPhoto",
      existing: (value) =>
        storageMock.getWalkthroughPhoto.mockResolvedValue({ id: "wp-1", roomId: "room-1", imageUrl: value, region: "West Central" }),
    },
    {
      name: "an asset photo, imageUrl",
      actor: ADMIN,
      method: "POST",
      path: "/api/asset-photos",
      field: "imageUrl",
      body: (url) => ({ assetId: "asset-1", imageUrl: url, uploadedBy: "x" }),
      write: "createAssetPhoto",
      setup: () => storageMock.getAsset.mockResolvedValue({ id: "asset-1", region: "West Central" }),
    },
    {
      name: "a new house, photoUrl",
      actor: ADMIN,
      method: "POST",
      path: "/api/properties",
      field: "photoUrl",
      body: (url) => ({ ...HOUSE_BODY, photoUrl: url }),
      write: "createProperty",
      setup: () => storageMock.createPropertySetupItems.mockResolvedValue([]),
    },
    {
      name: "a house edit, photoUrl",
      actor: ADMIN,
      method: "PATCH",
      path: "/api/properties/prop-1",
      field: "photoUrl",
      body: (url) => ({ photoUrl: url }),
      write: "updateProperty",
      existing: (value) => storageMock.getProperty.mockResolvedValue({ ...HOUSE, photoUrl: value }),
    },
    ...(["contractInvoiceUrl", "coiUrl", "w9Url"] as const).flatMap((field): Writer[] => [
      {
        name: `a billing record, ${field}`,
        actor: ADMIN,
        method: "POST",
        path: "/api/billing",
        field,
        body: (url) => ({ ...BILLING, id: undefined, [field]: url }),
        write: "createBillingRecord",
      },
      {
        name: `a billing record edit, ${field}`,
        actor: ADMIN,
        method: "PATCH",
        path: "/api/billing/bill-1",
        field,
        body: (url) => ({ [field]: url }),
        write: "updateBillingRecord",
        existing: (value) => storageMock.getBillingRecord.mockResolvedValue({ ...BILLING, [field]: value }),
      },
    ]),
  ];

  const send = (w: Writer, url: string) => request(w.method, w.path, { body: w.body(url) });
  const arrange = (w: Writer, existingValue: string | null = null) => {
    actAs(w.actor, w.actor === ALICE ? ALL_MAINTENANCE : undefined);
    storageMock[w.write].mockImplementation(echo);
    w.setup?.();
    w.existing?.(existingValue);
  };

  it.each(writers)("$name: refuses a file somebody else stored, and writes nothing", async (w) => {
    arrange(w);
    storageMock.getUploadByStorageKey.mockResolvedValue(uploadRow("u-somebody-else"));
    const { status } = await send(w, FILE);
    expect(status).toBe(400);
    expect(storageMock.getUploadByStorageKey).toHaveBeenCalledWith(KEY);
    expect(storageMock[w.write]).not.toHaveBeenCalled();
  });

  it.each(writers)("$name: refuses a file that was never stored, and writes nothing", async (w) => {
    arrange(w);
    const { status } = await send(w, FILE);
    expect(status).toBe(400);
    expect(storageMock[w.write]).not.toHaveBeenCalled();
  });

  it.each(writers)("$name: refuses a value that is not an uploaded file, and writes nothing", async (w) => {
    arrange(w);
    for (const url of ["javascript:alert(1)", "https://evil.example/w9.pdf", "/uploads/../etc/passwd"]) {
      expect((await send(w, url)).status, url).toBe(400);
    }
    expect(storageMock[w.write]).not.toHaveBeenCalled();
  });

  // Positive control: the same request naming the caller's own upload is
  // written, so every refusal above is the ownership check and not a broken
  // fixture.
  it.each(writers)("$name: stores a file the caller uploaded", async (w) => {
    arrange(w);
    storageMock.getUploadByStorageKey.mockResolvedValue(uploadRow(w.actor.id));
    const { status } = await send(w, FILE);
    expect(status).toBe(200);
    expect(storageMock[w.write]).toHaveBeenCalledWith(...(w.method === "PATCH" ? [expect.anything()] : []), expect.objectContaining({ [w.field]: FILE }));
  });

  it.each(writers.filter((w) => w.existing))("$name: passes the file the record already holds, whoever stored it", async (w) => {
    arrange(w, FILE);
    storageMock.getUploadByStorageKey.mockResolvedValue(uploadRow("u-somebody-else"));
    const { status } = await send(w, FILE);
    expect(status).toBe(200);
    expect(storageMock[w.write]).toHaveBeenCalled();
  });

  // A photo's imageUrl is required, so only the optional document fields clear.
  it.each(writers.filter((w) => w.existing && w.field !== "imageUrl"))("$name: clears the file with null", async (w) => {
    arrange(w, FILE);
    const { status } = await request(w.method, w.path, { body: { [w.field]: null } });
    expect(status).toBe(200);
    expect(storageMock.getUploadByStorageKey).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Guards on deletes and lists that no other test names
//
// Each of these guards could be removed with the whole suite still green
// (pilot-readiness audit, 2026-09-29). Every refusal asserts the write never
// happened, and every refusal is paired with an accepted request proving the
// same spy fires, so a broken fixture cannot pass as a refusal.
// ---------------------------------------------------------------------------

describe("guards on deletes and lists", () => {
  describe("deleting an account is admin work", () => {
    it.each([
      ["a regional administrator holding every region", STAFF, { canManageUsers: true, allowedRegions: ["all"] }],
      ["a resident", ALICE, ALL_MAINTENANCE],
    ])("refuses %s, and deletes nothing", async (_who, user, permissions) => {
      actAs(user, permissions);
      const { status } = await request("DELETE", `/api/users/${BOB.id}`);
      expect(status).toBe(403);
      expect(storageMock.deleteUser).not.toHaveBeenCalled();
    });

    it("lets an admin with no permissions row delete the account", async () => {
      actAs(ADMIN);
      const { status } = await request("DELETE", `/api/users/${BOB.id}`);
      expect(status).toBe(200);
      expect(storageMock.deleteUser).toHaveBeenCalledWith(BOB.id);
    });
  });

  describe("region scoping on deletes", () => {
    const rows = [
      { name: "an asset", path: "/api/assets/rec-1", flag: "canManageAssets", load: "getAsset", write: "deleteAsset" },
      { name: "a maintenance schedule", path: "/api/maintenance-schedules/rec-1", flag: "canManageMaintenance", load: "getMaintenanceSchedule", write: "deleteMaintenanceSchedule" },
      { name: "an HH-fee payment", path: "/api/rent-payments/rec-1", flag: "canManageFinancials", load: "getRentPayment", write: "deleteRentPayment" },
      { name: "a security deposit", path: "/api/security-deposits/rec-1", flag: "canManageFinancials", load: "getSecurityDeposit", write: "deleteSecurityDeposit" },
      { name: "a contact", path: "/api/contacts/rec-1", flag: "canManageContacts", load: "getMaintenanceContact", write: "deleteMaintenanceContact" },
    ];

    const arrange = (row: (typeof rows)[number], recordRegion: string) => {
      actAs(STAFF, { [row.flag]: true, allowedRegions: ["West Central"] });
      storageMock[row.load].mockResolvedValue({ id: "rec-1", region: recordRegion, buildingAddress: "1 Main St" });
      // deleteAsset hands back the file URLs its rows held.
      storageMock[row.write].mockResolvedValue([]);
    };

    it.each(rows)("$name: refuses staff outside the record's region, and deletes nothing", async (row) => {
      arrange(row, "East Central");
      const { status } = await request("DELETE", row.path);
      expect(status).toBe(403);
      expect(storageMock[row.write]).not.toHaveBeenCalled();
    });

    it.each(rows)("$name: deletes for staff in the record's region", async (row) => {
      arrange(row, "West Central");
      const { status } = await request("DELETE", row.path);
      expect(status).toBe(200);
      expect(storageMock[row.write]).toHaveBeenCalledWith("rec-1");
    });
  });

  describe("the resident roster is scoped by region", () => {
    const WEST_RESIDENT = { id: "res-west", firstName: "Ann", region: "West Central", buildingAddress: "1 Main St" };
    const EAST_RESIDENT = { id: "res-east", firstName: "Ben", region: "East Central", buildingAddress: "2 River Rd" };

    it("gives West-only staff the West rows and none of the East ones", async () => {
      actAs(STAFF, { canViewProperties: true, allowedRegions: ["West Central"] });
      storageMock.getAllResidents.mockResolvedValue([WEST_RESIDENT, EAST_RESIDENT]);
      const { status, body } = await get("/api/residents");
      expect(status).toBe(200);
      expect(body.map((r: { id: string }) => r.id)).toEqual(["res-west"]);
    });

    it("gives staff with no regions an empty roster, never everything", async () => {
      actAs(STAFF, { canViewProperties: true, allowedRegions: [] });
      storageMock.getAllResidents.mockResolvedValue([WEST_RESIDENT, EAST_RESIDENT]);
      const { status, body } = await get("/api/residents");
      expect(status).toBe(200);
      expect(body).toEqual([]);
    });
  });
});
