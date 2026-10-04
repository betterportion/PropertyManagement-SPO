/**
 * The boot check that the Supabase uploads bucket is private.
 *
 * The Supabase client is mocked: no network, no credentials. A bucket the
 * service reports as public stops the boot (every file would be readable at a
 * permanent public URL, bypassing /uploads authorization). Anything short of a
 * definite "public" answer -- the API unreachable, slow, or refusing -- only
 * warns, so a Supabase blip cannot turn a deploy into a restart loop.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const getBucket = vi.fn();
const constructed = vi.fn();

vi.mock("@supabase/storage-js", () => ({
  StorageClient: class {
    constructor(...args: unknown[]) {
      constructed(...args);
    }
    getBucket = getBucket;
    from() {
      throw new Error("the boot check must not touch objects");
    }
  },
}));

import { verifyStorageBucketIsPrivate } from "../config";

function bucket(isPublic: boolean) {
  return {
    data: { id: "uploads", name: "uploads", owner: "", created_at: "", updated_at: "", public: isPublic },
    error: null,
  };
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  getBucket.mockReset();
  constructed.mockReset();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubEnv("STORAGE_DRIVER", "supabase");
  vi.stubEnv("SUPABASE_URL", "https://abc.supabase.co/");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-key");
  vi.stubEnv("SUPABASE_STORAGE_BUCKET", "uploads");
});

afterEach(() => {
  vi.unstubAllEnvs();
  warn.mockRestore();
});

describe("verifyStorageBucketIsPrivate", () => {
  it("refuses to start when the bucket is public, naming the bucket and the fix", async () => {
    getBucket.mockResolvedValue(bucket(true));
    await expect(verifyStorageBucketIsPrivate()).rejects.toThrow(/"uploads".*public.*private/s);
    expect(getBucket).toHaveBeenCalledWith("uploads");
    // The read is made with the service role key, against the storage service.
    expect(constructed).toHaveBeenCalledWith(
      "https://abc.supabase.co/storage/v1",
      expect.objectContaining({ apikey: "service-role-key" }),
    );
  });

  it("starts when the bucket is private", async () => {
    getBucket.mockResolvedValue(bucket(false));
    await expect(verifyStorageBucketIsPrivate()).resolves.toBeUndefined();
    expect(getBucket).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("checks the configured bucket name, not a fixed one", async () => {
    vi.stubEnv("SUPABASE_STORAGE_BUCKET", "spo-files");
    getBucket.mockResolvedValue(bucket(false));
    await verifyStorageBucketIsPrivate();
    expect(getBucket).toHaveBeenCalledWith("spo-files");
  });

  it("warns and starts when Supabase answers with an error", async () => {
    getBucket.mockResolvedValue({ data: null, error: { message: "Bucket not found" } });
    await expect(verifyStorageBucketIsPrivate()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Bucket not found"));
  });

  it("warns and starts when the request throws, as a network failure would", async () => {
    getBucket.mockRejectedValue(new Error("getaddrinfo ENOTFOUND abc.supabase.co"));
    await expect(verifyStorageBucketIsPrivate()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("ENOTFOUND"));
  });

  it("warns and starts when Supabase does not answer in time", async () => {
    getBucket.mockReturnValue(new Promise(() => {}));
    await expect(verifyStorageBucketIsPrivate(20)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/did not answer/));
  });

  it("does not treat a malformed answer as private or as public", async () => {
    getBucket.mockResolvedValue({ data: { id: "uploads" }, error: null });
    await expect(verifyStorageBucketIsPrivate()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it("does nothing with the local driver", async () => {
    vi.stubEnv("STORAGE_DRIVER", "local");
    await verifyStorageBucketIsPrivate();
    expect(constructed).not.toHaveBeenCalled();
    expect(getBucket).not.toHaveBeenCalled();
  });

  it("leaves missing Supabase variables to the configuration check", async () => {
    vi.stubEnv("SUPABASE_URL", "");
    await expect(verifyStorageBucketIsPrivate()).resolves.toBeUndefined();
    expect(getBucket).not.toHaveBeenCalled();
  });
});
