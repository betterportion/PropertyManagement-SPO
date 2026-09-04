import { describe, it, expect } from "vitest";
import { commentBodyFromClient, tidyCommentBody, MAX_COMMENT_LENGTH } from "../comments";
import { HttpError } from "../errors";

/**
 * The body rule is one function used by one route. These tests pin what it
 * keeps (paragraphs) and what it refuses (over the cap), so the rule cannot
 * drift into flattening a thread into a wall of text or quietly cutting a
 * comment short.
 */
describe("tidying a comment body", () => {
  it("keeps paragraphs and single line breaks", () => {
    expect(tidyCommentBody("Dave came.\nFound a cracked trap.\n\nQuoted $180.")).toBe(
      "Dave came.\nFound a cracked trap.\n\nQuoted $180.",
    );
  });

  it("collapses runs of spaces and tabs, and Windows line endings", () => {
    expect(tidyCommentBody("  he   said\t\tThursday \r\n  at 9  ")).toBe("he said Thursday\nat 9");
  });

  it("caps blank lines at one", () => {
    expect(tidyCommentBody("one\n\n\n\n\ntwo")).toBe("one\n\ntwo");
  });
});

describe("bounding a comment body", () => {
  it("returns the tidied body when it fits", () => {
    expect(commentBodyFromClient("  fine  ")).toBe("fine");
  });

  it("accepts a body exactly at the cap", () => {
    expect(commentBodyFromClient("x".repeat(MAX_COMMENT_LENGTH))).toHaveLength(MAX_COMMENT_LENGTH);
  });

  it("refuses a body one character over the cap as a 400, naming the limit", () => {
    let caught: unknown;
    try {
      commentBodyFromClient("x".repeat(MAX_COMMENT_LENGTH + 1));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HttpError);
    expect((caught as HttpError).status).toBe(400);
    expect((caught as HttpError).message).toContain("4,000");
  });

  // Measured after tidying: padding a body with spaces must not push it over.
  it("measures the tidied length, not the raw one", () => {
    const padded = "x".repeat(MAX_COMMENT_LENGTH) + " ".repeat(50);
    expect(commentBodyFromClient(padded)).toHaveLength(MAX_COMMENT_LENGTH);
  });
});
