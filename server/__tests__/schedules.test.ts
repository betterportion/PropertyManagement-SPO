/**
 * Tests for the preventive & safety schedule engine.
 *
 * The two things most likely to break later: the generation job must fire once
 * per due cycle (never spam a fresh request every day for the same overdue
 * task), and safety tasks must come through as safety work. The real
 * server/schedules.ts runs; only the storage underneath it is replaced.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db", () => ({ db: {}, pool: {} }));

const { getDueMaintenanceSchedules, createMaintenanceRequest, markMaintenanceScheduleGenerated } = vi.hoisted(() => ({
  getDueMaintenanceSchedules: vi.fn(),
  createMaintenanceRequest: vi.fn(),
  markMaintenanceScheduleGenerated: vi.fn(),
}));
vi.mock("../storage", () => ({
  storage: { getDueMaintenanceSchedules, createMaintenanceRequest, markMaintenanceScheduleGenerated },
}));

import {
  addMonths,
  needsRequest,
  requestFromSchedule,
  generateDueMaintenanceRequests,
} from "../schedules";
import type { MaintenanceSchedule } from "@shared/schema";

function schedule(overrides: Partial<MaintenanceSchedule> = {}): MaintenanceSchedule {
  return {
    id: "sch-1",
    propertyId: "prop-1",
    assetId: null,
    title: "Fire extinguisher check",
    category: "safety",
    intervalMonths: 12,
    lastCompletedDate: null,
    nextDueDate: new Date("2026-01-01T00:00:00.000Z"),
    lastGeneratedForDue: null,
    notes: null,
    isActive: true,
    region: "East Central",
    buildingAddress: "1 Main St",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("addMonths", () => {
  it("adds whole months", () => {
    expect(addMonths(new Date("2026-01-15T00:00:00Z"), 12).toISOString().slice(0, 10)).toBe("2027-01-15");
    expect(addMonths(new Date("2026-01-15T00:00:00Z"), 3).toISOString().slice(0, 10)).toBe("2026-04-15");
  });

  it("clamps to the last day when the target month is shorter", () => {
    // Jan 31 + 1 month is Feb 28, not a spill into March.
    expect(addMonths(new Date("2026-01-31T00:00:00Z"), 1).toISOString().slice(0, 10)).toBe("2026-02-28");
    expect(addMonths(new Date("2026-03-31T00:00:00Z"), 1).toISOString().slice(0, 10)).toBe("2026-04-30");
  });
});

describe("needsRequest", () => {
  const now = new Date("2026-02-01T00:00:00Z");

  it("is true for an active, due, not-yet-generated schedule", () => {
    expect(needsRequest(schedule({ nextDueDate: new Date("2026-01-20T00:00:00Z") }), now)).toBe(true);
  });

  it("is false for an inactive schedule", () => {
    expect(needsRequest(schedule({ isActive: false, nextDueDate: new Date("2026-01-20T00:00:00Z") }), now)).toBe(false);
  });

  it("is false when the due date is still in the future", () => {
    expect(needsRequest(schedule({ nextDueDate: new Date("2026-03-01T00:00:00Z") }), now)).toBe(false);
  });

  it("is false when a request was already generated for this due date", () => {
    const due = new Date("2026-01-20T00:00:00Z");
    expect(needsRequest(schedule({ nextDueDate: due, lastGeneratedForDue: due }), now)).toBe(false);
  });
});

describe("requestFromSchedule", () => {
  it("maps a safety task to high-priority safety work", () => {
    const req = requestFromSchedule(schedule({ category: "safety", title: "Smoke detectors" }));
    expect(req).toMatchObject({
      title: "Smoke detectors",
      category: "Safety Equipment",
      priority: "high",
      status: "pending",
      submittedBy: "Preventive schedule",
      region: "East Central",
      buildingAddress: "1 Main St",
    });
  });

  it("maps a preventive task to ordinary medium-priority upkeep", () => {
    const req = requestFromSchedule(schedule({ category: "preventive" }));
    expect(req).toMatchObject({ category: "General Maintenance", priority: "medium" });
  });
});

describe("generateDueMaintenanceRequests", () => {
  beforeEach(() => {
    getDueMaintenanceSchedules.mockReset();
    createMaintenanceRequest.mockReset();
    markMaintenanceScheduleGenerated.mockReset();
  });

  it("creates a request for a due schedule and records that it did", async () => {
    const due = new Date("2026-01-20T00:00:00Z");
    getDueMaintenanceSchedules.mockResolvedValue([schedule({ id: "sch-A", nextDueDate: due })]);

    const created = await generateDueMaintenanceRequests(new Date("2026-02-01T00:00:00Z"));

    expect(created).toBe(1);
    expect(createMaintenanceRequest).toHaveBeenCalledTimes(1);
    expect(markMaintenanceScheduleGenerated).toHaveBeenCalledWith("sch-A", due);
  });

  it("does not generate a second request for a schedule that already has one", async () => {
    const due = new Date("2026-01-20T00:00:00Z");
    getDueMaintenanceSchedules.mockResolvedValue([
      schedule({ id: "sch-A", nextDueDate: due, lastGeneratedForDue: due }),
    ]);

    const created = await generateDueMaintenanceRequests(new Date("2026-02-01T00:00:00Z"));

    expect(created).toBe(0);
    expect(createMaintenanceRequest).not.toHaveBeenCalled();
    expect(markMaintenanceScheduleGenerated).not.toHaveBeenCalled();
  });
});
