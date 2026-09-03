/**
 * The per-property setup checklist: what has to happen when SPO takes on a
 * house, and where each of those things stands.
 *
 * This is deliberately not `tasks`. That was settled and the reasoning is
 * recorded so it is not relitigated: `tasks` has no property link, so a house
 * would live as an address inside a title string; and `tasks` has no
 * not-applicable state, so insurance on a rented house would have to be marked
 * done when it never happened. `tasks` is recurring calendar work with an
 * owner and a due date. This is one-time per-property state. Different
 * lifecycles, different tables.
 *
 * The item list is fixed in code and the completion rows key off it. If SPO
 * later wants to edit the list themselves this becomes a small config table
 * and the completion rows keep working unchanged — which is why the rows store
 * a key rather than a label.
 *
 * Pure: definitions and stored rows in, counts out. It lives in `shared/`
 * rather than `server/` because the property page, the badge on the property
 * list row, the dashboard action item and the route that validates a write all
 * read the same definitions — and a second copy on the client is exactly how
 * the screen and the server come to disagree about what a house is asked for.
 */
import type { Property } from "./schema";

/** Which houses an item applies to. */
export type SetupOwnership = Property["ownership"];

/**
 * Three states, and the third is the point. An item that does not apply to
 * this house has to be sayable without marking it done — otherwise the record
 * claims work happened that never did.
 */
export const SETUP_ITEM_STATUSES = ["open", "done", "not_applicable"] as const;
export type SetupItemStatus = (typeof SETUP_ITEM_STATUSES)[number];

export interface SetupItemDefinition {
  /** Stable identifier stored on the completion row. Never shown on screen. */
  key: string;
  /** What an RA reads. */
  label: string;
  /** One line of why it matters, for the people who have not done this before. */
  hint: string;
  /** Which kind of house asks for it. */
  appliesTo: SetupOwnership | "both";
}

/**
 * The checklist.
 *
 * The four utilities are separate entries on purpose: one "utilities" checkbox
 * hides which one is missing, and the missing one is exactly what gets
 * forgotten.
 */
export const SETUP_ITEMS: readonly SetupItemDefinition[] = [
  {
    key: "electric",
    label: "Electric account open",
    hint: "In SPO's name, with the billing address set.",
    appliesTo: "both",
  },
  {
    key: "gas",
    label: "Gas account open",
    hint: "In SPO's name, with the billing address set.",
    appliesTo: "both",
  },
  {
    key: "water",
    label: "Water account open",
    hint: "Some cities bill the owner rather than the occupant — check which.",
    appliesTo: "both",
  },
  {
    key: "internet",
    label: "Internet connected",
    hint: "Ordered, installed, and the household knows the password.",
    appliesTo: "both",
  },
  {
    key: "insurance",
    label: "Insurance in place",
    hint: "Mark it not applicable if the rental company carries it.",
    appliesTo: "both",
  },
  {
    key: "lease_on_file",
    label: "Lease saved to Drive and linked here",
    hint: "The portal stores the link, never the document itself.",
    appliesTo: "rented",
  },
  {
    key: "maintenance_portal",
    label: "Maintenance portal and rental company contact recorded",
    hint: "So the next RA can find who to call without asking anyone.",
    appliesTo: "rented",
  },
  {
    key: "responsible_maintenance_person",
    label: "Responsible maintenance person named",
    hint: "The contact SPO calls first for this house.",
    appliesTo: "owned",
  },
  {
    key: "startup_budget",
    label: "Startup budget determined",
    hint: "The operating figure for furnishing and settling the house.",
    appliesTo: "both",
  },
  {
    key: "communicated_to_household",
    label: "Communicated to the household leader and steward",
    hint: "They know what is set up, what is not, and who to ask.",
    appliesTo: "both",
  },
];

/** The items a house of this kind is asked for, in the order above. */
export function setupItemsFor(ownership: SetupOwnership): SetupItemDefinition[] {
  return SETUP_ITEMS.filter((item) => item.appliesTo === "both" || item.appliesTo === ownership);
}

/** The stored side of one item, reduced to what a summary reads. */
export interface SetupCompletionRow {
  itemKey: string;
  status: SetupItemStatus;
}

export interface SetupSummary {
  /**
   * Whether this house has a checklist at all.
   *
   * The checklist is generated on property creation and deliberately not
   * backfilled, so every house predating it has no rows. Those houses are
   * untracked, not incomplete — counting them as "everything open" would light
   * up the dashboard for every existing property on the day this ships, which
   * is the opposite of surfacing what needs attention.
   */
  tracked: boolean;
  total: number;
  open: number;
  done: number;
  notApplicable: number;
  /** True only for a tracked house with nothing left open. */
  complete: boolean;
}

/**
 * Where a house's setup stands.
 *
 * Reads the definitions first and the rows second, so the answer is always
 * about the checklist this house is actually asked for: a row whose item has
 * been retired from the code, or one left over from before the house changed
 * ownership type, is ignored rather than holding the house open forever. An
 * item the definitions ask for with no row yet counts as open.
 */
export function summarizeSetup(
  rows: readonly SetupCompletionRow[],
  ownership: SetupOwnership,
): SetupSummary {
  const definitions = setupItemsFor(ownership);

  // An untracked house reports nothing rather than everything. The flag alone
  // would not be enough: a caller reading `open` without checking `tracked`
  // would still put every pre-existing house on the dashboard, so the counts
  // have to fail closed too.
  if (rows.length === 0) {
    return {
      tracked: false,
      total: definitions.length,
      open: 0,
      done: 0,
      notApplicable: 0,
      complete: false,
    };
  }

  // Last row wins. The table is unique on (property, item) so this should be
  // unreachable, but double-counting a duplicate would misreport the total.
  const byKey = new Map(rows.map((row) => [row.itemKey, row.status]));

  let open = 0;
  let done = 0;
  let notApplicable = 0;
  for (const definition of definitions) {
    switch (byKey.get(definition.key)) {
      case "done":
        done += 1;
        break;
      case "not_applicable":
        notApplicable += 1;
        break;
      default:
        // Both an explicit "open" and an item never written yet.
        open += 1;
    }
  }

  return {
    tracked: true,
    total: definitions.length,
    open,
    done,
    notApplicable,
    complete: open === 0,
  };
}

/**
 * What each state is called on screen.
 *
 * Here rather than in a component because three surfaces show it, and "N/A" in
 * one place and "Not applicable" in another reads as two different things to
 * somebody who is not sure what either means.
 */
export const SETUP_ITEM_STATUS_LABEL: Record<SetupItemStatus, string> = {
  open: "To do",
  done: "Done",
  not_applicable: "Not needed",
};

/**
 * Checklist rows grouped by the house they belong to.
 *
 * Here rather than in each caller: the dashboard aggregate and the badge on
 * the property list row both need it, and two copies of a group-by is two
 * places to get the key wrong.
 */
export function setupRowsByProperty<T extends { propertyId: string }>(
  rows: readonly T[],
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const existing = grouped.get(row.propertyId);
    if (existing) existing.push(row);
    else grouped.set(row.propertyId, [row]);
  }
  return grouped;
}
