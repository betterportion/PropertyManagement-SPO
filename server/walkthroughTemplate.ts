/**
 * What a new walkthrough starts out containing.
 *
 * Two sources, and which one applies is the whole rule:
 *
 *   - A property's FIRST walkthrough copies the national template, so an RA
 *     starts from a filled-in checklist rather than a blank page.
 *   - Every later walkthrough copies THAT PROPERTY'S most recent one. The
 *     template is a starting point, not a master: once an RA has deleted the
 *     smoke detector this house does not have and added the porch it does,
 *     that shape is what should come back next year.
 *
 * Everything here is pure -- rooms and items in, rooms and items out -- so the
 * cases that actually go wrong (a carried-forward condition, an item ordered
 * by nothing, a source with no rooms) are testable without a database.
 */

/** A room to create, with the items to create inside it. */
export interface PlannedRoom {
  name: string;
  displayOrder: number;
  items: { label: string; displayOrder: number }[];
}

interface SourceRoom {
  id: string;
  name: string;
  displayOrder?: number | null;
}

interface SourceItem {
  roomId: string;
  label: string;
  displayOrder?: number | null;
}

interface TemplateRoom {
  id: string;
  name: string;
  includeByDefault?: boolean | null;
  displayOrder?: number | null;
}

interface TemplateItem {
  templateRoomId: string;
  label: string;
  displayOrder?: number | null;
}

/**
 * Orders by displayOrder, falling back to the given tiebreak so the result is
 * stable. Two rooms sharing an order is not an error -- somebody adding a room
 * by hand will produce it -- but the output still has to be deterministic, or
 * the same walkthrough renders differently on two loads.
 */
function ordered<T>(rows: T[], order: (row: T) => number | null | undefined, tiebreak: (row: T) => string): T[] {
  return [...rows].sort((a, b) => {
    const byOrder = (order(a) ?? 0) - (order(b) ?? 0);
    return byOrder !== 0 ? byOrder : tiebreak(a).localeCompare(tiebreak(b));
  });
}

function assemble<R, I>(
  rooms: R[],
  items: I[],
  roomKey: (room: R) => string,
  roomName: (room: R) => string,
  roomOrder: (room: R) => number | null | undefined,
  itemKey: (item: I) => string,
  itemLabel: (item: I) => string,
  itemOrder: (item: I) => number | null | undefined,
): PlannedRoom[] {
  const byRoom = new Map<string, I[]>();
  for (const item of items) {
    const key = itemKey(item);
    const list = byRoom.get(key);
    if (list) list.push(item);
    else byRoom.set(key, [item]);
  }

  return ordered(rooms, roomOrder, roomName).map((room, roomIndex) => ({
    name: roomName(room),
    // Renumbered from zero rather than copied. A source whose orders have gaps
    // or duplicates -- which hand-editing produces -- must not pass them on.
    displayOrder: roomIndex,
    items: ordered(byRoom.get(roomKey(room)) ?? [], itemOrder, itemLabel).map((item, itemIndex) => ({
      label: itemLabel(item),
      displayOrder: itemIndex,
    })),
  }));
}

/**
 * The structure for a property's first walkthrough: the national template,
 * limited to the rooms marked as standard.
 *
 * A room that is a known type but not standard -- a garage, a porch -- is left
 * out here and added by hand later, which is what `templateRoomItems` is for.
 */
export function planFromTemplate(
  templateRooms: TemplateRoom[],
  templateItems: TemplateItem[],
): PlannedRoom[] {
  const included = templateRooms.filter((room) => room.includeByDefault !== false);
  const includedIds = new Set(included.map((room) => room.id));
  return assemble(
    included,
    templateItems.filter((item) => includedIds.has(item.templateRoomId)),
    (r) => r.id,
    (r) => r.name,
    (r) => r.displayOrder,
    (i) => i.templateRoomId,
    (i) => i.label,
    (i) => i.displayOrder,
  );
}

/**
 * The structure for a repeat walkthrough: last time's rooms and items.
 *
 * Only the labels carry forward. Condition and notes deliberately do NOT --
 * a new walkthrough starts unassessed, and inheriting last year's "damaged"
 * would present a stale judgement as this year's finding. That is the same
 * reason the 0017 backfill refused to turn "unchanged" into a condition.
 */
export function planFromPreviousWalkthrough(
  rooms: SourceRoom[],
  items: SourceItem[],
): PlannedRoom[] {
  return assemble(
    rooms,
    items,
    (r) => r.id,
    (r) => r.name,
    (r) => r.displayOrder,
    (i) => i.roomId,
    (i) => i.label,
    (i) => i.displayOrder,
  );
}

/**
 * The items to prefill when an RA adds a room of a known type.
 *
 * Returns an empty list for a room type nobody has defined items for, which is
 * an empty room rather than an error -- adding a room must always work.
 */
export function templateRoomItems(
  templateRoomId: string,
  templateItems: TemplateItem[],
): { label: string; displayOrder: number }[] {
  return ordered(
    templateItems.filter((item) => item.templateRoomId === templateRoomId),
    (i) => i.displayOrder,
    (i) => i.label,
  ).map((item, index) => ({ label: item.label, displayOrder: index }));
}
