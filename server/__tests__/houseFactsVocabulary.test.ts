/**
 * The house-facts vocabulary (`shared/houseFacts.ts`) and its write schema
 * (`setPropertyFactsSchema` in `shared/schema.ts`).
 *
 * `ACCESS_CODES` and `HOUSE_FACT_TEXT_FIELDS` are the one list the audit
 * summary, the staff card (`HouseFactsCard.tsx`) and the household's own view
 * (`ResourceHub.tsx`) all read from -- so "Door code" cannot be spelled one
 * way on one screen and another way on the second. This pins that the
 * vocabulary's keys are real columns of `propertyFacts` (derived from the
 * table itself, never retyped) and that every code has its stamp column.
 *
 * `setPropertyFactsSchema` is what the PUT route parses `req.body` with
 * before `planHouseFacts` ever sees it (`server/routes.ts`, the house-facts
 * PUT handler); the stamp columns are deliberately absent from it because the
 * server -- not the client -- decides when a code counts as "changed"
 * (`server/houseFacts.ts`).
 */
import { describe, it, expect } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { propertyFacts, setPropertyFactsSchema, ACCESS_CODE_MAX_LENGTH } from "@shared/schema";
import { ACCESS_CODES, HOUSE_FACT_TEXT_FIELDS } from "@shared/houseFacts";
import { AUDIT_ACTIONS } from "@shared/audit";

const FACTS_COLUMNS = Object.keys(getTableColumns(propertyFacts));

/** A body that passes the schema outright, so tests can perturb one field. */
const VALID_BODY = {
  doorCode: "1234",
  gateCode: "5678",
  alarmCode: "9999",
  securityNotes: "Cameras front and back.",
  parkingRules: "Driveway only.",
  surfaceCare: "Hardwood -- no wet mopping.",
  doNots: "Nothing on the walls.",
  rubbishDay: "Tuesday",
  otherNotes: "Recycling is biweekly.",
};

describe("ACCESS_CODES", () => {
  it("names only real columns of property_facts, for both the code and its stamp", () => {
    for (const code of ACCESS_CODES) {
      expect(FACTS_COLUMNS).toContain(code.key);
      expect(FACTS_COLUMNS).toContain(code.stamp);
    }
  });

  it("pairs every code with its own `...UpdatedAt` stamp, never a borrowed one", () => {
    for (const code of ACCESS_CODES) {
      expect(code.stamp).toBe(`${code.key}UpdatedAt`);
    }
  });

  it("gives every code a non-empty, human label -- what the audit summary names", () => {
    for (const code of ACCESS_CODES) {
      expect(code.label.trim().length).toBeGreaterThan(0);
      // A machine key like "doorCode" is not a sentence a resident or an
      // auditor reads; the label must actually be words.
      expect(code.label).toMatch(/[a-z]/i);
    }
  });

  it("lists the three access codes and no more, so the card's grid and the audit vocabulary agree", () => {
    expect(ACCESS_CODES.map((code) => code.key)).toEqual(["doorCode", "gateCode", "alarmCode"]);
  });

  it("is what the audit vocabulary for a code change actually names", () => {
    // The route builds its summary as `${code.label} for ...`; if the audit
    // action this event uses ever moved out from under it, this is the seam
    // that would go quiet first.
    expect(AUDIT_ACTIONS.PROPERTY_ACCESS_CODE_CHANGED).toBeDefined();
  });
});

describe("HOUSE_FACT_TEXT_FIELDS", () => {
  it("names only real columns of property_facts", () => {
    for (const field of HOUSE_FACT_TEXT_FIELDS) {
      expect(FACTS_COLUMNS).toContain(field.key);
    }
  });

  it("gives every field a non-empty label and a non-empty hint", () => {
    for (const field of HOUSE_FACT_TEXT_FIELDS) {
      expect(field.label.trim().length).toBeGreaterThan(0);
      expect(field.hint.trim().length).toBeGreaterThan(0);
    }
  });

  it("lists exactly the six free-text facts, in the order both screens read them", () => {
    expect(HOUSE_FACT_TEXT_FIELDS.map((field) => field.key)).toEqual([
      "securityNotes",
      "parkingRules",
      "surfaceCare",
      "doNots",
      "rubbishDay",
      "otherNotes",
    ]);
  });
});

