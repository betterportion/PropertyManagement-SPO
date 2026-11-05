/**
 * The rooms to offer for "Where in the house": the rooms on the house's latest
 * walkthrough that has any, in walkthrough order, each name once. A house never
 * walked gets the national template's rooms instead (Joseph's notes, 2026-11-04).
 *
 * "Latest" is by walkthrough date, the same clock `isCurrentWalkthrough` reads;
 * an undated walkthrough sorts last. A walkthrough started but with no rooms yet
 * is skipped, so starting one never empties the list.
 */
export function roomChoices(
  walkthroughs: readonly { id: string; walkthroughDate?: Date | string | null }[],
  rooms: readonly { walkthroughId?: string | null; name: string; displayOrder?: number | null }[],
  templateRooms: readonly { name: string; displayOrder?: number | null }[],
): string[] {
  const time = (value: Date | string | null | undefined) => {
    const t = value ? new Date(value).getTime() : NaN;
    return Number.isNaN(t) ? Number.MIN_SAFE_INTEGER : t;
  };
  const newestFirst = [...walkthroughs].sort((a, b) => time(b.walkthroughDate) - time(a.walkthroughDate));
  const byOrder = <T extends { displayOrder?: number | null }>(list: readonly T[]) =>
    [...list].sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0));

  for (const walkthrough of newestFirst) {
    const own = rooms.filter((room) => room.walkthroughId === walkthrough.id);
    if (own.length > 0) return Array.from(new Set(byOrder(own).map((room) => room.name)));
  }
  return Array.from(new Set(byOrder(templateRooms).map((room) => room.name)));
}
