/**
 * The email re-link hands an existing account -- admins included -- to the
 * login that presents its email. That is only safe when the identity provider
 * has verified the address, so `recordSignIn` refuses any sign-in whose email
 * the ID token does not mark `email_verified: true`, before any account is
 * looked up, created or changed. The email is also what resident ownership is
 * keyed on (`ownsRecord`), so an unverified one is refused even when no
 * account holds it yet.
 *
 * Every re-link is recorded in the audit log as `user.relinked`, from what
 * `upsertUser` reports it did rather than from a lookup of its own beforehand:
 * two sign-ins racing on one email could otherwise record a re-link that the
 * other one made, or none at all. The storage layer is replaced so a refusal
 * can be shown to write nothing; the audit log is the real one, writing
 * through the replaced `createAuditEvent`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { upsertUser, createAuditEvent, getUser, getUserByEmailInsensitive } = vi.hoisted(() => ({
  upsertUser: vi.fn(),
  createAuditEvent: vi.fn(),
  getUser: vi.fn(),
  getUserByEmailInsensitive: vi.fn(),
}));

vi.mock("../db", () => ({ db: {}, pool: {} }));
// The sign-in looks up only whether an account is waiting for it (invite-only,
// #217); which account a re-link moves is still upsertUser's own answer.
vi.mock("../storage", () => ({ storage: { upsertUser, createAuditEvent, getUser, getUserByEmailInsensitive } }));

import { recordSignIn } from "../auth";
import { AUDIT_ACTIONS_KEPT_INDEFINITELY } from "../audit";

const EXISTING_ADMIN = {
  id: "google-sub-admin",
  email: "jr@spo.org",
  role: "admin",
  isActive: true,
};

const claims = (extra: Record<string, unknown>) => ({
  sub: "google-sub-new",
  email: "jr@spo.org",
  given_name: "Jay",
  ...extra,
});

/** What upsertUser reports when it moved EXISTING_ADMIN to the new identity. */
const relinked = async (data: { id: string }) => ({
  user: { ...EXISTING_ADMIN, ...data },
  relinkedFrom: { id: EXISTING_ADMIN.id, email: EXISTING_ADMIN.email, role: EXISTING_ADMIN.role },
});
/** What upsertUser reports when it wrote the account under the sign-in's own id. */
const notRelinked = async (data: { id: string }) => ({ user: { ...EXISTING_ADMIN, ...data } });

const relinkEvents = () =>
  createAuditEvent.mock.calls.map(([row]) => row).filter((row) => row.action === "user.relinked");

beforeEach(() => {
  upsertUser.mockReset();
  upsertUser.mockImplementation(relinked);
  // EXISTING_ADMIN is the account waiting for jr@spo.org.
  getUser.mockReset().mockResolvedValue(undefined);
  getUserByEmailInsensitive.mockReset().mockResolvedValue(EXISTING_ADMIN);
  createAuditEvent.mockReset();
  createAuditEvent.mockResolvedValue({});
});