describe("the vocabulary covers every content column, and nothing beyond it", () => {
  it("has no overlap between the codes and the text fields", () => {
    const codeKeys = new Set(ACCESS_CODES.map((code) => code.key));
    const textKeys = new Set(HOUSE_FACT_TEXT_FIELDS.map((field) => field.key));
    for (const key of textKeys) {
      expect(codeKeys.has(key)).toBe(false);
    }
  });

  it("together account for every schema-writable column of property_facts", () => {
    // id, propertyId, the three stamps, createdAt and updatedAt are the seven
    // columns the vocabulary does not (and must not) speak for.
    const NOT_CONTENT = new Set([
      "id",
      "propertyId",
      "doorCodeUpdatedAt",
      "gateCodeUpdatedAt",
      "alarmCodeUpdatedAt",
      "createdAt",
      "updatedAt",
    ]);
    const vocabularyKeys = new Set([
      ...ACCESS_CODES.map((code) => code.key),
      ...HOUSE_FACT_TEXT_FIELDS.map((field) => field.key),
    ]);
    const expectedContentColumns = FACTS_COLUMNS.filter((column) => !NOT_CONTENT.has(column));
    expect([...vocabularyKeys].sort()).toEqual([...expectedContentColumns].sort());
  });
});

describe("setPropertyFactsSchema", () => {
  it("accepts a fully-populated, valid body", () => {
    expect(() => setPropertyFactsSchema.parse(VALID_BODY)).not.toThrow();
  });

  it("turns a blank string into null for every field -- an untouched input sends one", () => {
    const blankBody = Object.fromEntries(Object.keys(VALID_BODY).map((key) => [key, ""]));
    const parsed = setPropertyFactsSchema.parse(blankBody);
    for (const key of Object.keys(VALID_BODY)) {
      expect(parsed[key as keyof typeof parsed]).toBeNull();
    }
  });

  it("rejects a code one character over the limit", () => {
    const tooLong = "a".repeat(ACCESS_CODE_MAX_LENGTH + 1);
    for (const field of ["doorCode", "gateCode", "alarmCode"] as const) {
      const result = setPropertyFactsSchema.safeParse({ ...VALID_BODY, [field]: tooLong });
      expect(result.success).toBe(false);
    }
  });

  it("accepts a code exactly at the limit", () => {
    const atLimit = "a".repeat(ACCESS_CODE_MAX_LENGTH);
    const result = setPropertyFactsSchema.safeParse({ ...VALID_BODY, doorCode: atLimit });
    expect(result.success).toBe(true);
  });

  it("rejects a text field one character over its 4,000 character limit", () => {
    const tooLong = "a".repeat(4001);
    for (const field of HOUSE_FACT_TEXT_FIELDS.map((f) => f.key)) {
      const result = setPropertyFactsSchema.safeParse({ ...VALID_BODY, [field]: tooLong });
      expect(result.success).toBe(false);
    }
  });

  it("accepts a text field exactly at its 4,000 character limit", () => {
    const atLimit = "a".repeat(4000);
    const result = setPropertyFactsSchema.safeParse({ ...VALID_BODY, securityNotes: atLimit });
    expect(result.success).toBe(true);
  });

  it("strips a client-supplied stamp rather than accepting it -- the server, not the client, decides when a code changed", () => {
    // planHouseFacts (server/houseFacts.ts) is the only writer of the stamp
    // columns, and it decides purely from whether the code's VALUE changed.
    // If the schema ever let one of these through, a stale code could be made
    // to look freshly rotated by whoever controls the request body.
    const withStamps = {
      ...VALID_BODY,
      doorCodeUpdatedAt: "2020-01-01T00:00:00.000Z",
      gateCodeUpdatedAt: "2020-01-01T00:00:00.000Z",
      alarmCodeUpdatedAt: "2020-01-01T00:00:00.000Z",
    };
    const parsed = setPropertyFactsSchema.parse(withStamps);
    expect(parsed).not.toHaveProperty("doorCodeUpdatedAt");
    expect(parsed).not.toHaveProperty("gateCodeUpdatedAt");
    expect(parsed).not.toHaveProperty("alarmCodeUpdatedAt");
  });
});
