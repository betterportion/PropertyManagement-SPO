/**
 * What the portal's outbound emails actually say.
 *
 * Pure builders — a record in, a message out — so the wording can be tested
 * without a mail provider, and so the content rule has one place to hold:
 * **names, dates, amounts and descriptions yes; a credential or a banking
 * identifier never.** That is the audit log's rule, and email is held to it
 * for the same reason.
 */
import { describe, it, expect } from "vitest";
import {
  commentEmail,
  householdEmail,
  maintenanceReceivedEmail,
  maintenanceStatusEmail,
} from "../notifications";
import type { MaintenanceRequest, MaintenanceRequestComment } from "@shared/schema";

function request(over: Partial<MaintenanceRequest> = {}): MaintenanceRequest {
  return {
    id: "req-1",
    title: "Leaky kitchen tap",
    description: "Drips overnight",
    status: "pending",
    priority: "high",
    location: "Kitchen",
    buildingAddress: "1 Main St",
    submittedBy: "alice@example.com",
    ...over,
  } as MaintenanceRequest;
}

describe("acknowledging a maintenance request", () => {
  it("is addressed to whoever filed it", () => {
    // submittedBy holds an EMAIL, not a user id. Reading it as an id would
    // send every acknowledgement to nowhere, silently.
    const message = maintenanceReceivedEmail(request());
    expect(message?.to).toBe("alice@example.com");
  });

  it("names the request and the house, so it is recognisable", () => {
    const message = maintenanceReceivedEmail(request());
    expect(message?.subject).toContain("Leaky kitchen tap");
    expect(message?.text).toContain("1 Main St");
    expect(message?.text).toContain("Kitchen");
  });

  it("sends nothing when there is no address to send to", () => {
    // A request filed on somebody's behalf may carry no usable email. Nothing
    // to do is not an error.
    expect(maintenanceReceivedEmail(request({ submittedBy: "" }))).toBeNull();
    expect(maintenanceReceivedEmail(request({ submittedBy: null }))).toBeNull();
  });

  it("sends nothing to an address that is not one", () => {
    expect(maintenanceReceivedEmail(request({ submittedBy: "not an email" }))).toBeNull();
  });
});

describe("telling somebody their request moved on", () => {
  it("says what it moved to, in words rather than the stored value", () => {
    const message = maintenanceStatusEmail(request({ status: "in_progress" }), "pending");
    expect(message?.text).toContain("in progress");
    expect(message?.text).not.toContain("in_progress");
  });

  it("says nothing when the status did not actually change", () => {
    // An edit to a description must not email the whole house about nothing.
    expect(maintenanceStatusEmail(request({ status: "pending" }), "pending")).toBeNull();
  });

  it("says nothing when there was no previous status to compare", () => {
    expect(maintenanceStatusEmail(request({ status: "pending" }), null)).toBeNull();
  });

  it("covers every status the vocabulary has", () => {
    for (const status of ["pending", "in_progress", "completed", "cancelled"] as const) {
      const message = maintenanceStatusEmail(request({ status }), "pending");
      // "pending" -> "pending" is not a change, so only the other three send.
      if (status === "pending") {
        expect(message).toBeNull();
      } else {
        expect(message?.text.trim().length).toBeGreaterThan(0);
      }
    }
  });
});

describe("emailing a household", () => {
  const residents = [
    { email: "alice@example.com", isActive: true },
    { email: "bob@example.com", isActive: true },
    { email: "carol@example.com", isActive: false },
  ];

  it("goes to the active residents only", () => {
    // A mail-out to people who moved out last spring is the kind of mistake
    // that gets a tool abandoned.
    const messages = householdEmail(residents, "Cleveland House", "Boiler service", "Friday 9am");
    expect(messages.map((message) => message.to)).toEqual([
      "alice@example.com",
      "bob@example.com",
    ]);
  });

  it("skips anybody with no usable address rather than failing the whole send", () => {
    const messages = householdEmail(
      [...residents, { email: "", isActive: true }, { email: "nope", isActive: true }],
      "Cleveland House",
      "Boiler service",
      "Friday 9am",
    );
    expect(messages).toHaveLength(2);
  });

  it("names the house in the subject, so it is obvious which one", () => {
    const messages = householdEmail(residents, "Cleveland House", "Boiler service", "Friday 9am");
    expect(messages[0].subject).toContain("Cleveland House");
    expect(messages[0].subject).toContain("Boiler service");
  });

  it("sends one message per person rather than one with everybody on it", () => {
    // Nobody's address is disclosed to the rest of the house.
    const messages = householdEmail(residents, "Cleveland House", "Subject", "Body");
    expect(messages).toHaveLength(2);
    for (const message of messages) {
      expect(message.to).not.toContain(",");
      expect(message.text).not.toContain("bob@example.com");
    }
  });

  it("sends nothing to an empty house", () => {
    expect(householdEmail([], "Cleveland House", "Subject", "Body")).toEqual([]);
  });
});

