/**
 * The badge labels the request page and the property page's request table
 * both draw from. Locking down that every status and priority the schema
 * defines has a word here is the point -- a fifth status added to
 * shared/schema.ts without a matching entry would leave a blank badge on
 * both screens at once.
 */
import { describe, it, expect } from "vitest";
import { maintenanceRequests } from "@shared/schema";
import { REQUEST_PRIORITY, REQUEST_STATUS } from "./requestLabels";

// Read off the live column definition rather than retyping the enum here, so
// this test fails the moment the schema and this module drift, instead of
// silently agreeing with whichever list was copied in last.
const STATUSES = maintenanceRequests.status.enumValues;
const PRIORITIES = maintenanceRequests.priority.enumValues;

describe("REQUEST_STATUS", () => {
  it("gives every status in the schema's vocabulary a label and a variant", () => {
    for (const status of STATUSES) {
      expect(REQUEST_STATUS[status], `missing label for status "${status}"`).toBeDefined();
      expect(REQUEST_STATUS[status].label.length).toBeGreaterThan(0);
      expect(REQUEST_STATUS[status].variant.length).toBeGreaterThan(0);
    }
  });

  it("defines nothing beyond the schema's vocabulary", () => {
    // The mirror of the check above: a stale entry for a status the schema
    // no longer has would be dead weight nobody notices removing.
    expect(Object.keys(REQUEST_STATUS).sort()).toEqual([...STATUSES].sort());
  });

  it("says what the database's word means in plain language", () => {
    expect(REQUEST_STATUS.pending.label).toBe("Pending");
    expect(REQUEST_STATUS.in_progress.label).toBe("In progress");
    expect(REQUEST_STATUS.completed.label).toBe("Completed");
    expect(REQUEST_STATUS.cancelled.label).toBe("Cancelled");
  });
});

describe("REQUEST_PRIORITY", () => {
  it("gives every priority in the schema's vocabulary a label and a variant", () => {
    for (const priority of PRIORITIES) {
      expect(REQUEST_PRIORITY[priority], `missing label for priority "${priority}"`).toBeDefined();
      expect(REQUEST_PRIORITY[priority].label.length).toBeGreaterThan(0);
      expect(REQUEST_PRIORITY[priority].variant.length).toBeGreaterThan(0);
    }
  });

  it("defines nothing beyond the schema's vocabulary", () => {
    expect(Object.keys(REQUEST_PRIORITY).sort()).toEqual([...PRIORITIES].sort());
  });

  it("says what the database's word means in plain language", () => {
    expect(REQUEST_PRIORITY.low.label).toBe("Low");
    expect(REQUEST_PRIORITY.medium.label).toBe("Medium");
    expect(REQUEST_PRIORITY.high.label).toBe("High");
    expect(REQUEST_PRIORITY.urgent.label).toBe("Urgent");
    expect(REQUEST_PRIORITY.wishlist.label).toBe("Wishlist");
  });

  it("keeps wishlist a priority word, not a claim about a request type", () => {
    // CONTEXT.md: "Wishlist... A priority, never a type." This label sits
    // beside "Low"/"Medium"/etc. rather than reading as a category of work.
    expect(REQUEST_PRIORITY.wishlist.label).not.toMatch(/type|project/i);
  });
});
