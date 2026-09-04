import type { PropertyFacts, PropertyFactsWrite, SetPropertyFacts } from "@shared/schema";
import { ACCESS_CODES, type AccessCode } from "@shared/houseFacts";

/**
 * The access-code rules from ADR-0002, as one pure function.
 *
 * A house's three codes each carry the date they were last changed, and every
 * change to one is audited. Both rules hinge on the same question -- did this
 * code's VALUE change? -- so they are answered once, here, rather than by the
 * route reasoning about each column in turn. The route passes what it has and
 * `now`, and gets back the row to write and the codes to record.
 */

export interface HouseFactsPlan {
  /** The full row to write: the incoming content plus the three stamps. */
  write: PropertyFactsWrite;
  /** The codes whose value changed, in the order above. Never the values. */
  changedCodes: AccessCode[];
}

/**
 * Works out what saving `incoming` over `existing` means for the codes.
 *
 * A stamp moves to `now` only when its code's value changed -- setting one
 * for the first time, changing it, or clearing it all count; re-saving the
 * same code does not. An unchanged code keeps the stamp it had, which for a
 * house with no facts yet is null.
 */
export function planHouseFacts(
  existing: PropertyFacts | undefined,
  incoming: SetPropertyFacts,
  now: Date,
): HouseFactsPlan {
  const changedCodes = ACCESS_CODES.filter(
    (code) => (existing?.[code.key] ?? null) !== (incoming[code.key] ?? null),
  );

  const stamps = Object.fromEntries(
    ACCESS_CODES.map((code) => [
      code.stamp,
      changedCodes.includes(code) ? now : (existing?.[code.stamp] ?? null),
    ]),
  ) as Pick<PropertyFacts, AccessCode["stamp"]>;

  return { write: { ...incoming, ...stamps }, changedCodes };
}
