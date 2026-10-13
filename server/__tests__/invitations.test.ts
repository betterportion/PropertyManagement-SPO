/**
 * The invitation sender (launch readiness 2.3, PROJECT_BRIEF.md): due rows go
 * once, a row that did not go waits for tomorrow, a row whose login ended is
 * dropped, and nothing here can fail the boot. The brief's fixtures, in order.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../db", () => ({ db: {}, pool: {} }));
const { createAuditEvent } = vi.hoisted(() => ({ createAuditEvent: vi.fn() }));
vi.mock("../storage", () => ({ storage: { createAuditEvent } }));
const { logError } = vi.hoisted(() => ({ logError: vi.fn() }));
vi.mock("../errors", async (importOriginal) => ({ ...(await importOriginal<typeof import("../errors")>()), logError }));

import {
  deliverInvitation,
  invitationStillStands,
  selectDueInvitations,
  sendDueInvitations,
  startInvitationJob,
  INVITATION_SEND_INTERVAL_MS,
} from "../invitations";
import { invitationSendAt, invitationState } from "@shared/invitations";
import type { Invitation, Property, User } from "@shared/schema";

const NOW = new Date("2027-08-14T15:00:00Z");
const YESTERDAY = new Date("2027-08-13T12:00:00Z");
const TOMORROW = new Date("2027-08-15T12:00:00Z");

const HOUSE = { id: "p1", name: "Cleveland House", address: "1472 Cleveland Ave N", region: "Northwest" } as Property;
const JANE = { id: "u-jane", email: "jane@example.edu", firstName: "Jane", lastName: "Doe", role: "resident", isActive: true, propertyId: "p1" } as User;

const invitation = (patch: Partial<Invitation> = {}): Invitation => ({
  id: "inv-1",
  userId: "u-jane",
  email: "jane@example.edu",
  propertyId: "p1",
  invitedByName: "Michael Nichols",
  sendAt: YESTERDAY,
  sentAt: null,
  cancelledAt: null,
  createdAt: YESTERDAY,
  ...patch,
});

/** A storage double that keeps state, so a second run sees what the first did. */
function fakeStorage(rows: Invitation[], users: User[] = [JANE]) {
  const table = rows.map((r) => ({ ...r }));
  return {
    table,
    getPendingInvitations: vi.fn(async () => table.filter((r) => !r.sentAt && !r.cancelledAt)),
    getUser: vi.fn(async (id: string) => users.find((u) => u.id === id)),
    getProperty: vi.fn(async (id: string) => (id === HOUSE.id ? HOUSE : undefined)),
    markInvitationSent: vi.fn(async (id: string, at: Date) => {
      const row = table.find((r) => r.id === id);
      if (row) row.sentAt = at;
    }),
    cancelInvitation: vi.fn(async (id: string, at: Date) => {
      const row = table.find((r) => r.id === id);
      if (row) row.cancelledAt = at;
    }),
  };
}

const sent = vi.fn(async () => ({ sent: true as const, id: "m-1" }));
const notConfigured = vi.fn(async () => ({ sent: false as const, reason: "not_configured" as const }));

beforeEach(() => {
  createAuditEvent.mockReset();
  logError.mockReset();
  sent.mockClear();
  notConfigured.mockClear();
});

describe("selectDueInvitations (pure)", () => {
  it("picks sendAt = yesterday with sentAt null, and nothing sent, dropped or still ahead", () => {
    const rows = [
      invitation({ id: "due" }),
      invitation({ id: "sent", sentAt: YESTERDAY }),
      invitation({ id: "dropped", cancelledAt: YESTERDAY }),
      invitation({ id: "tomorrow", sendAt: TOMORROW }),
    ];
    expect(selectDueInvitations(rows, NOW).map((r) => r.id)).toEqual(["due"]);
  });

  it("counts the send moment itself as due, and a second later as not", () => {
    expect(selectDueInvitations([invitation({ sendAt: NOW })], NOW)).toHaveLength(1);
    expect(selectDueInvitations([invitation({ sendAt: new Date(NOW.getTime() + 1_000) })], NOW)).toHaveLength(0);
  });
});

