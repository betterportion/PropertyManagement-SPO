import { Client } from "@replit/object-storage";
import type { Readable } from "stream";
import path from "path";

/**
 * Uploaded photos and documents live in Replit App Storage rather than on the
 * container filesystem. Autoscale deployments rebuild the container on every
 * publish and can run several instances at once, so anything written to local
 * disk is lost on the next publish and invisible to the other instances.
 *
 * Object keys mirror the public URL path: `/uploads/<name>` is stored as
 * `uploads/<name>`. Keeping that shape means the URLs already saved in the
 * database keep working untouched.
 */
const UPLOAD_PREFIX = "uploads/";

let client: Client | null = null;

/**
 * Created lazily so that importing this module cannot fail at boot. The SDK
 * resolves the bucket from the `objectStorage` section of `.replit`.
 */
function getClient(): Client {
  if (!client) {
    client = new Client();
  }
  return client;
}

export function objectKeyFor(filename: string): string {
  return `${UPLOAD_PREFIX}${filename}`;
}

/** Filenames are generated, never taken from the client, to avoid collisions and traversal. */
export function generateUploadFilename(originalName: string): string {
  const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
  return `${uniqueSuffix}${path.extname(originalName).toLowerCase()}`;
}

export async function putUpload(filename: string, contents: Buffer): Promise<void> {
  // Compression is off: these are already-compressed images and PDFs, and
  // storing them verbatim keeps byte-for-byte downloads simple.
  const result = await getClient().uploadFromBytes(objectKeyFor(filename), contents, {
    compress: false,
  });
  if (!result.ok) {
    throw new Error(`Object storage upload failed for ${filename}: ${result.error.message}`);
  }
}

export async function uploadExists(filename: string): Promise<boolean> {
  const result = await getClient().exists(objectKeyFor(filename));
  if (!result.ok) {
    throw new Error(`Object storage lookup failed for ${filename}: ${result.error.message}`);
  }
  return result.value;
}

export function openUploadStream(filename: string): Readable {
  return getClient().downloadAsStream(objectKeyFor(filename), { decompress: false });
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
 * Disk serving used to infer this automatically. Object storage does not, so the
 * type is derived from the extension, which the upload filters already restrict.
 */
export function contentTypeFor(filename: string): string {
  return CONTENT_TYPES[path.extname(filename).toLowerCase()] ?? "application/octet-stream";
}
