/**
 * Tests for the file storage layer.
 *
 * Runs entirely against the local driver and a temporary folder: no bucket, no
 * credentials, no network. The Supabase driver is only exercised for the checks
 * that happen before it would ever reach out -- refusing to start without
 * configuration, and refusing an unsafe key.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { Readable } from "stream";
import {
  contentTypeFor,
  createFileStore,
  createLocalFileStore,
  createSupabaseFileStore,
  generateStorageKey,
  isSafeStorageKey,
  resolveStorageDriverName,
} from "../objectStorage";

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

describe("generateStorageKey", () => {
  it("keeps the extension so the file type is still recoverable", () => {
    expect(generateStorageKey("Quarterly Report.PDF")).toMatch(/^[a-f0-9]{32}\.pdf$/);
    expect(generateStorageKey("photo.jpeg")).toMatch(/^[a-f0-9]{32}\.jpeg$/);
  });

  it("keeps nothing else from the uploaded name", () => {
    // The name can identify a person, a property, or a contract. It must not
    // end up in a URL that gets forwarded or pasted into a message.
    const key = generateStorageKey("Jane Doe - 123 Main St lease.pdf");
    expect(key.toLowerCase()).not.toContain("jane");
    expect(key.toLowerCase()).not.toContain("main");
    expect(key.toLowerCase()).not.toContain("lease");
  });

  it("does not collide when the same file is uploaded twice", () => {
    const keys = new Set(Array.from({ length: 200 }, () => generateStorageKey("photo.png")));
    expect(keys.size).toBe(200);
  });

  it("produces keys that are themselves safe to use", () => {
    expect(isSafeStorageKey(generateStorageKey("../../etc/passwd.png"))).toBe(true);
  });
});

describe("isSafeStorageKey", () => {
  it("accepts a plain filename, including ones stored before keys were random", () => {
    expect(isSafeStorageKey("a".repeat(32) + ".pdf")).toBe(true);
    expect(isSafeStorageKey("1712345678901-482913.jpg")).toBe(true);
  });

  it("rejects anything that could point outside the uploads area", () => {
    for (const key of [
      "../secrets.env",
      "..",
      "nested/photo.png",
      "\\windows\\path.png",
      "/etc/passwd",
      ".hidden",
      "",
      "with\0null.png",
    ]) {
      expect(isSafeStorageKey(key), `expected ${JSON.stringify(key)} to be rejected`).toBe(false);
    }
  });
});

describe("contentTypeFor", () => {
  it("maps the extensions the uploaders accept", () => {
    expect(contentTypeFor("a.png")).toBe("image/png");
    expect(contentTypeFor("a.JPG")).toBe("image/jpeg");
    expect(contentTypeFor("a.pdf")).toBe("application/pdf");
  });

  it("falls back to a neutral type rather than guessing", () => {
    // Guessing here would let an unexpected file be served as something the
    // browser will happily render.
    expect(contentTypeFor("a.weird")).toBe("application/octet-stream");
    expect(contentTypeFor("noextension")).toBe("application/octet-stream");
  });
});

describe("local file store", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "spo-storage-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("stores and reads back the exact bytes", async () => {
    const store = createLocalFileStore(root);
    const contents = Buffer.from("hello there", "utf8");

    await store.put("abc123.pdf", contents, {
      contentType: "application/pdf",
      originalName: "hello.pdf",
    });

    expect(await store.exists("abc123.pdf")).toBe(true);
    expect(await readAll(await store.openReadStream("abc123.pdf"))).toEqual(contents);
  });

  it("creates the folder on first use", async () => {
    const store = createLocalFileStore(path.join(root, "does", "not", "exist", "yet"));
    await store.put("a.png", Buffer.from([1, 2, 3]), {
      contentType: "image/png",
      originalName: "a.png",
    });
    expect(await store.exists("a.png")).toBe(true);
  });

  it("reports a missing file as absent rather than throwing", async () => {
    expect(await createLocalFileStore(root).exists("nothing-here.png")).toBe(false);
  });

  it("refuses an unsafe key instead of writing outside its folder", async () => {
    const store = createLocalFileStore(path.join(root, "uploads"));

    await expect(
      store.put("../escaped.txt", Buffer.from("x"), {
        contentType: "text/plain",
        originalName: "escaped.txt",
      }),
    ).rejects.toThrow(/unsafe storage key/i);

    await expect(store.exists("../escaped.txt")).rejects.toThrow(/unsafe storage key/i);
    // Nothing was created next to the uploads folder.
    await expect(fs.access(path.join(root, "escaped.txt"))).rejects.toThrow();
  });

  it("reports that it cannot sign URLs, so the caller streams instead", async () => {
    expect(await createLocalFileStore(root).createSignedUrl("a.png", 300)).toBeNull();
  });

  it("removes a file, which is how a half-finished upload is cleaned up", async () => {
    const store = createLocalFileStore(root);
    await store.put("gone.png", Buffer.from([1]), {
      contentType: "image/png",
      originalName: "gone.png",
    });
    await store.remove("gone.png");
    expect(await store.exists("gone.png")).toBe(false);
  });

  it("treats removing an absent file as success", async () => {
    // Cleanup runs on a failure path, where the file may never have landed.
    // Throwing there would replace the real error with a misleading one.
    await expect(createLocalFileStore(root).remove("never-existed.png")).resolves.toBeUndefined();
  });
});

describe("supabase file store", () => {
  it("refuses an unsafe key before contacting the service", async () => {
    const store = createSupabaseFileStore({
      url: "https://example.supabase.co",
      serviceRoleKey: "not-a-real-key",
      bucket: "uploads",
    });
    // No network call is made, so this passes without credentials.
    await expect(store.exists("../../other-bucket/file")).rejects.toThrow(/unsafe storage key/i);
  });

  it("names the missing settings when it cannot be configured", () => {
    const saved = { ...process.env };
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    try {
      expect(() => createFileStore("supabase")).toThrow(/SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY/);
    } finally {
      process.env = saved;
    }
  });
});

describe("driver selection", () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
  });

  it("defaults to local outside production, so development needs no setup", () => {
    delete process.env.STORAGE_DRIVER;
    process.env.NODE_ENV = "development";
    expect(resolveStorageDriverName()).toBe("local");
  });

  it("refuses to guess in production", () => {
    // Silently choosing local storage in production would appear to work and
    // then lose every uploaded file on the next deploy.
    delete process.env.STORAGE_DRIVER;
    process.env.NODE_ENV = "production";
    expect(() => resolveStorageDriverName()).toThrow(/STORAGE_DRIVER must be set in production/);
  });

  it("rejects an unrecognised value rather than falling back", () => {
    process.env.STORAGE_DRIVER = "s3";
    expect(() => resolveStorageDriverName()).toThrow(/must be "local" or "supabase"/);
  });

  it("accepts the supported values", () => {
    process.env.NODE_ENV = "production";
    process.env.STORAGE_DRIVER = "LOCAL";
    expect(resolveStorageDriverName()).toBe("local");
    process.env.STORAGE_DRIVER = " supabase ";
    expect(resolveStorageDriverName()).toBe("supabase");
  });
});
