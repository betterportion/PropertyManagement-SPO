import type { Resident } from "./schema";

/**
 * Who was living in a house on a given date.
 *
 * Somebody who had already moved out is not on the hook for a hole made
 * after they left, and somebody who had not moved in yet is not either. A
 * missing date on either side is not a claim, so it excludes nobody, and an
 * unreadable `on` returns everybody rather than nobody: the screen then shows
 * the whole roster and the RA takes people off, which is the safe failure.
 *
 * In `shared/` because the move-out worksheet decides this in the browser
 * and the server has to agree about it. Pure.
 */
export function residentsActiveOn<T extends Pick<Resident, "moveInDate" | "moveOutDate">>(
  residents: readonly T[],
  on: Date | string | null | undefined,
): T[] {
  const at = on instanceof Date ? on.getTime() : on ? new Date(on).getTime() : NaN;
  if (Number.isNaN(at)) return [...residents];
  return residents.filter((resident) => {
    const movedIn = resident.moveInDate ? new Date(resident.moveInDate).getTime() : null;
    const movedOut = resident.moveOutDate ? new Date(resident.moveOutDate).getTime() : null;
    if (movedIn !== null && !Number.isNaN(movedIn) && movedIn > at) return false;
    if (movedOut !== null && !Number.isNaN(movedOut) && movedOut < at) return false;
    return true;
  });
}
