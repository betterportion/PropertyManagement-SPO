/**
 * The email re-link hands an existing account -- admins included -- to the
 * login that presents its email. That is only safe when the identity provider
 * has verified the address, so `recordSignIn` refuses any sign-in whose email
 * the ID token does not mark `email_verified: true`, before any account is
 * looked up, created or changed. The email is also what resident ownership is
 * keyed on (`ownsRecord`), so an unverified one is refused even when no
 * account holds it yet.
 *
 * Every re-link is recorded in the audit log as `user.relinked`. The storage
 * layer is replaced so a refusal can be shown to write nothing; the audit log
 * is the real one, writing through the replaced `createAuditEvent`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { upsertUser, getUserByEmail, createAuditEvent } = vi.hoisted(() => ({
  upsertUser: vi.fn(),
  getUserByEmail: vi.fn(),
  createAuditEvent: vi.fn(),
}));

vi.mock("../db", () => ({ db: {}, pool: {} }));
vi.mock("../storage", () => ({ storage: { upsertUser, getUserByEmail, createAuditEvent } }));

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

const relinkEvents = () =>
  createAuditEvent.mock.calls.map(([row]) => row).filter((row) => row.action === "user.relinked");

beforeEach(() => {
  upsertUser.mockReset();
  upsertUser.mockImplementation(async (data: { id: string }) => ({ ...EXISTING_ADMIN, ...data }));
  getUserByEmail.mockReset();
  getUserByEmail.mockResolvedValue(EXISTING_ADMIN);
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
    getUserByEmail.mockResolvedValue(undefined);

    await expect(recordSignIn(claims({ email_verified: false }), [])).rejects.toMatchObject({ status: 403 });

    expect(upsertUser).not.toHaveBeenCalled();
  });

  it("lets a returning sign-in under the same id through, with no re-link recorded", async () => {
    getUserByEmail.mockResolvedValue({ ...EXISTING_ADMIN, id: "google-sub-new" });

    await recordSignIn(claims({ email_verified: true }), []);

    expect(upsertUser).toHaveBeenCalledTimes(1);
    expect(relinkEvents()).toEqual([]);
  });

  it("lets a first verified sign-in create its account, with no re-link recorded", async () => {
    getUserByEmail.mockResolvedValue(undefined);

    await recordSignIn(claims({ email_verified: true }), []);

    expect(upsertUser).toHaveBeenCalledTimes(1);
    expect(relinkEvents()).toEqual([]);
  });
});
