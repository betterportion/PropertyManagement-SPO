/**
 * The QuickBooks spend sync, with QuickBooks replaced entirely: `npm test`
 * never reaches Intuit and needs no secret.
 *
 * What matters most here is what a failure must NOT do: strand the connection
 * by losing a rotated refresh token, or overwrite the last good figures with
 * nothing. Each of those is asserted as a write that never happened, beside
 * a run where the same write does happen.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";

vi.mock("../db", () => ({ db: {}, pool: {} }));
const { createAuditEvent } = vi.hoisted(() => ({ createAuditEvent: vi.fn() }));
vi.mock("../storage", () => ({ storage: { createAuditEvent } }));

import { decryptToken, encryptToken } from "../quickbooks/crypto";
import { centsForClass, repairSpendByColumn, type ProfitAndLossReport } from "../quickbooks/report";
import { fiscalYearsToSync, syncQuickBooksSpend, type SyncDeps } from "../quickbooksSync";
import { QuickBooksConnectionLostError, QuickBooksRequestError, type QuickBooksApi } from "../quickbooks/api";
import { quickBooksItems } from "../actionItems";
import { readQuickBooksConfigFromEnv, QUICKBOOKS_ENV_VARS } from "../config";
import { scrubDetails } from "../audit";
import type { QuickBooksHealth } from "@shared/quickbooks";

const KEY = randomBytes(32);

// ---------------------------------------------------------------------------
// A Profit and Loss report summarized by class, as QuickBooks shapes it
// ---------------------------------------------------------------------------

const money = (value: string) => ({ value });

/**
 * Two classes (Como = 101, Dinkytown = 102), then Not Specified and Total.
 * "Repairs" (57) is a parent with a sub-account "Plumbing" (58); "Utilities"
 * (60) is an expense that must never count.
 */
function report(como: string, dinky: string): ProfitAndLossReport {
  return {
    Columns: {
      Column: [
        { ColTitle: "", ColType: "Account" },
        { ColTitle: "Como", ColType: "Money", MetaData: [{ Name: "ColKey", Value: "101" }] },
        { ColTitle: "Dinkytown", ColType: "Money", MetaData: [{ Name: "ColKey", Value: "102" }] },
        { ColTitle: "Not Specified", ColType: "Money", MetaData: [{ Name: "ColKey", Value: "0" }] },
        { ColTitle: "Total", ColType: "Money", MetaData: [{ Name: "ColKey", Value: "total" }] },
      ],
    },
    Rows: {
      Row: [
        {
          type: "Section",
          Header: { ColData: [{ value: "Expenses" }] },
          Rows: {
            Row: [
              {
                type: "Section",
                Header: { ColData: [{ value: "Repairs", id: "57" }, money(""), money(""), money(""), money("")] },
                Rows: {
                  Row: [
                    { type: "Data", ColData: [{ value: "Repairs", id: "57" }, money("100.00"), money(""), money(""), money("100.00")] },
                    { type: "Data", ColData: [{ value: "Plumbing", id: "58" }, money("50.25"), money(dinky), money("9.00"), money("59.25")] },
                  ],
                },
                Summary: { ColData: [{ value: "Total Repairs" }, money(como), money(dinky), money("9.00"), money("")] },
              },
              { type: "Data", ColData: [{ value: "Utilities", id: "60" }, money("999.00"), money("999.00"), money(""), money("")] },
            ],
          },
          Summary: { ColData: [{ value: "Total Expenses" }] },
        },
      ],
    },
  };
}

describe("repairSpendByColumn", () => {
  it("totals a chosen parent account once, with its sub-accounts, and ignores the rest", () => {
    const columns = repairSpendByColumn(report("150.25", "1,200.50"), new Set(["57"]));
    expect(columns.map((c) => [c.key, c.cents])).toEqual([
      ["101", 15025],
      ["102", 120050],
      ["0", 900],
      ["total", 0],
    ]);
  });

  it("does not count a chosen sub-account twice when its parent is chosen too", () => {
    const columns = repairSpendByColumn(report("150.25", "1,200.50"), new Set(["57", "58"]));
    expect(centsForClass(columns, "101", "Como")).toBe(15025);
  });

  it("counts a sub-account chosen on its own", () => {
    const columns = repairSpendByColumn(report("150.25", "1,200.50"), new Set(["58"]));
    expect(centsForClass(columns, "101", "Como")).toBe(5025);
  });
});

describe("centsForClass", () => {
  const columns = [
    { key: "101", title: "Como", cents: 500 },
    { key: null, title: "Raven House", cents: 700 },
  ];

  it("matches by QuickBooks id first", () => {
    expect(centsForClass(columns, "101", "renamed")).toBe(500);
  });

  it("falls back to the name only when the report gives no id", () => {
    expect(centsForClass(columns, "999", "raven house ")).toBe(700);
  });

  it("reads a class with no activity in the period as zero spend", () => {
    expect(centsForClass(columns, "555", "Quiet House")).toBe(0);
  });
});

