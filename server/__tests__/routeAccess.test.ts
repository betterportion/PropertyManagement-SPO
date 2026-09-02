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

const WEST_REQUEST = {
  id: "req-west",
  title: "Leaky tap",
  region: "West Central",
  submittedBy: ALICE.email,
  status: "pending",
};

const EAST_REQUEST = {
  id: "req-east",
  title: "Broken window",
  region: "East Central",
  submittedBy: BOB.email,
  status: "pending",
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
