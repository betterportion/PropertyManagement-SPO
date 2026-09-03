/**
 * The recurring-issue and contractor-performance rollups.
 *
 * These exist to bring evidence into a conversation with a mission leader
 * about whether to keep renting a house or keep using a contractor. So the
 * thing that matters most is that a count means what somebody will read it as
 * — "this has failed four times" has to be four separate failures, not one
 * request counted four ways.
 */
import { describe, it, expect } from "vitest";
import { contractorLoad, recurringIssues } from "../aggregates";
import type { MaintenanceRequest } from "@shared/schema";

const NOW = new Date("2026-08-15T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

function request(over: Partial<MaintenanceRequest>): MaintenanceRequest {
  return {
    id: "r1",
    title: "Blinds broken",
    category: "Structural",
    location: "Living room",
    buildingAddress: "1 Main St",
    region: "West Central",
    status: "completed",
    submittedDate: daysAgo(30),
    ...over,
  } as MaintenanceRequest;
}

describe("what keeps going wrong in a house", () => {
  it("groups the same room and category together", () => {
    const issues = recurringIssues([
      request({ id: "a", location: "Living room", category: "Structural" }),
      request({ id: "b", location: "Living room", category: "Structural" }),
      request({ id: "c", location: "Kitchen", category: "Plumbing" }),
    ]);
    const blinds = issues.find((issue) => issue.location === "Living room")!;
    expect(blinds.count).toBe(2);
    expect(issues).toHaveLength(1); // the single Kitchen one is not recurring
  });

  it("says nothing about something that has happened once", () => {
    // A list of every request that has ever been filed is the maintenance
    // page. This is only for what keeps coming back.
    const issues = recurringIssues([request({ id: "a" })]);
    expect(issues).toEqual([]);
  });

  it("keeps two houses apart even with the same room and category", () => {
    // "These blinds have broken every year" is about THESE blinds.
    const issues = recurringIssues([
      request({ id: "a", buildingAddress: "1 Main St" }),
      request({ id: "b", buildingAddress: "9 Elm" }),
    ]);
    expect(issues).toEqual([]);
  });

  it("matches room names case-insensitively, so 'Living Rm' groups with 'living room'", () => {
    // Free text alone will not group these, which is the entire reason the
    // location field suggests from the walkthrough vocabulary. This is the
    // backstop for what was typed before it did.
    const issues = recurringIssues([
      request({ id: "a", location: "Living room" }),
      request({ id: "b", location: "  living ROOM " }),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0].count).toBe(2);
  });

  it("orders the worst first", () => {
    const issues = recurringIssues([
      request({ id: "a", location: "Kitchen", category: "Plumbing" }),
      request({ id: "b", location: "Kitchen", category: "Plumbing" }),
      request({ id: "c", location: "Bathroom", category: "Plumbing" }),
      request({ id: "d", location: "Bathroom", category: "Plumbing" }),
      request({ id: "e", location: "Bathroom", category: "Plumbing" }),
    ]);
    expect(issues[0].location).toBe("Bathroom");
    expect(issues[0].count).toBe(3);
  });

  it("carries the most recent date, so somebody can see whether it is still live", () => {
    const issues = recurringIssues([
      request({ id: "a", submittedDate: daysAgo(400) }),
      request({ id: "b", submittedDate: daysAgo(10) }),
    ]);
    expect(issues[0].lastSeen?.toISOString()).toBe(daysAgo(10).toISOString());
  });

  it("ignores a request with no room recorded rather than grouping every blank", () => {
    // Grouping on "" would invent an issue called nothing, in every house.
    const issues = recurringIssues([
      request({ id: "a", location: "" }),
      request({ id: "b", location: "   " }),
    ]);
    expect(issues).toEqual([]);
  });
});

describe("how much work a contractor has been called back for", () => {
  const links = [
    { contactId: "c1", requestId: "a" },
    { contactId: "c1", requestId: "b" },
    { contactId: "c2", requestId: "c" },
  ];

  const requests = [
    request({ id: "a", status: "completed" }),
    request({ id: "b", status: "completed" }),
    request({ id: "c", status: "pending" }),
  ];

  it("counts the requests each contractor was linked to", () => {
    const load = contractorLoad(links, requests);
    expect(load.find((row) => row.contactId === "c1")!.total).toBe(2);
    expect(load.find((row) => row.contactId === "c2")!.total).toBe(1);
  });

  it("separates what is still open from what is finished", () => {
    const load = contractorLoad(links, requests);
    expect(load.find((row) => row.contactId === "c1")!.open).toBe(0);
    expect(load.find((row) => row.contactId === "c2")!.open).toBe(1);
  });

  it("counts a repeat visit to the same room as a callback", () => {
    // This is the number worth having: "called back to the same problem" is a
    // different claim from "did a lot of jobs".
    const load = contractorLoad(
      [
        { contactId: "c1", requestId: "a" },
        { contactId: "c1", requestId: "b" },
        { contactId: "c1", requestId: "c" },
      ],
      [
        request({ id: "a", location: "Kitchen", category: "Plumbing" }),
        request({ id: "b", location: "Kitchen", category: "Plumbing" }),
        request({ id: "c", location: "Roof", category: "Structural" }),
      ],
    );
    // Two of three were the same room and category in the same house: one of
    // them is a callback.
    expect(load[0].callbacks).toBe(1);
  });

  it("counts no callback for a contractor whose jobs were all different", () => {
    const load = contractorLoad(
      [
        { contactId: "c1", requestId: "a" },
        { contactId: "c1", requestId: "b" },
      ],
      [
        request({ id: "a", location: "Kitchen", category: "Plumbing" }),
        request({ id: "b", location: "Roof", category: "Structural" }),
      ],
    );
    expect(load[0].callbacks).toBe(0);
  });

  it("ignores a link whose request the caller cannot see", () => {
    // The caller passes only the requests they are entitled to. A link to one
    // they cannot read must not leak its existence as a count.
    const load = contractorLoad([{ contactId: "c1", requestId: "hidden" }], []);
    expect(load).toEqual([]);
  });

  it("orders by how much they have been called back, then by volume", () => {
    const load = contractorLoad(
      [
        { contactId: "busy", requestId: "a" },
        { contactId: "busy", requestId: "b" },
        { contactId: "busy", requestId: "c" },
        { contactId: "repeat", requestId: "d" },
        { contactId: "repeat", requestId: "e" },
      ],
      [
        request({ id: "a", location: "A", category: "X" }),
        request({ id: "b", location: "B", category: "X" }),
        request({ id: "c", location: "C", category: "X" }),
        request({ id: "d", location: "D", category: "X" }),
        request({ id: "e", location: "D", category: "X" }),
      ],
    );
    // "repeat" did fewer jobs but was called back once; that is the row worth
    // reading first.
    expect(load[0].contactId).toBe("repeat");
  });
});