describe("telling somebody a comment was posted", () => {
  function comment(over: Partial<MaintenanceRequestComment> = {}): MaintenanceRequestComment {
    return {
      id: "c-1",
      requestId: "req-1",
      body: "The plumber is coming Thursday at 9.",
      isInternal: false,
      authorUserId: "u-sarah",
      authorEmail: "sarah@example.com",
      authorName: "Sarah Lee",
      relaySource: null,
      relayContactId: null,
      createdAt: new Date("2026-09-01T10:00:00Z"),
      ...over,
    } as MaintenanceRequestComment;
  }

  const build = (over: Partial<MaintenanceRequestComment> = {}, appUrl: string | null = null, to = "bob@example.com") =>
    commentEmail({ to, request: request(), comment: comment(over), appUrl });

  it("is addressed to the recipient it was built for, one person per message", () => {
    expect(build()?.to).toBe("bob@example.com");
  });

  it("carries the comment itself, the request and the house", () => {
    const message = build();
    expect(message?.subject).toContain("Leaky kitchen tap");
    expect(message?.text).toContain("The plumber is coming Thursday at 9.");
    expect(message?.text).toContain("Leaky kitchen tap");
    expect(message?.text).toContain("1 Main St");
  });

  it("carries whatever the comment says, verbatim, without scrubbing it -- that is the author's own text and what the email is for", () => {
    // Unlike the audit log, this builder never redacts the comment body: a
    // household leader typing a gate code into a comment chose to share it
    // there, and the email exists to relay exactly what was posted.
    const message = build({ body: "The lockbox code is 4471." });
    expect(message?.text).toContain("The lockbox code is 4471.");
  });

  it("carries nothing beyond the comment, the author line, the request title, the house and a link -- never the request's description", () => {
    // request() only ever gives commentEmail id/title/buildingAddress (see
    // CommentEmailInput's Pick<>), but this pins the content rule at the text
    // itself so a future widening of that Pick cannot leak the description.
    const message = build();
    expect(message?.text).not.toContain("Drips overnight");
  });

  it("says who wrote it", () => {
    expect(build()?.text).toContain("Sarah Lee");
  });

  it("reads as a relay when the comment came from a contractor", () => {
    // Two years from now the thread must say Sarah relayed Dave, not that
    // Sarah said it.
    expect(build({ relaySource: "Dave (handyman)" })?.text).toContain("Sarah Lee, relaying Dave (handyman)");
  });

  it("falls back to the author's email, then to a generic line, when there is no name", () => {
    expect(build({ authorName: null })?.text).toContain("sarah@example.com");
    expect(build({ authorName: null, authorEmail: null })?.text.trim().length).toBeGreaterThan(0);
  });

  it("marks an internal comment as staff-only, and a shared one not", () => {
    expect(build({ isInternal: true })?.text).toContain("Internal");
    expect(build({ isInternal: true })?.text).toContain("staff only");
    expect(build({ isInternal: false })?.text).not.toContain("staff only");
  });

  it("links to the request when the portal's address is configured", () => {
    expect(build({}, "https://housing.spo.org")?.text).toContain("https://housing.spo.org/maintenance/req-1");
  });

  it("goes without a link when no address is configured, rather than a broken one", () => {
    const text = build({}, null)?.text ?? "";
    expect(text).not.toContain("/maintenance/");
    expect(text).not.toContain("http");
  });

  it("sends nothing to an address that is not one", () => {
    expect(build({}, null, "")).toBeNull();
    expect(build({}, null, "not an email")).toBeNull();
  });

  it("sends nothing about an empty comment", () => {
    expect(build({ body: "   " })).toBeNull();
  });
});
