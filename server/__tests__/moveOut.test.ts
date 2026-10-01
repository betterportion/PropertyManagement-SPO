/**
 * The move-out reminder: one task per resident per stop date, 30 days ahead,
 * corrected when the date changes, never duplicated -- and its emails, to the
 * resident and the house's regional administrators, once per date.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db", () => ({ db: {}, pool: {} }));
vi.mock("../storage", () => ({ storage: {} }));
const { sendEmail } = vi.hoisted(() => ({ sendEmail: vi.fn(async () => ({ sent: false, reason: "not_configured" })) }));
vi.mock("../email", () => ({ sendEmail }));

import { moveOutKey, planMoveOutTasks, syncMoveOutTasks, MOVE_OUT_NOTICE_DAYS } from "../moveOut";
import { buildActionItems, DEPOSIT_ESCALATE_AFTER_DAYS } from "../actionItems";
import type { Property, Resident, SecurityDeposit, Task } from "@shared/schema";

const NOW = new Date("2027-04-20T15:00:00Z");
const HOUSE = { id: "p1", name: "Como Men's House", address: "981 Como Ave", region: "Northwest", state: "MN" } as Property;

const resident = (patch: Partial<Resident> = {}) =>
  ({
    id: "r1",
    propertyId: "p1",
    firstName: "Rachel",
    lastName: "Bauer",
    email: "rachel@example.org",
    region: "Northwest",
    buildingAddress: "981 Como Ave",
    isActive: true,
    moveInDate: new Date("2026-08-15T00:00:00Z"),
    moveOutDate: new Date("2027-05-20T00:00:00Z"),
    ...patch,
  }) as Resident;

const open = (key: string, id = "t1") => ({ id, sourceKey: key });
const plan = (residents: Resident[], openTasks: { id: string; sourceKey: string }[] = [], done: string[] = [], now = NOW) =>
  planMoveOutTasks(residents, [HOUSE], openTasks, new Set(done), now);

describe("planMoveOutTasks", () => {
  it("creates the reminder exactly 30 days ahead, and not a day before", () => {
    expect(MOVE_OUT_NOTICE_DAYS).toBe(30);
    expect(plan([resident()], [], [], new Date("2027-04-20T00:00:00Z")).create).toHaveLength(1);
    expect(plan([resident()], [], [], new Date("2027-04-19T23:59:59Z")).create).toHaveLength(0);
  });

  it("names the resident, the house and the date", () => {
    const [spec] = plan([resident()]).create;
    expect(spec).toMatchObject({ sourceKey: "move-out:r1:2027-05-20", title: "Rachel Bauer moves out on May 20", region: "Northwest" });
    expect(spec.notes).toContain("Como Men's House");
  });

  it("creates it on the day itself, and never for a date already gone", () => {
    expect(plan([resident()], [], [], new Date("2027-05-20T23:00:00Z")).create).toHaveLength(1);
    expect(plan([resident()], [], [], new Date("2027-05-21T00:00:01Z")).create).toHaveLength(0);
  });

  it("does nothing when the reminder for this date is open (no duplicates)", () => {
    expect(plan([resident()], [open(moveOutKey("r1", "2027-05-20"))])).toEqual({ create: [], move: [], remove: [] });
  });

  it("keeps the open reminder after the date has passed, while the date is unchanged", () => {
    expect(plan([resident()], [open(moveOutKey("r1", "2027-05-20"))], [], new Date("2027-06-10T00:00:00Z"))).toEqual({ create: [], move: [], remove: [] });
  });

  it("does not recreate a reminder the RA already marked done", () => {
    expect(plan([resident()], [], ["move-out:r1:2027-05-20"]).create).toEqual([]);
  });

  it("moves the open reminder when the stop date changes within the window", () => {
    const p = plan([resident({ moveOutDate: new Date("2027-05-10T00:00:00Z") })], [open(moveOutKey("r1", "2027-05-20"))]);
    expect(p.move).toEqual([{ taskId: "t1", spec: expect.objectContaining({ sourceKey: "move-out:r1:2027-05-10" }) }]);
    expect(p.create).toEqual([]);
  });

  it("removes the reminder when the stop date is cleared or moves past the window", () => {
    expect(plan([resident({ moveOutDate: null })], [open(moveOutKey("r1", "2027-05-20"))]).remove).toEqual(["t1"]);
    expect(plan([resident({ moveOutDate: new Date("2027-08-01T00:00:00Z") })], [open(moveOutKey("r1", "2027-05-20"))]).remove).toEqual(["t1"]);
  });

  it("removes a reminder for a resident who is gone, and a second open one for the same resident", () => {
    const p = plan([resident()], [open(moveOutKey("r1", "2027-05-20"), "t1"), open(moveOutKey("r1", "2027-05-20"), "t2"), open(moveOutKey("gone", "2027-05-01"), "t3")]);
    expect(p.remove.sort()).toEqual(["t2", "t3"]);
  });
});

describe("syncMoveOutTasks", () => {
  beforeEach(() => sendEmail.mockClear());

  const person = (id: string, role: string, regions: string[], flags: Record<string, boolean> = { canViewProperties: true }, active = true) => ({
    user: { id, email: `${id}@spo.org`, role, isActive: active },
    permissions: { allowedRegions: regions, ...flags },
  });

  function fakeStorage(tasks: Task[] = []) {
    return {
      getAllResidents: vi.fn(async () => [resident()]),
      getAllProperties: vi.fn(async () => [HOUSE]),
      getAllTasks: vi.fn(async () => tasks),
      createTask: vi.fn(async (t) => t),
      updateTask: vi.fn(async (_id, t) => t),
      deleteTask: vi.fn(async () => undefined),
      getAllUsersWithPermissions: vi.fn(async () => [
        person("ra-nw", "regional_administrator", ["Northwest"]),
        person("ra-ec", "regional_administrator", ["East Central"]),
        person("ra-noflag", "regional_administrator", ["Northwest"], { canViewMaintenance: true }),
        person("ra-gone", "regional_administrator", ["Northwest"], { canViewProperties: true }, false),
        person("admin", "admin", ["all"]),
      ]),
    };
  }

  it("files the reminder and emails the resident and only the house's regional administrators", async () => {
    const storage = fakeStorage();
    expect(await syncMoveOutTasks(NOW, storage as never)).toEqual({ created: 1, moved: 0, removed: 0 });
    expect(storage.createTask).toHaveBeenCalledWith(expect.objectContaining({ sourceKey: "move-out:r1:2027-05-20", category: "property" }));
    expect(sendEmail.mock.calls.map(([m]) => (m as { to: string }).to)).toEqual(["rachel@example.org", "ra-nw@spo.org"]);
  });

  it("sends nothing on the next day's run", async () => {
    const storage = fakeStorage([{ id: "t1", sourceKey: "move-out:r1:2027-05-20", status: "open" } as Task]);
    expect(await syncMoveOutTasks(NOW, storage as never)).toEqual({ created: 0, moved: 0, removed: 0 });
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe("deposit follow-through", () => {
  const left = resident({ isActive: false, moveOutDate: new Date("2027-03-01T00:00:00Z") });
  const deposit = { id: "d1", residentId: "r1", propertyId: "p1", status: "held", amountHeld: "500.00", buildingAddress: "981 Como Ave", region: "Northwest" } as SecurityDeposit;
  const items = (patch: { property?: Partial<Property>; rules?: Array<{ state: string; days: number }>; now?: Date } = {}) =>
    buildActionItems(
      {
        schedules: [],
        rentPayments: [],
        deposits: [deposit],
        deductions: [],
        residents: [left],
        tasks: [],
        properties: [{ ...HOUSE, depositReturnDays: null, ...patch.property } as Property],
        setupItems: [],
        assets: [],
        requests: [],
        depositRules: (patch.rules ?? []).map((r) => ({ ...r, updatedByEmail: null, updatedAt: null })),
      },
      patch.now ?? NOW,
    ).filter((i) => i.source === "deposit");

  it("takes the state's admin-set days when the house has none", () => {
    const [item] = items({ rules: [{ state: "MN", days: 21 }], now: new Date("2027-03-10T00:00:00Z") });
    expect(item.dueDate).toBe(new Date("2027-03-22T00:00:00Z").toISOString());
    expect(item.overdue).toBe(false);
  });

  it("lets the house's own number win over its state's", () => {
    const [item] = items({ property: { depositReturnDays: 10 }, rules: [{ state: "MN", days: 21 }], now: new Date("2027-03-05T00:00:00Z") });
    expect(item.dueDate).toBe(new Date("2027-03-11T00:00:00Z").toISOString());
  });

  it("escalates past the deadline, saying by how much", () => {
    const [item] = items({ rules: [{ state: "MN", days: 21 }] });
    expect(item.title).toBe("Deposit overdue — 29 days past the return deadline");
    expect(item.overdue).toBe(true);
  });

  it("with no deadline anywhere, escalates by days since the move-out, and says no deadline is set", () => {
    // Nine days after a March 1 move-out: under the escalation threshold.
    expect(DEPOSIT_ESCALATE_AFTER_DAYS).toBe(14);
    const fresh = items({ now: new Date("2027-03-10T00:00:00Z") })[0];
    expect(fresh.title).toBe("Deposit to return");
    // April 20: fifty days on.
    const old = items()[0];
    expect(old.title).toBe("Deposit still held 50 days after move-out");
    expect(old.subtitle).toContain("no return deadline set");
  });
});
