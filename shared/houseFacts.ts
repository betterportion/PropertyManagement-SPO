import type { PropertyFacts } from "./schema";

/**
 * The vocabulary of the house-facts block, shared by the three places that
 * name its fields: the audit summary on the server, the staff card on the
 * property page, and the household's own view on the resource hub. One list,
 * so "Door code" cannot be "Front door code" on one screen and not another.
 */

export const ACCESS_CODES = [
  { key: "doorCode", stamp: "doorCodeUpdatedAt", label: "Door code" },
  { key: "gateCode", stamp: "gateCodeUpdatedAt", label: "Gate code" },
  { key: "alarmCode", stamp: "alarmCodeUpdatedAt", label: "Alarm code" },
] as const satisfies readonly { key: keyof PropertyFacts; stamp: keyof PropertyFacts; label: string }[];

export type AccessCode = (typeof ACCESS_CODES)[number];

/** The six free-text facts, in the order they read on both screens. */
export const HOUSE_FACT_TEXT_FIELDS = [
  { key: "securityNotes", label: "Security and cameras", hint: "Alarm instructions, where the cameras are, what to do if it goes off." },
  { key: "parkingRules", label: "Parking and towing", hint: "Where to park, where not to, and who tows." },
  { key: "surfaceCare", label: "Surfaces needing care", hint: "The hardwood, the stone counter -- anything that is ruined by the wrong cleaner." },
  { key: "doNots", label: "Things not to do", hint: "Nothing on the walls, no candles, no bikes in the hall." },
  { key: "rubbishDay", label: "Rubbish day", hint: "\"Tuesday, bins out Monday night.\"" },
  { key: "otherNotes", label: "Anything else", hint: "Whatever else the household should know." },
] as const satisfies readonly { key: keyof PropertyFacts; label: string; hint: string }[];

export type HouseFactTextField = (typeof HOUSE_FACT_TEXT_FIELDS)[number];