describe("token encryption", () => {
  it("round-trips, and never stores the token in the clear", () => {
    const stored = encryptToken("refresh-abc", KEY);
    expect(stored).not.toContain("refresh-abc");
    expect(decryptToken(stored, KEY)).toBe("refresh-abc");
  });

  it("refuses a value written under another key, or altered", () => {
    const stored = encryptToken("refresh-abc", KEY);
    expect(() => decryptToken(stored, randomBytes(32))).toThrow();
    const [v, iv, tag, body] = stored.split(":");
    const altered = [v, iv, tag, Buffer.from("x" + Buffer.from(body, "base64").toString()).toString("base64")].join(":");
    expect(() => decryptToken(altered, KEY)).toThrow();
  });
});

describe("fiscalYearsToSync", () => {
  it("re-reads the year just ended through July 31", () => {
    expect(fiscalYearsToSync(new Date("2027-07-31T12:00:00Z"))).toEqual([2028, 2027]);
    expect(fiscalYearsToSync(new Date("2027-06-01T00:00:00Z"))).toEqual([2028, 2027]);
  });

  it("reads only the current year from August 1, and on May 31", () => {
    expect(fiscalYearsToSync(new Date("2027-08-01T00:00:00Z"))).toEqual([2028]);
    expect(fiscalYearsToSync(new Date("2027-05-31T23:59:59Z"))).toEqual([2027]);
  });
});

// ---------------------------------------------------------------------------
// The sync
// ---------------------------------------------------------------------------

const COMO = { id: "p-como", name: "Como", region: "Northwest", ownership: "owned" };
const DINKY = { id: "p-dinky", name: "Dinkytown", region: "Northwest", ownership: "owned" };
const UNLINKED = { id: "p-raven", name: "Raven", region: "West Central", ownership: "owned" };
const RENTED = { id: "p-rented", name: "Cleveland", region: "Northwest", ownership: "rented" };

function fakeStorage(overrides: Record<string, unknown> = {}) {
  let integration: Record<string, unknown> = {
    id: "default",
    realmId: "9130",
    encryptedRefreshToken: encryptToken("refresh-old", KEY),
    repairAccountIds: ["57"],
    connectedAt: new Date("2026-09-01T00:00:00Z"),
    ...overrides,
  };
  const calls: string[] = [];
  const storage = {
    getQuickbooksIntegration: vi.fn(async () => integration),
    updateQuickbooksIntegration: vi.fn(async (patch: Record<string, unknown>) => {
      if ("encryptedRefreshToken" in patch) calls.push("store-token");
      integration = { ...integration, ...patch };
      return integration;
    }),
    getAllPropertyQuickbooksLinks: vi.fn(async () => [
      { propertyId: COMO.id, kind: "class", externalId: "101", externalName: "Como", region: COMO.region },
      { propertyId: DINKY.id, kind: "class", externalId: "102", externalName: "Dinkytown", region: DINKY.region },
      // Linked while owned, since become a rental: never written.
      { propertyId: RENTED.id, kind: "class", externalId: "103", externalName: "Cleveland", region: RENTED.region },
    ]),
    getAllProperties: vi.fn(async () => [COMO, DINKY, UNLINKED, RENTED]),
    upsertPropertySpend: vi.fn(async () => undefined),
  };
  return { storage, calls, current: () => integration };
}

function fakeApi(calls: string[], overrides: Partial<QuickBooksApi> = {}): QuickBooksApi {
  return {
    authorizeUrl: vi.fn(),
    exchangeCode: vi.fn(),
    revoke: vi.fn(),
    companyName: vi.fn(),
    listClasses: vi.fn(),
    listExpenseAccounts: vi.fn(),
    refresh: vi.fn(async () => {
      calls.push("refresh");
      return { accessToken: "access-1", refreshToken: "refresh-new", refreshTokenExpiresAt: null };
    }),
    profitAndLossByClass: vi.fn(async () => {
      calls.push("report");
      return report("150.25", "1,200.50");
    }),
    ...overrides,
  };
}

const NOW = new Date("2026-10-01T10:00:00Z");

function deps(storage: ReturnType<typeof fakeStorage>["storage"], api: QuickBooksApi, now = NOW): SyncDeps {
  return { api, tokenKey: KEY, storage: storage as unknown as SyncDeps["storage"], now, actor: null };
}

