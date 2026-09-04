/**
 * The body rule for a request thread.
 *
 * A comment body is free text typed by a person, so it is tidied and bounded
 * here, once, the way recordAuditEvent tidies a summary -- never at each
 * route that might one day accept one. Two things are deliberately NOT done:
 * line breaks are kept, because a thread with the paragraphs flattened out of
 * it is unreadable; and an over-long body is refused rather than cut, because
 * a comment silently truncated is a comment that says something its author
 * did not.
 */

import { HttpError } from "./errors";

/** The most a single comment may hold, after tidying. */
export const MAX_COMMENT_LENGTH = 4000;

/** Refused as a 400 with the limit stated, the way an oversized upload is. */
export function commentTooLong(length: number): HttpError {
  return new HttpError(
    400,
    `A comment can be at most ${MAX_COMMENT_LENGTH.toLocaleString()} characters; this one is ${length.toLocaleString()}.`,
  );
}

/**
 * Normalises a body: Windows line endings to plain ones, runs of spaces and
 * tabs to one space, more than one blank line to one, and whitespace trimmed
 * from both ends and from the end of each line.
 */
export function tidyCommentBody(body: string): string {
  return body
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Tidies and bounds, throwing a 400 when the tidied body is over the cap. */
export function commentBodyFromClient(body: string): string {
  const tidied = tidyCommentBody(body);
  if (tidied.length > MAX_COMMENT_LENGTH) throw commentTooLong(tidied.length);
  return tidied;
}
