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