describe("invitationSendAt (pure)", () => {
  it("is now for no day, today, or a day already gone", () => {
    expect(invitationSendAt(undefined, NOW)).toBe(NOW);
    expect(invitationSendAt("2027-08-14", NOW)).toBe(NOW);
    expect(invitationSendAt("2027-01-01", NOW)).toBe(NOW);
  });

  it("is the morning of a later day", () => {
    expect(invitationSendAt("2027-08-15", NOW).toISOString()).toBe("2027-08-15T12:00:00.000Z");
  });

  it("reads back as scheduled, waiting, sent or dropped", () => {
    expect(invitationState(invitation({ sendAt: TOMORROW }), NOW)).toBe("scheduled");
    expect(invitationState(invitation(), NOW)).toBe("waiting");
    expect(invitationState(invitation({ sentAt: NOW }), NOW)).toBe("sent");
    expect(invitationState(invitation({ cancelledAt: NOW }), NOW)).toBe("cancelled");
  });
});

describe("invitationStillStands (pure)", () => {
  it("holds for a switched-on login at the house it was invited to", () => {
    expect(invitationStillStands(invitation(), JANE)).toBe(true);
  });

  it("fails for a login switched off, moved, unlinked or gone", () => {
    expect(invitationStillStands(invitation(), { ...JANE, isActive: false })).toBe(false);
    expect(invitationStillStands(invitation(), { ...JANE, propertyId: "p2" })).toBe(false);
    expect(invitationStillStands(invitation(), { ...JANE, propertyId: null })).toBe(false);
    expect(invitationStillStands(invitation(), undefined)).toBe(false);
  });

  it("holds a staff account to being switched on only", () => {
    const ra = { ...JANE, role: "regional_administrator", propertyId: null } as User;
    expect(invitationStillStands(invitation({ propertyId: null }), ra)).toBe(true);
    expect(invitationStillStands(invitation({ propertyId: null }), { ...ra, isActive: false })).toBe(false);
  });
});

describe("sendDueInvitations", () => {
  it("sendAt = yesterday, sentAt = null → sends it and sets sentAt", async () => {
    const storage = fakeStorage([invitation()]);
    expect(await sendDueInvitations(NOW, storage as never, sent)).toEqual({ sent: 1, cancelled: 0, notSent: 0, failed: 0 });
    const [message] = sent.mock.calls[0] as unknown as [{ to: string; template: string; text: string }];
    expect(message).toMatchObject({ template: "invitation", to: "jane@example.edu" });
    expect(message.text).toContain("Michael Nichols has given you access to the SPO housing portal for\n1472 Cleveland Ave N.");
    expect(storage.table[0].sentAt).toBe(NOW);
    expect(createAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: "invitation.sent", actorId: null, entityId: "u-jane" }));
  });

  it("sendAt = yesterday, sentAt = set → skips it", async () => {
    const storage = fakeStorage([invitation({ sentAt: YESTERDAY })]);
    expect(await sendDueInvitations(NOW, storage as never, sent)).toEqual({ sent: 0, cancelled: 0, notSent: 0, failed: 0 });
    expect(sent).not.toHaveBeenCalled();
  });

  it("sendAt = tomorrow → skips it", async () => {
    const storage = fakeStorage([invitation({ sendAt: TOMORROW })]);
    expect(await sendDueInvitations(NOW, storage as never, sent)).toEqual({ sent: 0, cancelled: 0, notSent: 0, failed: 0 });
    expect(sent).not.toHaveBeenCalled();
    expect(storage.table[0].sentAt).toBeNull();
  });

  it("run twice in one process → the second run sends nothing", async () => {
    const storage = fakeStorage([invitation()]);
    await sendDueInvitations(NOW, storage as never, sent);
    expect(await sendDueInvitations(new Date(NOW.getTime() + 60_000), storage as never, sent)).toEqual({ sent: 0, cancelled: 0, notSent: 0, failed: 0 });
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it("sendEmail returns a failure → sentAt stays null, the run continues, and the next day tries again", async () => {
    const storage = fakeStorage([invitation({ id: "a" }), invitation({ id: "b", userId: "u-jane" })]);
    expect(await sendDueInvitations(NOW, storage as never, notConfigured)).toEqual({ sent: 0, cancelled: 0, notSent: 2, failed: 0 });
    expect(storage.table.map((r) => r.sentAt)).toEqual([null, null]);
    expect(createAuditEvent).not.toHaveBeenCalled();
    // Tomorrow, with email set up, both go.
    expect(await sendDueInvitations(TOMORROW, storage as never, sent)).toMatchObject({ sent: 2 });
  });

  it("a storage failure on one row is logged and the rest still go", async () => {
    const storage = fakeStorage([invitation({ id: "a" }), invitation({ id: "b" })]);
    storage.markInvitationSent.mockImplementationOnce(async () => {
      throw new Error("connection reset");
    });
    expect(await sendDueInvitations(NOW, storage as never, sent)).toEqual({ sent: 1, cancelled: 0, notSent: 0, failed: 1 });
    expect(logError).toHaveBeenCalledWith("Failed to send invitation a", expect.any(Error));
  });

  it("drops, never sends, an invitation whose login was switched off or moved before the day came", async () => {
    const storage = fakeStorage(
      [invitation({ id: "off", userId: "u-off" }), invitation({ id: "moved", userId: "u-moved" }), invitation({ id: "fine" })],
      [JANE, { ...JANE, id: "u-off", isActive: false }, { ...JANE, id: "u-moved", propertyId: "p2" }],
    );
    expect(await sendDueInvitations(NOW, storage as never, sent)).toEqual({ sent: 1, cancelled: 2, notSent: 0, failed: 0 });
    expect(sent.mock.calls).toHaveLength(1);
    expect(storage.table.map((r) => [r.id, !!r.cancelledAt, !!r.sentAt])).toEqual([["off", true, false], ["moved", true, false], ["fine", false, true]]);
    expect(createAuditEvent.mock.calls.map(([e]) => e.action)).toEqual(["invitation.cancelled", "invitation.cancelled", "invitation.sent"]);
  });
});

