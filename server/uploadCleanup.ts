import { storage } from "./storage";
import { isSafeStorageKey, removeUpload } from "./objectStorage";
import { logError } from "./errors";

/**
 * Removes the stored files a deleted record held, once nothing else points at
 * them.
 *
 * Called after the database delete, with the URLs the storage layer's delete
 * returned (the record's own file and any its cascade took). For each file:
 *
 * - **Still referenced elsewhere, it stays.** A URL can be reused -- the same
 *   photo attached to two records -- and removing it would break the record
 *   that still shows it. `findUploadReferences` is the full list of columns
 *   that hold one, so after the delete an empty answer means an orphan.
 * - **Otherwise the object goes, then its `uploads` row.** The row holds the
 *   name the person chose, so it goes too; the object goes first so a failure
 *   never leaves a stored file with no record of what it is.
 *
 * **It never fails the request.** The row is already gone and cannot be put
 * back, so a storage error is logged and the next file is tried. The log
 * carries only the random storage key, never a filename or a person.
 */
export async function removeDeletedRecordFiles(urls: readonly string[]): Promise<void> {
  try {
    for (const url of Array.from(new Set(urls))) {
      if (!url.startsWith("/uploads/")) continue;
      const key = url.slice("/uploads/".length);
      if (!isSafeStorageKey(key)) continue;
      try {
        const references = await storage.findUploadReferences(url);
        if (references.length > 0) continue;
        await removeUpload(key);
        await storage.deleteUpload(key);
      } catch (error) {
        logError(`Failed to remove stored file ${key} after its record was deleted`, error);
      }
    }
  } catch (error) {
    logError("Failed to remove the stored files of a deleted record", error);
  }
}
