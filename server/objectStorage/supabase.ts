import { StorageClient } from "@supabase/storage-js";
import { Readable } from "stream";
import { isSafeStorageKey, type FileStore, type StoredObjectMetadata } from "./types";

/**
 * Keeps uploads in a Supabase Storage bucket.
 *
 * The bucket must be private. Everything here uses the service role key, which
 * bypasses row-level security, so it must only ever be read from server
 * configuration -- it is never sent to the browser, and the browser is never
 * given a bucket URL directly. Access is granted one file at a time, through
 * short-lived signed URLs issued only after the request has been authorized.
 *
 * This talks to the storage service directly rather than through the full
 * `@supabase/supabase-js` client. That client also sets up realtime and
 * authentication, and on Node 20 it fails on construction because realtime
 * wants a WebSocket implementation the runtime does not provide. Storage is
 * all this application needs, and asking only for it keeps the driver working
 * regardless of the Node version underneath.
 */
export interface SupabaseFileStoreConfig {
  url: string;
  serviceRoleKey: string;
  bucket: string;
}

export function readSupabaseConfigFromEnv(): SupabaseFileStoreConfig {
  const url = process.env.SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const bucket = process.env.SUPABASE_STORAGE_BUCKET?.trim() || "uploads";

  const missing = [
    ["SUPABASE_URL", url],
    ["SUPABASE_SERVICE_ROLE_KEY", serviceRoleKey],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(
      `STORAGE_DRIVER is "supabase" but ${missing.join(" and ")} ` +
        `${missing.length === 1 ? "is" : "are"} not set.`,
    );
  }

  return { url: url!, serviceRoleKey: serviceRoleKey!, bucket };
}

export function createSupabaseFileStore(config: SupabaseFileStoreConfig): FileStore {
  let client: StorageClient | null = null;

  // Built on first use so that importing this module, or starting the app with
  // a different driver selected, never needs Supabase credentials.
  function bucket() {
    if (!client) {
      const base = `${config.url.replace(/\/+$/, "")}/storage/v1`;
      client = new StorageClient(base, {
        apikey: config.serviceRoleKey,
        Authorization: `Bearer ${config.serviceRoleKey}`,
      });
    }
    return client.from(config.bucket);
  }

  function assertSafe(key: string): string {
    if (!isSafeStorageKey(key)) {
      throw new Error(`Refusing to use unsafe storage key: ${JSON.stringify(key)}`);
    }
    return key;
  }

  return {
    name: `supabase(${config.bucket})`,

    async put(key: string, contents: Buffer, metadata: StoredObjectMetadata): Promise<void> {
      const safeKey = assertSafe(key);
      const { error } = await bucket().upload(safeKey, contents, {
        contentType: metadata.contentType,
        // Stored on the object as well as in the uploads table, so that someone
        // looking through the bucket directly can tell what a random key is.
        metadata: { originalName: metadata.originalName },
        // Keys are randomly generated, so an existing object at the same key
        // means something is wrong; overwriting it would destroy a file that
        // another record still points at.
        upsert: false,
      });
      if (error) {
        throw new Error(`Supabase Storage upload failed for ${key}: ${error.message}`);
      }
    },

    async exists(key: string): Promise<boolean> {
      const safeKey = assertSafe(key);
      const { data, error } = await bucket().exists(safeKey);
      if (error) {
        throw new Error(`Supabase Storage lookup failed for ${key}: ${error.message}`);
      }
      return data === true;
    },

    async remove(key: string): Promise<void> {
      const safeKey = assertSafe(key);
      const { error } = await bucket().remove([safeKey]);
      // Removing a key that is not there reports no error, so anything raised
      // here is a genuine failure worth surfacing.
      if (error) {
        throw new Error(`Supabase Storage delete failed for ${key}: ${error.message}`);
      }
    },

    async openReadStream(key: string): Promise<Readable> {
      const safeKey = assertSafe(key);
      const { data, error } = await bucket().download(safeKey);
      if (error || !data) {
        throw new Error(
          `Supabase Storage download failed for ${key}: ${error?.message ?? "no data returned"}`,
        );
      }
      return Readable.fromWeb(data.stream() as Parameters<typeof Readable.fromWeb>[0]);
    },

    async createSignedUrl(key: string, expiresInSeconds: number): Promise<string | null> {
      const safeKey = assertSafe(key);
      const { data, error } = await bucket().createSignedUrl(safeKey, expiresInSeconds);
      if (error || !data?.signedUrl) {
        throw new Error(
          `Supabase Storage could not sign a URL for ${key}: ${error?.message ?? "no URL returned"}`,
        );
      }
      return data.signedUrl;
    },
  };
}
