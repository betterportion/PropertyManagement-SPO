import crypto from "crypto";
import path from "path";
import type { Readable } from "stream";

/**
 * What the application needs from a place to keep uploaded files. Everything
 * provider-specific lives behind this: routes never learn whether a file is on
 * a disk or in a bucket.
 */
export interface FileStore {
  /** Identifies the implementation in logs and error messages. */
  readonly name: string;

  put(key: string, contents: Buffer, metadata: StoredObjectMetadata): Promise<void>;

  exists(key: string): Promise<boolean>;

  openReadStream(key: string): Promise<Readable>;

  /** Removes an object. Succeeds quietly if it is already gone. */
  remove(key: string): Promise<void>;

  /**
   * A short-lived URL the browser can fetch directly, or null if this store
   * cannot issue one. Returning null is normal, not an error -- the caller
   * streams the file itself instead.
   */
  createSignedUrl(key: string, expiresInSeconds: number): Promise<string | null>;
}

export interface StoredObjectMetadata {
  contentType: string;
  /** The name the person chose. Kept so a download can be offered under it. */
  originalName: string;
}

const CONTENT_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

/**
 * Derived from the extension, which the upload filters already restrict and
 * which is verified against the file's real bytes before anything is stored.
 */
export function contentTypeFor(filename: string): string {
  return CONTENT_TYPES[path.extname(filename).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Keys are random rather than derived from the uploaded filename.
 *
 * A name the uploader chose is not safe to use as a key: it can collide with
 * an existing file, carry path separators, or leak something about the person
 * or property in a URL that gets shared. The real name is kept as metadata
 * instead, so downloads can still be offered under it.
 */
export function generateStorageKey(originalName: string): string {
  const extension = path.extname(originalName).toLowerCase();
  return `${crypto.randomBytes(16).toString("hex")}${extension}`;
}

/**
 * A key must be a single path segment. Anything else -- a slash, a `..`, a
 * leading dot -- could reach outside the uploads area of a bucket or a disk,
 * so it is rejected before it reaches a provider.
 *
 * This deliberately accepts more than generateStorageKey produces: files
 * stored before keys were randomised still have to be readable.
 */
export function isSafeStorageKey(key: string): boolean {
  return (
    typeof key === "string" &&
    key.length > 0 &&
    key.length <= 255 &&
    // Both separators, not just this platform's: the key is also a path inside
    // a bucket, where a backslash is not necessarily inert the way it is on
    // Linux, and the same key has to be safe in either place.
    !key.includes("/") &&
    !key.includes("\\") &&
    // A leading dot hides the file and, as "." or "..", names a directory.
    !key.startsWith(".") &&
    // Control characters, including the NUL byte that can truncate a filename
    // once it reaches a C library.
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f]/.test(key) &&
    key === path.basename(key)
  );
}
