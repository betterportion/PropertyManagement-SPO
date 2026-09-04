import { describe, it, expect } from "vitest";
import { planHouseFacts } from "../houseFacts";
import type { PropertyFacts, SetPropertyFacts } from "@shared/schema";

/**
 * The stamp-and-audit rule on its own. The route tests prove it reaches
 * storage and the audit log over HTTP; this pins the arithmetic of "did the
 * value change" for every shape a save can take, including the ones a form
 * rarely produces.
 */

const LAST_YEAR = new Date("2025-01-15T00:00:00.000Z");
const NOW = new Date("2026-09-03T12:00:00.000Z");

const EXISTING: PropertyFacts = {
  id: "facts-1",
  propertyId: "prop-1",
  doorCode: "4321",
  doorCodeUpdatedAt: LAST_YEAR,
  gateCode: null,
  gateCodeUpdatedAt: null,
  alarmCode: "9876",
  alarmCodeUpdatedAt: LAST_YEAR,
  securityNotes: null,
  parkingRules: "Driveway only",
  surfaceCare: null,
  doNots: null,
  rubbishDay: "Tuesday",
  otherNotes: null,
  createdAt: LAST_YEAR,
  updatedAt: LAST_YEAR,
};

const SAME: SetPropertyFacts = {
  doorCode: "4321",
  gateCode: null,
  alarmCode: "9876",
  securityNotes: null,
  parkingRules: "Driveway only",
  surfaceCare: null,
  doNots: null,
  rubbishDay: "Tuesday",
  otherNotes: null,
};

describe("planHouseFacts", () => {
  it("changes nothing about the stamps when the same block is saved again", () => {
    const plan = planHouseFacts(EXISTING, SAME, NOW);
    expect(plan.changedCodes).toEqual([]);
    expect(plan.write.doorCodeUpdatedAt).toBe(LAST_YEAR);
    expect(plan.write.alarmCodeUpdatedAt).toBe(LAST_YEAR);
    expect(plan.write.gateCodeUpdatedAt).toBeNull();
  });

  it("stamps only the code that changed and names only that one", () => {
    const plan = planHouseFacts(EXISTING, { ...SAME, doorCode: "5555" }, NOW);
    expect(plan.changedCodes.map((code) => code.label)).toEqual(["Door code"]);
    expect(plan.write.doorCodeUpdatedAt).toBe(NOW);
    expect(plan.write.alarmCodeUpdatedAt).toBe(LAST_YEAR);
  });

  it("counts clearing a code as a change", () => {
    const plan = planHouseFacts(EXISTING, { ...SAME, alarmCode: null }, NOW);
    expect(plan.changedCodes.map((code) => code.key)).toEqual(["alarmCode"]);
    expect(plan.write.alarmCode).toBeNull();
    expect(plan.write.alarmCodeUpdatedAt).toBe(NOW);
  });

  it("counts setting a code for the first time as a change", () => {
    const plan = planHouseFacts(EXISTING, { ...SAME, gateCode: "1234" }, NOW);
    expect(plan.changedCodes.map((code) => code.key)).toEqual(["gateCode"]);
    expect(plan.write.gateCodeUpdatedAt).toBe(NOW);
  });

  it("ignores changes to the text fields", () => {
    const plan = planHouseFacts(EXISTING, { ...SAME, rubbishDay: "Wednesday", parkingRules: null }, NOW);
    expect(plan.changedCodes).toEqual([]);
    expect(plan.write.rubbishDay).toBe("Wednesday");
    expect(plan.write.doorCodeUpdatedAt).toBe(LAST_YEAR);
  });

  it("starts from nothing for a house with no facts yet", () => {
    const plan = planHouseFacts(undefined, { ...SAME, alarmCode: null }, NOW);
    // The door code is being set; the other two stay unset and undated.
    expect(plan.changedCodes.map((code) => code.key)).toEqual(["doorCode"]);
    expect(plan.write.doorCodeUpdatedAt).toBe(NOW);
    expect(plan.write.gateCodeUpdatedAt).toBeNull();
    expect(plan.write.alarmCodeUpdatedAt).toBeNull();
  });

  it("reports the codes in their fixed order however many changed", () => {
    const plan = planHouseFacts(EXISTING, { ...SAME, alarmCode: "1", doorCode: "2", gateCode: "3" }, NOW);
    expect(plan.changedCodes.map((code) => code.label)).toEqual(["Door code", "Gate code", "Alarm code"]);
  });
});