describe("syncQuickBooksSpend", () => {
  beforeEach(() => createAuditEvent.mockReset());

  it("writes this year's spend for each linked owned house, and nothing for the rest", async () => {
    const { storage, calls } = fakeStorage();
    const result = await syncQuickBooksSpend(deps(storage, fakeApi(calls)));

    expect(result).toEqual({ ok: true, fiscalYears: [2027], housesUpdated: 2, ownedNotLinked: 1 });
    const [rows] = storage.upsertPropertySpend.mock.calls[0] as unknown as [Array<Record<string, unknown>>];
    expect(rows).toEqual([
      { propertyId: "p-como", fiscalYear: 2027, amount: "150.25", region: "Northwest", syncedAt: NOW },
      { propertyId: "p-dinky", fiscalYear: 2027, amount: "1200.50", region: "Northwest", syncedAt: NOW },
    ]);
  });

  it("asks QuickBooks for the fiscal year's own dates", async () => {
    const { storage, calls } = fakeStorage();
    const api = fakeApi(calls);
    await syncQuickBooksSpend(deps(storage, api, new Date("2027-07-31T12:00:00Z")));
    expect(api.profitAndLossByClass).toHaveBeenCalledWith("access-1", "9130", "2027-06-01", "2028-05-31");
    expect(api.profitAndLossByClass).toHaveBeenCalledWith("access-1", "9130", "2026-06-01", "2027-05-31");
  });

  it("stores the rotated refresh token, encrypted, before reading any report", async () => {
    const { storage, calls, current } = fakeStorage();
    await syncQuickBooksSpend(deps(storage, fakeApi(calls)));
    expect(calls.slice(0, 3)).toEqual(["refresh", "store-token", "report"]);
    expect(decryptToken(current().encryptedRefreshToken as string, KEY)).toBe("refresh-new");
  });

  it("keeps the rotated token even when the report then fails, and leaves every figure alone", async () => {
    const { storage, calls, current } = fakeStorage();
    const api = fakeApi(calls, {
      profitAndLossByClass: vi.fn(async () => {
        throw new QuickBooksRequestError("QuickBooks did not answer a request (HTTP 503).");
      }),
    });
    const result = await syncQuickBooksSpend(deps(storage, api));

    expect(result).toEqual({ ok: false, message: "QuickBooks did not answer a request (HTTP 503)." });
    expect(storage.upsertPropertySpend).not.toHaveBeenCalled();
    expect(decryptToken(current().encryptedRefreshToken as string, KEY)).toBe("refresh-new");
    expect(current().lastError).toBe("QuickBooks did not answer a request (HTTP 503).");
    expect(current().lastSuccessAt).toBeUndefined();
  });

  it("writes nothing when the second year's report fails after the first succeeded", async () => {
    const { storage, calls } = fakeStorage();
    let n = 0;
    const api = fakeApi(calls, {
      profitAndLossByClass: vi.fn(async () => {
        if (++n === 2) throw new QuickBooksRequestError("QuickBooks did not answer a request (HTTP 500).");
        return report("1.00", "2.00");
      }),
    });
    await syncQuickBooksSpend(deps(storage, api, new Date("2027-07-01T12:00:00Z")));
    expect(storage.upsertPropertySpend).not.toHaveBeenCalled();
  });

  it("ends the connection when QuickBooks refuses the refresh token, without reading or writing", async () => {
    const { storage, calls, current } = fakeStorage();
    const api = fakeApi(calls, {
      refresh: vi.fn(async () => {
        throw new QuickBooksConnectionLostError("QuickBooks no longer accepts this connection. Reconnect it in Settings.");
      }),
    });
    const result = await syncQuickBooksSpend(deps(storage, api));
    expect(result.ok).toBe(false);
    expect(current().encryptedRefreshToken).toBeNull();
    expect(current().connectedAt).toBeInstanceOf(Date); // kept: this is "lost", not a disconnect
    expect(api.profitAndLossByClass).not.toHaveBeenCalled();
    expect(storage.upsertPropertySpend).not.toHaveBeenCalled();
  });

  it("refuses to run with no repair accounts chosen, before touching QuickBooks", async () => {
    const { storage, calls } = fakeStorage({ repairAccountIds: [] });
    const api = fakeApi(calls);
    const result = await syncQuickBooksSpend(deps(storage, api));
    expect(result.ok).toBe(false);
    expect(api.refresh).not.toHaveBeenCalled();
    expect(storage.upsertPropertySpend).not.toHaveBeenCalled();
  });

  it("does nothing and records nothing when not connected", async () => {
    const { storage, calls } = fakeStorage({ encryptedRefreshToken: null });
    const api = fakeApi(calls);
    expect((await syncQuickBooksSpend(deps(storage, api))).ok).toBe(false);
    expect(api.refresh).not.toHaveBeenCalled();
    expect(storage.updateQuickbooksIntegration).not.toHaveBeenCalled();
  });

  it("writes the same figures on a second run (idempotent)", async () => {
    const { storage, calls } = fakeStorage();
    await syncQuickBooksSpend(deps(storage, fakeApi(calls)));
    await syncQuickBooksSpend(deps(storage, fakeApi(calls)));
    const [first, second] = storage.upsertPropertySpend.mock.calls as unknown as Array<[unknown]>;
    expect(second[0]).toEqual(first[0]);
  });

  it("records one summary per run, with counts only", async () => {
    const { storage, calls } = fakeStorage();
    await syncQuickBooksSpend(deps(storage, fakeApi(calls)));
    expect(createAuditEvent).toHaveBeenCalledTimes(1);
    expect(createAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "quickbooks.sync",
        summary: "QuickBooks sync: updated 2 houses for FY2027; 1 owned house is not linked",
        details: { ok: true, housesUpdated: 2, ownedNotLinked: 1, fiscalYears: [2027] },
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// The admin alert, and configuration
// ---------------------------------------------------------------------------

describe("quickBooksItems", () => {
  const health = (patch: Partial<QuickBooksHealth>): QuickBooksHealth => ({
    configured: true,
    connected: true,
    lost: false,
    connectedAt: "2026-09-01T00:00:00Z",
    lastSuccessAt: "2026-10-01T00:00:00Z",
    lastError: null,
    ...patch,
  });

  it("says nothing while QuickBooks is not set up, or never connected", () => {
    expect(quickBooksItems(health({ configured: false, lost: true }), NOW)).toEqual([]);
    expect(quickBooksItems(health({ connected: false, connectedAt: null }), NOW)).toEqual([]);
  });

  it("says nothing within 36 hours of a good sync", () => {
    expect(quickBooksItems(health({ lastSuccessAt: "2026-09-30T00:00:00Z" }), NOW)).toEqual([]);
  });

  it("raises a stale item past 36 hours, with the last error", () => {
    const [item] = quickBooksItems(health({ lastSuccessAt: "2026-09-29T20:00:00Z", lastError: "HTTP 503" }), NOW);
    expect(item).toMatchObject({ source: "integration", title: "QuickBooks spend is out of date", overdue: true });
    expect(item.subtitle).toContain("HTTP 503");
  });

  it("raises a lost connection straight away", () => {
    const [item] = quickBooksItems(health({ connected: false, lost: true }), NOW);
    expect(item.title).toBe("QuickBooks connection lost");
  });

  it("counts a connection that has never synced from when it was connected", () => {
    expect(quickBooksItems(health({ lastSuccessAt: null, connectedAt: "2026-10-01T00:00:00Z" }), NOW)).toEqual([]);
    expect(quickBooksItems(health({ lastSuccessAt: null, connectedAt: "2026-09-25T00:00:00Z" }), NOW)).toHaveLength(1);
  });
});

describe("readQuickBooksConfigFromEnv", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const name of [...QUICKBOOKS_ENV_VARS, "QUICKBOOKS_ENVIRONMENT"]) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
  });
  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const setAll = () => {
    process.env.QUICKBOOKS_CLIENT_ID = "id";
    process.env.QUICKBOOKS_CLIENT_SECRET = "secret";
    process.env.QUICKBOOKS_REDIRECT_URI = "https://portal.example.org/api/quickbooks/callback";
    process.env.QUICKBOOKS_TOKEN_KEY = "a".repeat(64);
  };

  it("is off, with no problem, when none are set", () => {
    expect(readQuickBooksConfigFromEnv()).toEqual({ configured: false });
  });

  it("is a boot problem naming what is missing when only some are set", () => {
    process.env.QUICKBOOKS_CLIENT_ID = "id";
    const result = readQuickBooksConfigFromEnv();
    expect(result.configured).toBe(false);
    expect(result.problem).toContain("QUICKBOOKS_CLIENT_SECRET");
    expect(result.problem).toContain("QUICKBOOKS_TOKEN_KEY");
  });

  it("refuses a token key that is not 32 bytes of hex", () => {
    setAll();
    process.env.QUICKBOOKS_TOKEN_KEY = "too-short";
    expect(readQuickBooksConfigFromEnv().problem).toContain("QUICKBOOKS_TOKEN_KEY");
  });

  it("is on, for production unless told otherwise, when all four are set", () => {
    setAll();
    const result = readQuickBooksConfigFromEnv();
    expect(result.configured).toBe(true);
    if (result.configured) expect(result.config.environment).toBe("production");
  });
});

describe("scrubDetails and the QuickBooks columns", () => {
  it("redacts anything named like the stored token, so a careless audit call cannot leak it", () => {
    expect(scrubDetails({ encryptedRefreshToken: "v1:x", refreshToken: "r", accessToken: "a", repairAccountIds: ["57"] })).toEqual({
      encryptedRefreshToken: "[redacted]",
      refreshToken: "[redacted]",
      accessToken: "[redacted]",
      repairAccountIds: ["57"],
    });
  });
});
