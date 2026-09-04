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
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import express from "express";
import { Readable } from "node:stream";
import type { Server } from "node:http";

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

// The real isAuthenticated and getUserId are kept. Only setupAuth is replaced,
// because it performs OIDC discovery against a live identity provider.
vi.mock("../auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth")>();
  return { ...actual, setupAuth: vi.fn().mockResolvedValue(undefined) };
});

import { registerRoutes } from "../routes";
import { errorHandler } from "../errors";

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
  for (const fn of storageFns.values()) fn.mockReset();
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

  it("refuses a household leader posting, and writes nothing, until resident posting lands", async () => {
    leaderOfHouseA();
    storageMock.getMaintenanceRequest.mockResolvedValue(OWN_HOUSE_OPEN);
    const { status } = await post("/api/maintenance-requests/req-own-open/comments", { body: "Still leaking.", isInternal: false });
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

  // -- deleting ---------------------------------------------------------------

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

    const { status } = await request("POST", "/api/maintenance-requests", {
      body: { ...body, region: "East Central", buildingAddress: "9 Elm" },
    });

    expect(status).toBe(403);
    expect(storageMock.createMaintenanceRequest).not.toHaveBeenCalled();
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
    expect(recordedEvent()).toMatchObject({
      action: "user.role_changed",
      entityType: "user",
      entityId: "u-alice",
      actorId: ADMIN.id,
      actorEmail: ADMIN.email,
      details: { from: "resident", to: "regional_administrator" },
    });
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

  it("still performs the change when the lookup done for the log fails", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    actAs(ADMIN);
    // The second getUser call is the one made purely to put an email in the
    // summary. It must not be able to stop the role change from happening.
    storageMock.getUser.mockResolvedValueOnce(ADMIN).mockRejectedValue(new Error("connection reset"));
    storageMock.updateUserRole.mockResolvedValue({ ...ALICE, role: "admin" });

    const { status } = await patch("/api/users/u-alice/role", { role: "admin" });

    expect(status).toBe(200);
    expect(storageMock.updateUserRole).toHaveBeenCalledWith("u-alice", "admin");
    // Still recorded, just without the email it could not load.
    expect(recordedEvent()).toMatchObject({ action: "user.role_changed", entityId: "u-alice" });
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

  // ── Who may import ────────────────────────────────────────────────────────

  it("refuses an anonymous caller", async () => {
    const { status } = await postRoster("prop-west");
    expect(status).toBe(401);
    expect(storageMock.createResident).not.toHaveBeenCalled();
  });

  it("refuses a resident", async () => {
    actAs(ALICE, ALL_MAINTENANCE);
    storageMock.getProperty.mockResolvedValue(WEST_PROPERTY);
    const { status } = await postRoster("prop-west");
    expect(status).toBe(403);
    expect(storageMock.createResident).not.toHaveBeenCalled();
  });

  it("refuses staff who lack the property permission", async () => {
    actAs(STAFF, { ...ALL_MAINTENANCE, allowedRegions: ["West Central"] });
    storageMock.getProperty.mockResolvedValue(WEST_PROPERTY);
    const { status } = await postRoster("prop-west");
    expect(status).toBe(403);
    expect(storageMock.createResident).not.toHaveBeenCalled();
  });

  it("refuses a house in a region the importer cannot reach", async () => {
    actAs(STAFF, { ...ALL_PROPERTIES, allowedRegions: ["West Central"] });
    storageMock.getProperty.mockResolvedValue(EAST_PROPERTY);
    const { status } = await postRoster("prop-east");
    expect(status).toBe(403);
    expect(storageMock.createResident).not.toHaveBeenCalled();
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
    expect(storageMock.createResident).not.toHaveBeenCalled();
  });

  it("reports a duplicate against the roster as it stands now", async () => {
    actAs(STAFF, { ...ALL_PROPERTIES, allowedRegions: ["West Central"] });
    storageMock.getProperty.mockResolvedValue(WEST_PROPERTY);
    storageMock.getResidentsByProperty.mockResolvedValue([{ email: "ada@spo.org" }]);

    const { body } = await postRoster("prop-west");

    expect(body.counts).toEqual({ create: 1, duplicate: 1, error: 0 });
    expect(storageMock.createResident).not.toHaveBeenCalled();
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
    expect(storageMock.createResident).not.toHaveBeenCalled();
  });

  // ── Confirm re-derives rather than trusting the client ────────────────────

  it("creates the confirmed rows against the property from the URL", async () => {
    actAs(STAFF, { ...ALL_PROPERTIES, allowedRegions: ["West Central"] });
    storageMock.getProperty.mockResolvedValue(WEST_PROPERTY);
    storageMock.getResidentsByProperty.mockResolvedValue([]);
    storageMock.createResident.mockImplementation(async (r: Record<string, unknown>) => ({ id: "res-new", ...r }));

    const { status, body } = await confirm("prop-west", [
      { firstName: "Ada", lastName: "Lovelace", email: "ada@spo.org" },
    ]);

    expect(status).toBe(200);
    expect(body.created).toBe(1);
    expect(storageMock.createResident).toHaveBeenCalledWith(
      expect.objectContaining({
        propertyId: "prop-west",
        email: "ada@spo.org",
        region: "West Central",
        buildingAddress: "1 Main St",
      }),
    );
  });

  it("takes region and house from the property, not from the caller", async () => {
    // A client that echoes an edited preview back must not be able to file
    // somebody into a region the importer cannot reach.
    actAs(STAFF, { ...ALL_PROPERTIES, allowedRegions: ["West Central"] });
    storageMock.getProperty.mockResolvedValue(WEST_PROPERTY);
    storageMock.getResidentsByProperty.mockResolvedValue([]);
    storageMock.createResident.mockImplementation(async (r: Record<string, unknown>) => ({ id: "res-new", ...r }));

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

    expect(storageMock.createResident).toHaveBeenCalledWith(
      expect.objectContaining({ propertyId: "prop-west", region: "West Central", buildingAddress: "1 Main St" }),
    );
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
    expect(storageMock.createResident).not.toHaveBeenCalled();
  });

  it("refuses a confirm for a house in another region", async () => {
    actAs(STAFF, { ...ALL_PROPERTIES, allowedRegions: ["West Central"] });
    storageMock.getProperty.mockResolvedValue(EAST_PROPERTY);

    const { status } = await confirm("prop-east", [
      { firstName: "Ada", lastName: "Lovelace", email: "ada@spo.org" },
    ]);

    expect(status).toBe(403);
    expect(storageMock.createResident).not.toHaveBeenCalled();
  });

  it("refuses a confirm carrying a row that is not usable", async () => {
    actAs(STAFF, { ...ALL_PROPERTIES, allowedRegions: ["West Central"] });
    storageMock.getProperty.mockResolvedValue(WEST_PROPERTY);
    storageMock.getResidentsByProperty.mockResolvedValue([]);

    const { status } = await confirm("prop-west", [
      { firstName: "Ada", lastName: "Lovelace", email: "not-an-email" },
    ]);

    expect(status).toBe(400);
    expect(storageMock.createResident).not.toHaveBeenCalled();
  });

  it("refuses a property that does not exist", async () => {
    actAs(STAFF, { ...ALL_PROPERTIES, allowedRegions: ["West Central"] });
    storageMock.getProperty.mockResolvedValue(undefined);

    const { status } = await confirm("prop-nope", [
      { firstName: "Ada", lastName: "Lovelace", email: "ada@spo.org" },
    ]);

    expect(status).toBe(404);
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

    await request("PATCH", "/api/walkthroughs/wt-west", {
      body: { status: "reviewed", propertyId: "prop-east", region: "East Central", buildingAddress: "2 River Rd" },
    });

    const patch = storageMock.updateWalkthrough.mock.calls[0][1];
    expect(patch).toEqual({ status: "reviewed" });
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

  it("removes an item their house does not have, and adds a room it does", async () => {
    leaderOfHouseA();
    ownHouse();
    storageMock.getWalkthroughRoomsByWalkthrough.mockResolvedValue([ROOM_A]);
    storageMock.getWalkthroughTemplateRoom.mockResolvedValue({ id: "t-bath", name: "Bathroom" });
    storageMock.getAllWalkthroughTemplateItems.mockResolvedValue([]);
    storageMock.createWalkthroughRoom.mockResolvedValue({ id: "room-new", name: "Bathroom" });

    expect((await request("DELETE", "/api/walkthrough-items/item-a")).status).toBe(200);
    expect(storageMock.deleteWalkthroughItem).toHaveBeenCalledWith("item-a");

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
      body: { propertyId: "prop-a", type: "annual", walkthroughDate: "2026-09-02" },
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

  it.each(PRIOR_YEAR_WRITES)("lets staff correct a prior year: %s %s", async (method, path) => {
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
    ["POST", "/api/walkthrough-items"],
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

  it("refuses a date that is not a calendar day", async () => {
    expect((await get("/api/audit-log?from=last-tuesday")).status).toBe(400);
    expect((await get("/api/audit-log?to=2026-13-45x")).status).toBe(400);
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

  it("clears a snooze, keeping the reason as the record of why it was parked", async () => {
    westLead();
    const { status } = await request("DELETE", "/api/assets/asset-west/snooze", {});
    expect(status).toBe(200);
    const [, patch] = storageMock.updateAsset.mock.calls[0];
    expect(patch.snoozedUntil).toBeNull();
    expect(patch).not.toHaveProperty("snoozeReason");
  });
});

describe("asset creation input validation", () => {
  const baseAsset = {
    name: "Fridge",
    category: "Appliance",
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
    storageMock.createWalkthroughPhoto.mockImplementation(async (data: Record<string, unknown>) => ({ id: "photo-1", ...data }));

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
    email: "maria@spo.org",
    region: "West Central",
    buildingAddress: "1 Main St",
    isActive: true,
  };
  const MARIA_LOGIN = { id: "u-maria", email: "maria@spo.org", role: "resident", isActive: true };

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
    );
    expect(storageMock.updateUserActiveStatus).not.toHaveBeenCalled();
  });

  it("deactivates a matching resident login when asked to", async () => {
    actAs(STAFF, { ...ALL_PROPERTIES, allowedRegions: ["West Central"] });
    storageMock.getResident.mockResolvedValue(WEST_RESIDENT);
    storageMock.updateResident.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({ ...WEST_RESIDENT, ...patch }));
    storageMock.getActiveResidentAccountByEmail.mockResolvedValue(MARIA_LOGIN);
    storageMock.updateUserActiveStatus.mockResolvedValue({ ...MARIA_LOGIN, isActive: false });

    const { status, body } = await request("POST", "/api/residents/res-1/move-out", {
      body: { moveOutDate: "2026-05-15", deactivateAccount: true },
    });

    expect(status).toBe(200);
    expect(storageMock.getActiveResidentAccountByEmail).toHaveBeenCalledWith("maria@spo.org");
    expect(storageMock.updateUserActiveStatus).toHaveBeenCalledWith("u-maria", false);
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
    expect(storageMock.updateUserActiveStatus).not.toHaveBeenCalled();
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
    expect(storageMock.updateUserActiveStatus).not.toHaveBeenCalled();
  });

  it("refuses a resident, changing nothing", async () => {
    actAs(ALICE, ALL_MAINTENANCE);

    const { status } = await request("POST", "/api/residents/res-1/move-out", {
      body: { moveOutDate: "2026-05-15", deactivateAccount: true },
    });

    expect(status).toBe(403);
    expect(storageMock.updateResident).not.toHaveBeenCalled();
    expect(storageMock.updateUserActiveStatus).not.toHaveBeenCalled();
  });

  it("tells staff in region whether the resident has an active login", async () => {
    actAs(STAFF, { ...ALL_PROPERTIES, allowedRegions: ["West Central"] });
    storageMock.getResident.mockResolvedValue(WEST_RESIDENT);
    storageMock.getActiveResidentAccountByEmail.mockResolvedValue(MARIA_LOGIN);

    const { status, body } = await get("/api/residents/res-1/account-status");
    expect(status).toBe(200);
    expect(body).toEqual({ hasActiveAccount: true });
  });

  it("hides account status from staff outside the region", async () => {
    actAs(STAFF, { ...ALL_PROPERTIES, allowedRegions: ["East Central"] });
    storageMock.getResident.mockResolvedValue(WEST_RESIDENT);

    const { status } = await get("/api/residents/res-1/account-status");
    expect(status).toBe(403);
    expect(storageMock.getActiveResidentAccountByEmail).not.toHaveBeenCalled();
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
  });

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
      { id: "req-west", location: "Kitchen", category: "Plumbing", buildingAddress: "1 Main St", region: "West Central", status: "completed" },
      { id: "req-west-2", location: "Kitchen", category: "Plumbing", buildingAddress: "1 Main St", region: "West Central", status: "completed" },
      { id: "req-east", location: "Kitchen", category: "Plumbing", buildingAddress: "9 Elm", region: "East Central", status: "completed" },
      { id: "req-east-2", location: "Kitchen", category: "Plumbing", buildingAddress: "9 Elm", region: "East Central", status: "completed" },
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
    storageMock.upsertUser.mockImplementation(async (data: Record<string, unknown>) => ({ id: "u-new", ...data }));

    const { status } = await request("POST", "/api/users", {
      body: { email: "steward@example.com", role: "resident", propertyId: "prop-west" },
    });
    expect(status).toBe(200);
    expect(storageMock.upsertUser).toHaveBeenCalledWith(
      expect.objectContaining({ email: "steward@example.com", propertyId: "prop-west" }),
    );
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
    storageMock.getAllMaintenanceSchedules.mockResolvedValue([]);
    storageMock.getAllRentPayments.mockResolvedValue([
      { id: "rp-w", status: "unpaid", period: "2026-07", amount: "700", buildingAddress: "1 Main St", region: "West Central" },
      { id: "rp-e", status: "unpaid", period: "2026-07", amount: "700", buildingAddress: "9 Elm", region: "East Central" },
    ]);
    storageMock.getAllSecurityDeposits.mockResolvedValue([]);
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

  it("shows an RA a lease renewal in their region but not another region's", async () => {
    actAs(STAFF, WEST);
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
    actAs(STAFF, { canViewFinancials: true, canManageFinancials: true, allowedRegions: ["West Central"] });
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
