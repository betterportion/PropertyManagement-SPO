/**
 * One house's account-limit check and the write it guards, one request at a
 * time (#313). Without it, two grants for a house with three places taken
 * could each count three and each write, leaving five.
 *
 * shortcut: an in-process lock, which holds because production runs exactly
 * one instance (docs/PRODUCTION_MIGRATION.md, "Run exactly one instance"),
 * as the upload ceiling and the sync guards already assume. Move to a
 * transaction that locks the house's row if the service ever runs two.
 */
const tails = new Map<string, Promise<unknown>>();

/** Runs `work` after any earlier work on the same house has finished. A null house runs at once. */
export async function withHouseLock<T>(propertyId: string | null | undefined, work: () => Promise<T>): Promise<T> {
  if (!propertyId) return work();
  // The tail never rejects (it swallows failures below), so a failure does not stop the next in line.
  const run = (tails.get(propertyId) ?? Promise.resolve()).then(work);
  const tail = run.then(() => undefined, () => undefined);
  tails.set(propertyId, tail);
  try {
    return await run;
  } finally {
    if (tails.get(propertyId) === tail) tails.delete(propertyId);
  }
}
