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

  const oddIds = [
    ["a plain unknown id", "no-such-request"],
    ["something that looks like SQL", "1%20OR%201%3D1"],
    ["an encoded quote", "%27%3B--"],
    ["a very long id", "x".repeat(500)],
    ["a unicode id", "%F0%9F%92%A5"],
  ];

  it.each(oddIds)("answers %s with 404 rather than failing", async (_label, id) => {
    const { status } = await get(`/api/maintenance-requests/${id}`);
    expect(status).toBe(404);
  });

  it("reports a database failure as a clean 500, not a hung request", async () => {
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

  it("gives an administrator holding no permissions row the same page", async () => {
    actAs(ADMIN, undefined);
    expect((await get("/api/audit-log")).status).toBe(200);
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
    actAs(STAFF, { allowedRegions: ["West Central"] });
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
    actAs(STAFF, { allowedRegions: ["West Central"] });
    storageMock.getResident.mockResolvedValue(EAST_RESIDENT);

    const { status } = await request("POST", "/api/rent-payments", {
      body: { residentId: EAST_RESIDENT.id, period: "2026-08", amount: 500 },
    });

    expect(status).toBe(403);
    expect(storageMock.createRentPayment).not.toHaveBeenCalled();
  });

  it("generates charges only for current residents who lack one, using the given amount", async () => {
    actAs(STAFF, { allowedRegions: ["West Central"] });
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
    actAs(STAFF, { allowedRegions: ["West Central"] });
    storageMock.getProperty.mockResolvedValue(WEST_PROPERTY);
    storageMock.getLatestRentAmountForProperty.mockResolvedValue(undefined);

    const { status } = await request("POST", "/api/rent-payments/generate", {
      body: { propertyId: WEST_PROPERTY.id, period: "2026-08" },
    });

    expect(status).toBe(400);
    expect(storageMock.createRentPayment).not.toHaveBeenCalled();
  });

  it("does not let a rent patch change the resident, house, month or region", async () => {
    actAs(STAFF, { allowedRegions: ["West Central"] });
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
    actAs(STAFF, { allowedRegions: ["West Central"] });
    storageMock.getResident.mockResolvedValue(WEST_RESIDENT);
    storageMock.getSecurityDepositByResident.mockResolvedValue({ id: "dep-existing" });

    const { status } = await request("POST", "/api/security-deposits", {
      body: { residentId: WEST_RESIDENT.id, amountHeld: 300 },
    });

    expect(status).toBe(409);
    expect(storageMock.createSecurityDeposit).not.toHaveBeenCalled();
  });

  it("takes region and property from the resident on a deposit, ignoring the body", async () => {
    actAs(STAFF, { allowedRegions: ["West Central"] });
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
});
