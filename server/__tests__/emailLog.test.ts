/**
 * The email log: every automated send's outcome is recorded -- which email,
 * to whom, whether it went and the kind of error -- and never what it said.
 * Recording can never fail a send.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../db", () => ({ db: {}, pool: {} }));
vi.mock("../storage", () => ({ storage: {} }));
const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: sendMock };
  },
}));

import { onEmailOutcome, sendEmail, type EmailOutcomeRecord, type OutboundEmail } from "../email";
import { purgeExpiredEmailLog, summarizeEmailLog, EMAIL_LOG_PURGE_BATCH } from "../emailLog";
import { emailItems } from "../actionItems";
import type { EmailLogEntry } from "@shared/schema";

const MESSAGE: OutboundEmail = { template: "comment", to: "ra@spo.org", subject: "Secret subject", text: "Secret body" };
const recorded: EmailOutcomeRecord[] = [];

beforeEach(() => {
  recorded.length = 0;
  sendMock.mockReset();
  onEmailOutcome((record) => {
    recorded.push(record);
  });
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("EMAIL_FROM", "SPO Housing <housing@spo.org>");
});
afterEach(() => {
  onEmailOutcome(null);
  vi.unstubAllEnvs();
});

describe("recording outcomes", () => {
  it("records a sent email by its template and recipient, and never its subject or body", async () => {
    sendMock.mockResolvedValue({ data: { id: "m1" }, error: null });
    await sendEmail(MESSAGE);
    expect(recorded).toEqual([{ template: "comment", recipient: "ra@spo.org", outcome: "sent", errorClass: null }]);
    expect(JSON.stringify(recorded)).not.toMatch(/Secret/);
  });

  it("records a provider refusal with the kind of error, never its message", async () => {
    sendMock.mockResolvedValue({ data: null, error: { name: "validation_error", message: "Secret detail about the key" } });
    await sendEmail(MESSAGE);
    expect(recorded).toEqual([{ template: "comment", recipient: "ra@spo.org", outcome: "failed", errorClass: "validation_error" }]);
  });

  it("records a thrown error by its name, and anything odd as unknown", async () => {
    sendMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    await sendEmail(MESSAGE);
    sendMock.mockRejectedValueOnce({ name: "not a safe <name>" });
    await sendEmail(MESSAGE);
    expect(recorded.map((r) => r.errorClass)).toEqual(["TypeError", "unknown"]);
  });

  it("records a skipped send while email is not set up", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("EMAIL_FROM", "");
    expect(await sendEmail(MESSAGE)).toEqual({ sent: false, reason: "not_configured" });
    expect(recorded[0].outcome).toBe("not_configured");
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("still sends when recording throws, or rejects", async () => {
    sendMock.mockResolvedValue({ data: { id: "m1" }, error: null });
    onEmailOutcome(() => {
      throw new Error("db down");
    });
    expect(await sendEmail(MESSAGE)).toEqual({ sent: true, id: "m1" });
    onEmailOutcome(async () => {
      throw new Error("db down");
    });
    expect(await sendEmail(MESSAGE)).toEqual({ sent: true, id: "m1" });
  });
});

const entry = (patch: Partial<EmailLogEntry>): EmailLogEntry => ({
  id: Math.random().toString(36),
  template: "comment",
  recipient: "ra@spo.org",
  outcome: "sent",
  errorClass: null,
  createdAt: new Date("2026-10-01T00:00:00Z"),
  ...patch,
});

describe("summarizeEmailLog", () => {
  it("counts each email's outcomes and lists the failures", () => {
    const stats = summarizeEmailLog(
      [
        entry({ outcome: "failed", errorClass: "validation_error" }),
        entry({}),
        entry({ template: "move_out_resident", outcome: "not_configured" }),
      ],
      true,
    );
    expect(stats.byTemplate).toEqual([
      { template: "move_out_resident", label: "Move-out checklist to resident", sent: 0, failed: 0, notConfigured: 1 },
      { template: "comment", label: "New comment on a request", sent: 1, failed: 1, notConfigured: 0 },
    ]);
    expect(stats.recentFailures).toEqual([expect.objectContaining({ template: "comment", errorClass: "validation_error" })]);
  });
});

describe("purgeExpiredEmailLog", () => {
  it("removes entries over a year old, in capped batches until none are left", async () => {
    const deleteEmailLogBefore = vi.fn().mockResolvedValueOnce(EMAIL_LOG_PURGE_BATCH).mockResolvedValueOnce(7);
    const now = new Date("2026-10-01T00:00:00Z");
    expect(await purgeExpiredEmailLog(now, { deleteEmailLogBefore })).toBe(EMAIL_LOG_PURGE_BATCH + 7);
    expect(deleteEmailLogBefore).toHaveBeenCalledTimes(2);
    expect(deleteEmailLogBefore).toHaveBeenCalledWith(new Date("2025-10-01T00:00:00Z"), EMAIL_LOG_PURGE_BATCH);
  });
});

describe("emailItems", () => {
  const NOW = new Date("2026-10-01T00:00:00Z");

  it("raises failed sends, and skipped sends while email is not set up", () => {
    const items = emailItems({ configured: false, failedRecent: 2, notConfiguredRecent: 5, lastFailureAt: NOW.toISOString() }, NOW);
    expect(items.map((i) => [i.id, i.title, i.overdue])).toEqual([
      ["email-failed", "2 emails failed to send this week", true],
      ["email-unconfigured", "Email isn't set up: 5 messages not sent this week", false],
    ]);
  });

  it("says nothing when every send went", () => {
    expect(emailItems({ configured: true, failedRecent: 0, notConfiguredRecent: 0, lastFailureAt: null }, NOW)).toEqual([]);
  });
});
