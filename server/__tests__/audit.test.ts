/**
 * Tests for the audit log helper.
 *
 * Two properties are the whole point of this module and both are easy to break
 * later: it must never record a credential, and it must never fail the request
 * it is recording. Everything here tests the real `server/audit.ts`; only the
 * database write underneath it is replaced.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../db", () => ({ db: {}, pool: {} }));

const { createAuditEvent, deleteExpiredAuditEvents } = vi.hoisted(() => ({
  createAuditEvent: vi.fn(),
  deleteExpiredAuditEvents: vi.fn(),
}));
vi.mock("../storage", () => ({ storage: { createAuditEvent, deleteExpiredAuditEvents } }));

import {
  recordAuditEvent,
  scrubDetails,
  changedFields,
  AUDIT_ACTIONS,
  AUDIT_ACTIONS_KEPT_INDEFINITELY,
  AUDIT_RETENTION_BATCH_SIZE,
  auditRetentionCutoff,
  purgeExpiredAuditEvents,
} from "../audit";
import type { AuthContext } from "../authz";

const ACTOR = {
  userId: "u-admin",
  user: { id: "u-admin", email: "admin@example.com", role: "admin", isActive: true },
  permissions: undefined,
  isAdmin: true,
  isResident: false,
  allowedRegions: [],
} as unknown as AuthContext;

/** Waits for the fire-and-forget write to settle. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(() => {
  createAuditEvent.mockReset();
  createAuditEvent.mockResolvedValue({ id: "evt-1" });
  deleteExpiredAuditEvents.mockReset();
  deleteExpiredAuditEvents.mockResolvedValue(0);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("scrubDetails", () => {
  it("redacts any key whose name looks like a credential", () => {
    const scrubbed = scrubDetails({
      accessToken: "abc123",
      SESSION_SECRET: "shh",
      apiKey: "k",
      api_key: "k",
      password: "hunter2",
      authorization: "Bearer x",
      privateKey: "-----BEGIN",
      region: "West Central",
    }) as Record<string, unknown>;

    expect(scrubbed.accessToken).toBe("[redacted]");
    expect(scrubbed.SESSION_SECRET).toBe("[redacted]");
    expect(scrubbed.apiKey).toBe("[redacted]");
    expect(scrubbed.api_key).toBe("[redacted]");
    expect(scrubbed.password).toBe("[redacted]");
    expect(scrubbed.authorization).toBe("[redacted]");
    expect(scrubbed.privateKey).toBe("[redacted]");
    // Ordinary fields are untouched, or the log would be useless.
    expect(scrubbed.region).toBe("West Central");
  });

  it("redacts raw banking and card fields, which must never be stored at all", () => {
    const scrubbed = scrubDetails({
      accountNumber: "123456789",
      routingNumber: "021000021",
      cardNumber: "4111111111111111",
      cvv: "123",
      iban: "GB33BUKB20201555555555",
      ssn: "000-00-0000",
      amount: "250.00",
    }) as Record<string, unknown>;

    for (const key of ["accountNumber", "routingNumber", "cardNumber", "cvv", "iban", "ssn"]) {
      expect(scrubbed[key]).toBe("[redacted]");
    }
    expect(scrubbed.amount).toBe("250.00");
  });

  it("redacts sensitive keys nested inside objects and arrays", () => {
    const scrubbed = scrubDetails({
      changes: [{ field: "email", token: "leak" }],
      nested: { deeper: { refreshToken: "leak" } },
    }) as any;

    expect(scrubbed.changes[0].field).toBe("email");
    expect(scrubbed.changes[0].token).toBe("[redacted]");
    expect(scrubbed.nested.deeper.refreshToken).toBe("[redacted]");
  });

  it("truncates a long string rather than storing all of it", () => {
    const scrubbed = scrubDetails({ note: "x".repeat(2000) }) as Record<string, string>;
    expect(scrubbed.note.length).toBeLessThan(600);
    expect(scrubbed.note.endsWith("...[truncated]")).toBe(true);
  });

  it("stops descending past a fixed depth", () => {
    const scrubbed = scrubDetails({ a: { b: { c: { d: { e: "deep" } } } } }) as any;
    expect(scrubbed.a.b.c.d).toBe("[omitted]");
  });

  it("passes scalars, dates and null through", () => {
    expect(scrubDetails(null)).toBeNull();
    expect(scrubDetails(undefined)).toBeUndefined();
    expect(scrubDetails(7)).toBe(7);
    expect(scrubDetails(true)).toBe(true);
    expect(scrubDetails(new Date("2026-01-02T03:04:05Z"))).toBe("2026-01-02T03:04:05.000Z");
  });
});

describe("recordAuditEvent", () => {
  it("writes the actor, action and entity", async () => {
    recordAuditEvent(ACTOR, {
      action: AUDIT_ACTIONS.USER_ROLE_CHANGED,
      entityType: "user",
      entityId: "u-someone",
      summary: "Changed a role",
      details: { from: "resident", to: "admin" },
    });
    await flush();

    expect(createAuditEvent).toHaveBeenCalledTimes(1);
    expect(createAuditEvent).toHaveBeenCalledWith({
      actorId: "u-admin",
      actorEmail: "admin@example.com",
      action: "user.role_changed",
      entityType: "user",
      entityId: "u-someone",
      summary: "Changed a role",
      details: { from: "resident", to: "admin" },
    });
  });

  it("scrubs details on the way to the database, not only in the helper", async () => {
    recordAuditEvent(ACTOR, {
      action: AUDIT_ACTIONS.DOCUMENT_UPLOADED,
      entityType: "upload",
      details: { contentType: "application/pdf", uploadToken: "secret-value" },
    });
    await flush();

    const written = createAuditEvent.mock.calls[0][0];
    expect(written.details).toEqual({ contentType: "application/pdf", uploadToken: "[redacted]" });
    expect(JSON.stringify(written)).not.toContain("secret-value");
  });

  it("caps the summary, so a hostile filename cannot write an unbounded row", async () => {
    recordAuditEvent(ACTOR, {
      action: AUDIT_ACTIONS.DOCUMENT_UPLOADED,
      entityType: "upload",
      summary: `Uploaded ${"a".repeat(5000)}.pdf`,
    });
    await flush();

    const { summary } = createAuditEvent.mock.calls[0][0];
    expect(summary.length).toBeLessThan(400);
    expect(summary.endsWith("...[truncated]")).toBe(true);
  });

  it("flattens newlines in a summary, which would otherwise break a log reader", async () => {
    recordAuditEvent(ACTOR, {
      action: AUDIT_ACTIONS.DOCUMENT_UPLOADED,
      entityType: "upload",
      summary: "Uploaded evil\n\nname\r\n.pdf",
    });
    await flush();

    expect(createAuditEvent.mock.calls[0][0].summary).toBe("Uploaded evil name .pdf");
  });

  it("records a system action with no actor", async () => {
    recordAuditEvent(null, { action: AUDIT_ACTIONS.INVOICE_CREATED, entityType: "invoice" });
    await flush();

    const written = createAuditEvent.mock.calls[0][0];
    expect(written.actorId).toBeNull();
    expect(written.actorEmail).toBeNull();
    expect(written.entityId).toBeNull();
    expect(written.details).toBeNull();
  });

  it("never throws, and never rejects, when the write fails", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    createAuditEvent.mockRejectedValue(new Error("database is down"));

    expect(() =>
      recordAuditEvent(ACTOR, { action: AUDIT_ACTIONS.USER_DELETED, entityType: "user" }),
    ).not.toThrow();

    // An unhandled rejection here would take the process down under Node's
    // default behaviour, which is exactly what must not happen.
    await flush();
    expect(logged).toHaveBeenCalled();
  });

  it("returns before the write completes, so a slow log cannot delay a response", () => {
    let settle: (() => void) | undefined;
    createAuditEvent.mockReturnValue(new Promise<void>((resolve) => (settle = resolve)));

    const returned = recordAuditEvent(ACTOR, {
      action: AUDIT_ACTIONS.INVOICE_DELETED,
      entityType: "invoice",
    });

    expect(returned).toBeUndefined();
    settle?.();
  });
});

describe("changedFields", () => {
  it("reports only the fields whose value actually differs", () => {
    const before = { status: "pending", amount: "100", region: "West Central" };
    expect(changedFields(before, { status: "completed", amount: "100" })).toEqual(["status"]);
  });

  it("ignores undefined entries from a partial update", () => {
    expect(changedFields({ a: "1" }, { a: undefined, b: "2" })).toEqual(["b"]);
  });

  it("treats every supplied field as changed when there is no previous record", () => {
    expect(changedFields(undefined, { b: "2", a: "1" })).toEqual(["a", "b"]);
  });

  it("does not report a numeric value re-submitted as a string", () => {
    expect(changedFields({ amount: 100 }, { amount: "100" })).toEqual([]);
  });
});

describe("audit retention", () => {
  it("uses a two-year cutoff", () => {
    expect(auditRetentionCutoff(new Date("2026-08-21T12:34:56.000Z")).toISOString()).toBe(
      "2024-08-21T12:34:56.000Z",
    );
  });

  it("deletes in bounded batches while protecting account and permission history", async () => {
    deleteExpiredAuditEvents.mockResolvedValueOnce(AUDIT_RETENTION_BATCH_SIZE).mockResolvedValueOnce(4);

    await expect(purgeExpiredAuditEvents(new Date("2026-08-21T00:00:00.000Z"))).resolves.toBe(
      AUDIT_RETENTION_BATCH_SIZE + 4,
    );

    expect(deleteExpiredAuditEvents).toHaveBeenCalledTimes(2);
    for (const [cutoff, protectedActions, batchSize] of deleteExpiredAuditEvents.mock.calls) {
      expect(cutoff).toEqual(new Date("2024-08-21T00:00:00.000Z"));
      expect(protectedActions).toEqual(AUDIT_ACTIONS_KEPT_INDEFINITELY);
      expect(batchSize).toBe(AUDIT_RETENTION_BATCH_SIZE);
    }
  });
});
