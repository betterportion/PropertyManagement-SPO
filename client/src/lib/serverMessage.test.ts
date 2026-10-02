import { describe, expect, it } from "vitest";
import { serverMessage } from "./serverMessage";

describe("serverMessage", () => {
  it("reads the route's message out of what apiRequest throws", () => {
    // The exact shape a refused save used to print in a toast (#164).
    const error = new Error('400: {"message":"A quarter needs a year to go with it"}');
    expect(serverMessage(error)).toBe("A quarter needs a year to go with it");
  });

  it("prefers the field reasons of a validation refusal over its generic line", () => {
    // The snooze dialog's 24-month limit arrives this way (#164).
    const error = new Error(
      '400: {"message":"Some of the information provided is not valid.","errors":[{"field":"until","message":"A snooze can run at most 24 months."}]}',
    );
    expect(serverMessage(error)).toBe("A snooze can run at most 24 months.");
  });

  it("reads an upload refusal's reason, for the size limit and a refused file type", () => {
    // What the billing document upload now throws for the two refusals the
    // staging pass hit (#228): a 21 MB PDF and a renamed .exe.
    const tooLarge = new Error('413: {"message":"That upload is too large. Files must be smaller than 20MB."}');
    expect(serverMessage(tooLarge)).toBe("That upload is too large. Files must be smaller than 20MB.");
    const disguised = new Error(
      '400: {"message":"File contents do not match the file extension. The file was not saved."}',
    );
    expect(serverMessage(disguised)).toBe("File contents do not match the file extension. The file was not saved.");
  });

  it("has nothing to say for a body that is not the route's JSON", () => {
    expect(serverMessage(new Error("502: <html>Bad gateway</html>"))).toBeUndefined();
    expect(serverMessage(new TypeError("Failed to fetch"))).toBeUndefined();
    expect(serverMessage(new Error('500: {"error":"x"}'))).toBeUndefined();
    expect(serverMessage("not an error")).toBeUndefined();
  });
});
