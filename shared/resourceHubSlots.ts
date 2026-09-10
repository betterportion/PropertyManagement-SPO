/**
 * The named links on the resource hub.
 *
 * Three documents SPO publishes to every household have a fixed place on the
 * page with a fixed name, so a leader finds "Fire Extinguisher guidelines"
 * where it always is -- and finds the place marked as waiting when SPO has
 * not written the document yet, rather than finding nothing and assuming
 * there is nothing.
 *
 * A link is bound to a slot by `resource_links.slotKey`, never by its title:
 * an admin renaming "Fire extinguisher guide" must not silently empty the
 * slot. One link per slot, and a slotted link is always national -- the
 * slots are what SPO says to every house, not what one region says to its
 * own.
 *
 * In `shared/` because the hub renders the slots and the route validates a
 * write against them, and a second copy of the list is how the screen and
 * the server come to disagree about what the page is waiting on.
 */

export const RESOURCE_HUB_SLOT_KEYS = ["code_of_conduct", "fire_extinguisher", "active_shooter"] as const;

export type ResourceHubSlotKey = (typeof RESOURCE_HUB_SLOT_KEYS)[number];

export interface ResourceHubSlot {
  key: ResourceHubSlotKey;
  /** The name on the page. Fixed here, whatever the bound link is called. */
  label: string;
  /** One line under the name when the slot is empty, saying what is coming. */
  description: string;
}

export const RESOURCE_HUB_SLOTS: readonly ResourceHubSlot[] = [
  {
    key: "code_of_conduct",
    label: "Household Code of Conduct",
    description: "What SPO expects of everybody living in one of its houses.",
  },
  {
    key: "fire_extinguisher",
    label: "Fire Extinguisher guidelines",
    description: "Where the extinguisher is, how to check it and when to use it.",
  },
  {
    key: "active_shooter",
    label: "Active Shooter Policy",
    description: "What to do, in order, if there is an armed intruder.",
  },
];

export function isResourceHubSlotKey(value: unknown): value is ResourceHubSlotKey {
  return typeof value === "string" && (RESOURCE_HUB_SLOT_KEYS as readonly string[]).includes(value);
}

/** The fields of a link the slot rules read. Structural, so the client's row and the server's both fit. */
export interface SlottableLink {
  id?: string;
  title?: string;
  slotKey?: string | null;
  region?: string | null;
  isActive?: boolean;
}

export interface ResolvedHubSlot<T extends SlottableLink> {
  slot: ResourceHubSlot;
  /** The published link bound to it, or null when SPO has not filled it yet. */
  link: T | null;
}

/**
 * Every slot in page order, each with the active link bound to it or null.
 * A hidden link leaves its slot empty: hiding is the admin's way of saying
 * "not this one, for now", and an empty slot is the honest picture of that.
 */
export function resolveHubSlots<T extends SlottableLink>(links: readonly T[]): ResolvedHubSlot<T>[] {
  return RESOURCE_HUB_SLOTS.map((slot) => ({
    slot,
    link: links.find((link) => link.slotKey === slot.key && link.isActive !== false) ?? null,
  }));
}

/** The links that hold no slot -- what the category groups list, so a slotted link is never shown twice. */
export function unslottedLinks<T extends SlottableLink>(links: readonly T[]): T[] {
  return links.filter((link) => !isResourceHubSlotKey(link.slotKey));
}

/**
 * Why a link may not be saved with the slot it names, or null when it may.
 *
 * Checked over the merged row -- the stored link with the edit applied --
 * because an edit sends only the field it changes: narrowing a slotted link
 * to one region arrives as a body with no `slotKey` in it at all.
 */
export function hubSlotProblem(row: SlottableLink, others: readonly SlottableLink[]): string | null {
  if (!isResourceHubSlotKey(row.slotKey)) return null;
  if (row.region) {
    return "A named link is shown to every region, so it cannot be limited to one.";
  }
  const holder = others.find((other) => other.slotKey === row.slotKey && other.id !== row.id);
  if (holder) {
    const slot = RESOURCE_HUB_SLOTS.find((s) => s.key === row.slotKey);
    return `"${holder.title ?? "Another link"}" already holds the ${slot?.label ?? row.slotKey} slot. Clear it there first.`;
  }
  return null;
}
