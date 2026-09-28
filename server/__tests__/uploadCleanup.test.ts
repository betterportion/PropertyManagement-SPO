/**
 * Tests for removing a deleted record's stored files.
 *
 * The files are photographs of people's homes and vendors' tax forms, so
 * "deleted" has to mean gone from the bucket too -- but never while another
 * record still shows the same file, and never at the cost of failing a delete
 * that has already happened. The data layer and the file store are stubs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../db", () => ({ db: {}, pool: {} }));

const findUploadReferences = vi.fn();
const deleteUpload = vi.fn();
const removeUpload = vi.fn();

vi.mock("../storage", () => ({
  storage: {
    findUploadReferences: (...args: unknown[]) => findUploadReferences(...args),
    deleteUpload: (...args: unknown[]) => deleteUpload(...args),
  },
}));

vi.mock("../objectStorage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../objectStorage")>();
  return { ...actual, removeUpload: (...args: unknown[]) => removeUpload(...args) };
});

import { removeDeletedRecordFiles } from "../uploadCleanup";

const KEY_A = "0123456789abcdef0123456789abcdef.jpg";
const KEY_B = "fedcba9876543210fedcba9876543210.pdf";

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  findUploadReferences.mockReset().mockResolvedValue([]);
  deleteUpload.mockReset().mockResolvedValue(undefined);
  removeUpload.mockReset().mockResolvedValue(undefined);
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
});

describe("removeDeletedRecordFiles", () => {
  it("removes each orphaned file and then its upload record", async () => {
    await removeDeletedRecordFiles([`/uploads/${KEY_A}`, `/uploads/${KEY_B}`]);

    expect(removeUpload.mock.calls).toEqual([[KEY_A], [KEY_B]]);
    expect(deleteUpload.mock.calls).toEqual([[KEY_A], [KEY_B]]);
    expect(removeUpload.mock.invocationCallOrder[0]).toBeLessThan(deleteUpload.mock.invocationCallOrder[0]);
  });

  it("keeps a file another record still points at", async () => {
    findUploadReferences.mockImplementation(async (url: string) =>
      url === `/uploads/${KEY_A}` ? [{ kind: "assetPhoto", record: { id: "photo-2" } }] : [],
    );

    await removeDeletedRecordFiles([`/uploads/${KEY_A}`, `/uploads/${KEY_B}`]);

    expect(removeUpload.mock.calls).toEqual([[KEY_B]]);
    expect(deleteUpload.mock.calls).toEqual([[KEY_B]]);
  });

  it("removes a file named twice only once", async () => {
    await removeDeletedRecordFiles([`/uploads/${KEY_A}`, `/uploads/${KEY_A}`]);
    expect(removeUpload).toHaveBeenCalledTimes(1);
  });

  it("ignores anything that is not a stored upload", async () => {
    await removeDeletedRecordFiles([
      "https://drive.google.com/file/d/abc/view",
      "/uploads/../secrets.txt",
      "/uploads/",
    ]);

    expect(findUploadReferences).not.toHaveBeenCalled();
    expect(removeUpload).not.toHaveBeenCalled();
    expect(deleteUpload).not.toHaveBeenCalled();
  });

  it("never throws when the store fails, keeps the record of a file it could not remove, and carries on", async () => {
    removeUpload.mockImplementation(async (key: string) => {
      if (key === KEY_A) throw new Error("bucket unreachable");
    });

    await expect(removeDeletedRecordFiles([`/uploads/${KEY_A}`, `/uploads/${KEY_B}`])).resolves.toBeUndefined();

    expect(deleteUpload.mock.calls).toEqual([[KEY_B]]);
    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  it("never throws when the reference lookup fails", async () => {
    findUploadReferences.mockRejectedValue(new Error("database down"));

    await expect(removeDeletedRecordFiles([`/uploads/${KEY_A}`])).resolves.toBeUndefined();
    expect(removeUpload).not.toHaveBeenCalled();
  });
});
