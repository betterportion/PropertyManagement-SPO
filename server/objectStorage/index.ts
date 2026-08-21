import type { Readable } from "stream";
import { createLocalFileStore } from "./local";
import { createSupabaseFileStore, readSupabaseConfigFromEnv } from "./supabase";
import type { FileStore, StoredObjectMetadata } from "./types";

export { contentTypeFor, generateStorageKey, isSafeStorageKey } from "./types";
export type { FileStore, StoredObjectMetadata } from "./types";
export { createLocalFileStore } from "./local";
export { createSupabaseFileStore } from "./supabase";

export type StorageDriverName = "local" | "supabase";

/**
 * How long a signed download link stays usable. Long enough for a browser to
 * follow the redirect and fetch a large document on a slow connection, short
 * enough that a link copied out of history is useless by the time it is used.
 */
export const SIGNED_URL_TTL_SECONDS = 300;

export function resolveStorageDriverName(): StorageDriverName {
  const configured = process.env.STORAGE_DRIVER?.trim().toLowerCase();

  if (configured === "local" || configured === "supabase") {
    return configured;
  }

  if (configured) {
    throw new Error(
      `STORAGE_DRIVER must be "local" or "supabase", but was "${configured}".`,
    );
  }

  // Refusing to guess in production is deliberate. Defaulting to local storage
  // there would appear to work and then quietly lose every uploaded file on the
  // next deploy, which is far harder to notice than a server that will not
  // start and says why.
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "STORAGE_DRIVER must be set in production. Use \"supabase\" with SUPABASE_URL and " +
        "SUPABASE_SERVICE_ROLE_KEY set, or \"local\" only if this host has durable storage.",
    );
  }

  return "local";
}

export function createFileStore(driver: StorageDriverName): FileStore {
  switch (driver) {
    case "supabase":
      return createSupabaseFileStore(readSupabaseConfigFromEnv());
    case "local":
      return createLocalFileStore(process.env.UPLOAD_DIR?.trim() || "uploads");
  }
}

let store: FileStore | null = null;

/**
 * Built on first use rather than at import, so that tests and tooling can load
 * anything that touches storage without credentials or configuration.
 */
export function fileStore(): FileStore {
  if (!store) {
    store = createFileStore(resolveStorageDriverName());
  }
  return store;
}

export async function putUpload(
  key: string,
  contents: Buffer,
  metadata: StoredObjectMetadata,
): Promise<void> {
  await fileStore().put(key, contents, metadata);
}

export async function uploadExists(key: string): Promise<boolean> {
  return fileStore().exists(key);
}

export async function removeUpload(key: string): Promise<void> {
  await fileStore().remove(key);
}

export async function openUploadStream(key: string): Promise<Readable> {
  return fileStore().openReadStream(key);
}

/** A short-lived direct URL, or null when the store cannot issue one. */
export async function createUploadSignedUrl(key: string): Promise<string | null> {
  return fileStore().createSignedUrl(key, SIGNED_URL_TTL_SECONDS);
}