describe("deliverInvitation from a route", () => {
  it("records who sent it, and names the house", async () => {
    const storage = fakeStorage([invitation()]);
    const actor = { userId: "u-ra", user: { id: "u-ra", email: "ra@spo.org" } } as never;
    expect(await deliverInvitation(invitation(), actor, NOW, storage as never, sent)).toEqual({ outcome: "sent" });
    expect(createAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: "invitation.sent", actorId: "u-ra", summary: "Sent jane@example.edu their invitation to 1472 Cleveland Ave N" }),
    );
  });

  it("reports a send that did not go, with why, and leaves the row for the daily run", async () => {
    const storage = fakeStorage([invitation()]);
    expect(await deliverInvitation(invitation(), null, NOW, storage as never, notConfigured)).toEqual({ outcome: "not_sent", reason: "not_configured" });
    expect(storage.table[0].sentAt).toBeNull();
    expect(storage.table[0].cancelledAt).toBeNull();
  });
});

describe("startInvitationJob never fails the boot", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("a run that rejects is logged and the job keeps its daily rhythm", async () => {
    const run = vi.fn(async () => {
      throw new Error("database down");
    });
    const timer = startInvitationJob(run);
    await vi.advanceTimersByTimeAsync(0);
    expect(logError).toHaveBeenCalledWith("Invitation sending failed", expect.any(Error));
    await vi.advanceTimersByTimeAsync(INVITATION_SEND_INTERVAL_MS);
    expect(run).toHaveBeenCalledTimes(2);
    clearInterval(timer);
  });

  it("a run that throws before returning a promise is logged too", () => {
    const run = vi.fn(() => {
      throw new Error("module failed to load");
    });
    const timer = startInvitationJob(run as never);
    expect(logError).toHaveBeenCalledWith("Failed to start invitation sending", expect.any(Error));
    clearInterval(timer);
  });

  it("runs once at boot and again a day later (positive control)", async () => {
    const run = vi.fn(async () => undefined);
    const timer = startInvitationJob(run);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(INVITATION_SEND_INTERVAL_MS);
    expect(run).toHaveBeenCalledTimes(2);
    expect(logError).not.toHaveBeenCalled();
    clearInterval(timer);
  });
});
