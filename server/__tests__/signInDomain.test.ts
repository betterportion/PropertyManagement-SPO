/**
 * OIDC_ALLOWED_DOMAINS: when set, only a Google Workspace account on one of
 * the listed domains may sign in, decided by the ID token's `hd` (hosted
 * domain) claim. Without it the portal relies on the Google consent screen
 * being "Internal"; set to "External", any Google account would arrive as an
 * active resident.
 *
 * The variable is read by server/config.ts at load, so each case stubs the
 * environment and loads the modules fresh. `recordSignIn` is what the login
 * callback runs with the verified claims; the storage layer is replaced so a
 * refusal can be shown to write nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { upsertUser, getUserByEmail } = vi.hoisted(() => ({
  upsertUser: vi.fn(),
  getUserByEmail: vi.fn(),
}));

vi.mock("../db", () => ({ db: {}, pool: {} }));
vi.mock("../storage", () => ({ storage: { upsertUser, getUserByEmail } }));

async function loadAuth(allowedDomains: string | undefined) {
  if (allowedDomains === undefined) {
    delete process.env.OIDC_ALLOWED_DOMAINS;
  } else {
    vi.stubEnv("OIDC_ALLOWED_DOMAINS", allowedDomains);
  }
  vi.resetModules();
  return await import("../auth");
}

const claims = (extra: Record<string, unknown>) => ({
  sub: "google-sub-1",
  email: "jane@spo.org",
  given_name: "Jane",
  // Verified, so every refusal below is the domain check's alone
  // (signInRelink.test.ts covers the email_verified check).
  email_verified: true,
  ...extra,
});

beforeEach(() => {
  upsertUser.mockReset();
  upsertUser.mockResolvedValue({});
  getUserByEmail.mockReset();
  getUserByEmail.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("sign-in restricted to listed Google Workspace domains", () => {
  it("lets anyone the provider vouches for sign in when the variable is unset (today's behaviour)", async () => {
    const { recordSignIn } = await loadAuth(undefined);

    await recordSignIn(claims({ hd: undefined, email: "someone@gmail.com" }));

    expect(upsertUser).toHaveBeenCalledTimes(1);
    expect(upsertUser).toHaveBeenCalledWith(
      expect.objectContaining({ id: "google-sub-1", email: "someone@gmail.com", firstName: "Jane" }),
    );
  });

  it("treats a blank value as unset", async () => {
    const { recordSignIn } = await loadAuth("  ");

    await recordSignIn(claims({}));

    expect(upsertUser).toHaveBeenCalledTimes(1);
  });

  it("lets an account on a listed domain sign in (positive control)", async () => {
    const { recordSignIn } = await loadAuth(" spo.org , Example.EDU ");

    await recordSignIn(claims({ hd: "spo.org" }));
    await recordSignIn(claims({ hd: "example.edu", email: "rick@example.edu" }));

    expect(upsertUser).toHaveBeenCalledTimes(2);
  });

  it("refuses an account on another domain, and writes no user row", async () => {
    const { recordSignIn } = await loadAuth("spo.org");

    await expect(recordSignIn(claims({ hd: "elsewhere.org" }))).rejects.toMatchObject({ status: 403 });

    expect(upsertUser).not.toHaveBeenCalled();
  });

  it("refuses a personal Google account even when its email address is on the domain", async () => {
    // A consumer Google account can be registered with any address, so the
    // email proves nothing; only Workspace accounts carry `hd`.
    const { recordSignIn } = await loadAuth("spo.org");

    await expect(recordSignIn(claims({ email: "jane@spo.org" }))).rejects.toMatchObject({ status: 403 });
    await expect(recordSignIn(claims({ hd: "" }))).rejects.toMatchObject({ status: 403 });

    expect(upsertUser).not.toHaveBeenCalled();
  });
});
