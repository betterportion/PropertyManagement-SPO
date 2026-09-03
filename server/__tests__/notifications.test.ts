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
  householdEmail,
  maintenanceReceivedEmail,
  maintenanceStatusEmail,
} from "../notifications";
import type { MaintenanceRequest } from "@shared/schema";

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
