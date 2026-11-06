import { describe, expect, it, vi } from "vitest";
import { inviteResidents } from "./invitations";

const json = (body: unknown) => ({ json: async () => body }) as Response;

describe("inviteResidents", () => {
  it("gives access one by one, skips who already has it, and keeps going past a refusal", async () => {
    const request = vi.fn(async (method: string, url: string, _data?: unknown) => {
      if (method === "GET") return json({ hasAccess: url.includes("/b/") });
      if (url.includes("/c/")) throw new Error('409: {"message":"Cleveland House is at its limit"}');
      return json({ invitation: { outcome: "scheduled", sendAt: "2026-11-20T12:00:00.000Z" } });
    });
    const people = ["a", "b", "c", "d"].map((id) => ({ id, firstName: id.toUpperCase(), lastName: "Test" }));

    const results = await inviteResidents(people, "2026-11-20", request, () => "Cleveland House is at its limit");

    expect(results.map((r) => [r.residentId, r.given])).toEqual([["a", true], ["b", false], ["c", false], ["d", true]]);
    expect(results[1].message).toBe("Already has access. No email sent.");
    expect(results[2].message).toBe("Not given. Cleveland House is at its limit");
    // The one who already had access is never granted again, so never emailed twice.
    const posts = request.mock.calls.filter(([method]) => method === "POST");
    expect(posts.map(([, url]) => url)).toEqual(["/api/residents/a/portal-access", "/api/residents/c/portal-access", "/api/residents/d/portal-access"]);
    expect(posts[0][2]).toEqual({ sendOn: "2026-11-20" });
  });
});
