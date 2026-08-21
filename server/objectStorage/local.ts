import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import type { Readable } from "stream";
import { isSafeStorageKey, type FileStore, type StoredObjectMetadata } from "./types";

/**
 * Keeps uploads in a folder on this machine.
 *
 * Intended for development, where it means no bucket, no credentials, and
 * files you can look at. It is not suitable for production: a hosted container
 * is usually rebuilt on each deploy and may run more than one copy, so files
 * written here disappear on the next release and are invisible to the other
 * copies.
 */
export function createLocalFileStore(rootDir: string): FileStore {
  const root = path.resolve(rootDir);

  function pathFor(key: string): string {
    if (!isSafeStorageKey(key)) {
      throw new Error(`Refusing to use unsafe storage key: ${JSON.stringify(key)}`);
    }
    return path.join(root, key);
  }

  return {
    name: `local(${root})`,

    async put(key: string, contents: Buffer, _metadata: StoredObjectMetadata): Promise<void> {
      const destination = pathFor(key);
      await fsp.mkdir(root, { recursive: true });
      // The name and type are recorded in the uploads table rather than
      // alongside the bytes, so there is nothing else to write here.
      await fsp.writeFile(destination, contents);
    },

    async exists(key: string): Promise<boolean> {
      try {
        const stats = await fsp.stat(pathFor(key));
        return stats.isFile();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return false;
        }
        throw error;
      }
    },

    async openReadStream(key: string): Promise<Readable> {
      return fs.createReadStream(pathFor(key));
    },

    async remove(key: string): Promise<void> {
      // `force` makes an already-absent file a success, which is what callers
      // cleaning up after a failure want.
      await fsp.rm(pathFor(key), { force: true });
    },

    async createSignedUrl(): Promise<string | null> {
      // There is no public host in front of this folder, so there is no URL to
      // sign. The caller streams the file through the application instead.
      return null;
    },
  };
}