describe("sign-in re-links an existing account only for a verified email", () => {
  it("re-links on a verified email and records it in the audit log (positive control)", async () => {
    await recordSignIn(claims({ email_verified: true }), []);

    expect(upsertUser).toHaveBeenCalledTimes(1);
    expect(upsertUser).toHaveBeenCalledWith(
      expect.objectContaining({ id: "google-sub-new", email: "jr@spo.org" }),
    );
    const events = relinkEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorId: null,
      entityType: "user",
      entityId: "google-sub-new",
      details: { previousUserId: "google-sub-admin", role: "admin" },
    });
    expect(events[0].summary).toContain("jr@spo.org");
    // Who holds an account is access history, kept past the two-year purge.
    expect(AUDIT_ACTIONS_KEPT_INDEFINITELY).toContain(events[0].action);
  });

  it("refuses an unverified email that matches another account, and changes nothing", async () => {
    await expect(recordSignIn(claims({ email_verified: false }), [])).rejects.toMatchObject({ status: 403 });

    expect(upsertUser).not.toHaveBeenCalled();
    expect(createAuditEvent).not.toHaveBeenCalled();
  });

  it("treats an absent email_verified claim, or anything but true, as unverified", async () => {
    await expect(recordSignIn(claims({}), [])).rejects.toMatchObject({ status: 403 });
    await expect(recordSignIn(claims({ email_verified: "true" }), [])).rejects.toMatchObject({ status: 403 });

    expect(upsertUser).not.toHaveBeenCalled();
  });

  it("refuses an unverified email even when no account holds it yet", async () => {
    // The email is the key resident ownership reads (case-insensitively), so an
    // unverified one must not become a portal identity at all.
    upsertUser.mockImplementation(notRelinked);

    await expect(recordSignIn(claims({ email_verified: false }), [])).rejects.toMatchObject({ status: 403 });

    expect(upsertUser).not.toHaveBeenCalled();
  });

  it("lets a returning sign-in under the same id through, with no re-link recorded", async () => {
    upsertUser.mockImplementation(notRelinked);
    getUser.mockResolvedValue({ ...EXISTING_ADMIN, id: "google-sub-new" });

    await recordSignIn(claims({ email_verified: true }), []);

    expect(upsertUser).toHaveBeenCalledTimes(1);
    expect(relinkEvents()).toEqual([]);
  });

  // Invite-only (#217, JR 2026-10-01): a first sign-in nobody is waiting for no
  // longer becomes an active resident account.
  it("refuses a first verified sign-in nobody invited, and writes nothing", async () => {
    getUserByEmailInsensitive.mockResolvedValue(undefined);

    await expect(recordSignIn(claims({ email_verified: true }), [])).rejects.toMatchObject({ status: 403, reason: "not_invited" });

    expect(upsertUser).not.toHaveBeenCalled();
    expect(createAuditEvent).not.toHaveBeenCalled();
  });

  it("refuses a sign-in with no email at all when no account is waiting", async () => {
    await expect(recordSignIn({ sub: "google-sub-new" }, [])).rejects.toMatchObject({ reason: "not_invited" });
    expect(upsertUser).not.toHaveBeenCalled();
  });

  it("attaches an invited first sign-in under the invite's own spelling of the address", async () => {
    // The RA's roster had "Jane.Doe@Example.com"; Google sends it lower-cased.
    getUserByEmailInsensitive.mockResolvedValue({ id: "placeholder", email: "Jane.Doe@Example.com", role: "resident", isActive: true });

    await recordSignIn(claims({ email: "jane.doe@example.com", email_verified: true }), []);

    expect(upsertUser).toHaveBeenCalledWith(expect.objectContaining({ id: "google-sub-new", email: "Jane.Doe@Example.com" }));
  });
});

// CLAUDE.md "Login": a claim the provider omits stays `undefined`, never
// `null`. Drizzle's conflict-update skips `undefined` but writes `null`
// through, so a `?? null` mapping would blank every stored name and avatar on
// a sign-in whose token carries no such claims.
describe("sign-in leaves an omitted profile claim undefined, never null", () => {
  const savedFields = () => {
    expect(upsertUser).toHaveBeenCalledTimes(1);
    return upsertUser.mock.calls[0][0] as Record<string, unknown>;
  };

  it("passes a present claim through, under either provider's spelling (positive control)", async () => {
    await recordSignIn(
      { sub: "google-sub-new", email: "jr@spo.org", email_verified: true, given_name: "Jay", family_name: "Arr", picture: "https://example.com/a.png" },
      [],
    );

    expect(savedFields()).toMatchObject({ firstName: "Jay", lastName: "Arr", profileImageUrl: "https://example.com/a.png" });
  });

  it("leaves name and picture undefined when the token has none of them", async () => {
    await recordSignIn({ sub: "google-sub-new", email: "jr@spo.org", email_verified: true }, []);

    const saved = savedFields();
    expect(saved.firstName).toBeUndefined();
    expect(saved.lastName).toBeUndefined();
    expect(saved.profileImageUrl).toBeUndefined();
  });

  it("leaves only the missing claims undefined when some are present", async () => {
    await recordSignIn({ sub: "google-sub-new", email: "jr@spo.org", email_verified: true, given_name: "Jay" }, []);

    const saved = savedFields();
    expect(saved.firstName).toBe("Jay");
    expect(saved.lastName).toBeUndefined();
    expect(saved.profileImageUrl).toBeUndefined();
  });
});
