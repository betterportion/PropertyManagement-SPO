/**
 * Who a comment is emailed to.
 *
 * One pure function decides it -- request, comment and the candidate users
 * in, addresses out -- and these are the table tests the spec asks for. Each
 * case proves the function refuses or permits an observable address; none
 * re-implements the read rule, which is the real one from authz.ts.
 *
 * authz.ts imports storage and auth, both of which reach for a database at
 * import time, so those are stubbed exactly as the authz suite stubs them.
 * The function under test never calls either.
 */
import { describe, it, expect, vi } from "vitest";
import type { User, UserPermissions } from "@shared/schema";

vi.mock("../db", () => ({ db: {}, pool: {} }));
vi.mock("../auth", () => ({ getUserId: vi.fn() }));
vi.mock("../storage", () => ({ storage: {} }));

import { commentRecipients, type CommentCandidate } from "../commentRecipients";

const HOUSE_A = "1 Main St";
const HOUSE_B = "2 River Rd";
const houseAddressOf = (propertyId: string) =>
  ({ "prop-a": HOUSE_A, "prop-b": HOUSE_B })[propertyId] ?? null;

const REPAIR = {
  id: "req-1",
  region: "West Central",
  buildingAddress: HOUSE_A,
  submittedBy: "eve@example.com",
  status: "pending",
  type: "request",
};

function user(over: Partial<User> & { id: string; email: string }): User {
  return {
    role: "resident",
    isActive: true,
    propertyId: null,
    commentEmailsEnabled: true,
    ...over,
  } as User;
}

function permissions(over: Partial<UserPermissions>): UserPermissions {
  return { canViewMaintenance: false, allowedRegions: [], ...over } as UserPermissions;
}

const candidate = (u: User, p: Partial<UserPermissions> | null = null): CommentCandidate => ({
  user: u,
  permissions: p ? permissions(p) : null,
});

// The household of house A: the leader, the steward, and the unlinked
// person who filed the request.
const ALICE = candidate(user({ id: "u-alice", email: "alice@example.com", propertyId: "prop-a" }));
const BOB = candidate(user({ id: "u-bob", email: "bob@example.com", propertyId: "prop-a" }));
const EVE = candidate(user({ id: "u-eve", email: "eve@example.com" }));
// Somebody else's house.
const CAROL = candidate(user({ id: "u-carol", email: "carol@example.com", propertyId: "prop-b" }));

const west = { canViewMaintenance: true, allowedRegions: ["West Central"] };
const east = { canViewMaintenance: true, allowedRegions: ["East Central"] };

// Staff: the author, a colleague covering the region, one outside it, one
// covering it without the maintenance permission, and two admins.
const SARAH = candidate(user({ id: "u-sarah", email: "sarah@example.com", role: "regional_administrator" }), west);
const TOM = candidate(user({ id: "u-tom", email: "tom@example.com", role: "regional_administrator" }), west);
const UMA = candidate(user({ id: "u-uma", email: "uma@example.com", role: "regional_administrator" }), east);
const VIC = candidate(
  user({ id: "u-vic", email: "vic@example.com", role: "regional_administrator" }),
  { canViewMaintenance: false, allowedRegions: ["West Central"] },
);
const NAT = candidate(user({ id: "u-nat", email: "nat@example.com", role: "admin" }));
const PAT = candidate(user({ id: "u-pat", email: "pat@example.com", role: "admin" }));

const EVERYBODY = [ALICE, BOB, EVE, CAROL, SARAH, TOM, UMA, VIC, NAT, PAT];

/** Sarah posts; Pat has posted before. */
const BY_SARAH = { isInternal: false, authorUserId: "u-sarah" };
const PARTICIPANTS = ["u-sarah", "u-pat"];

const addresses = (input: Parameters<typeof commentRecipients>[0]) =>
  commentRecipients(input).map((r) => r.email).sort();

const recipientsOf = (
  comment: { isInternal: boolean; authorUserId: string | null },
  over: Partial<Parameters<typeof commentRecipients>[0]> = {},
) =>
  addresses({
    request: REPAIR,
    comment,
    candidates: EVERYBODY,
    participantIds: PARTICIPANTS,
    houseAddressOf,
    ...over,
  });

describe("who a comment is emailed to", () => {
  it("sends a shared comment to both of the house's accounts and the unlinked submitter, plus staff", () => {
    expect(recipientsOf(BY_SARAH)).toEqual([
      "alice@example.com",
      "bob@example.com",
      "eve@example.com",
      "pat@example.com",
      "tom@example.com",
    ]);
  });

  it("sends an internal comment to no resident address, and does reach staff", () => {
    const to = recipientsOf({ ...BY_SARAH, isInternal: true });
    expect(to).toEqual(["pat@example.com", "tom@example.com"]);
    for (const address of ["alice", "bob", "eve", "carol"]) {
      expect(to).not.toContain(`${address}@example.com`);
    }
  });

  it("never emails the author their own comment", () => {
    expect(recipientsOf(BY_SARAH)).not.toContain("sarah@example.com");
    // The same for a resident who posts: the housemate hears, the author does not.
    const to = recipientsOf({ isInternal: false, authorUserId: "u-alice" }, { participantIds: ["u-alice"] });
    expect(to).not.toContain("alice@example.com");
    expect(to).toContain("bob@example.com");
  });

  it("drops anybody who switched comment email off, on either tier", () => {
    const off = (c: CommentCandidate) => ({ ...c, user: { ...c.user, commentEmailsEnabled: false } });
    const to = recipientsOf(BY_SARAH, { candidates: [off(BOB), off(TOM), ALICE, PAT] });
    expect(to).toEqual(["alice@example.com", "pat@example.com"]);
  });

  it("emails an admin only for a thread they have posted in", () => {
    const to = recipientsOf(BY_SARAH);
    expect(to).toContain("pat@example.com");
    expect(to).not.toContain("nat@example.com");
  });

  it("emails a regional administrator covering the region, and not one outside it", () => {
    const to = recipientsOf(BY_SARAH);
    expect(to).toContain("tom@example.com");
    expect(to).not.toContain("uma@example.com");
  });

  it("requires the maintenance permission of a regional administrator who has not posted", () => {
    expect(recipientsOf(BY_SARAH)).not.toContain("vic@example.com");
    // Having posted in the thread is enough on its own.
    expect(recipientsOf(BY_SARAH, { participantIds: [...PARTICIPANTS, "u-vic"] })).toContain("vic@example.com");
  });

  it("does not follow a participant out of the region they have since lost", () => {
    // "The people who can see it" is the rule; having posted once does not
    // keep somebody on a thread their regions no longer cover.
    const to = recipientsOf(BY_SARAH, { participantIds: [...PARTICIPANTS, "u-uma"] });
    expect(to).not.toContain("uma@example.com");
  });

  it("skips inactive accounts on either tier", () => {
    const gone = (c: CommentCandidate) => ({ ...c, user: { ...c.user, isActive: false } });
    const to = recipientsOf(BY_SARAH, { candidates: [gone(BOB), gone(TOM), ALICE] });
    expect(to).toEqual(["alice@example.com"]);
  });

  it("never emails a resident about a project, even a shared comment on their own house", () => {
    // The type rule from canReadMaintenanceRequest, reached through the same
    // function: a project carries bid amounts and contract terms.
    const to = recipientsOf(BY_SARAH, { request: { ...REPAIR, type: "project" } });
    expect(to).toEqual(["pat@example.com", "tom@example.com"]);
  });

  it("stops emailing the house's accounts when a closed repair leaves the 120-day window, but not the submitter", () => {
    const closedLongAgo = {
      ...REPAIR,
      status: "completed",
      completedDate: new Date("2026-01-01T00:00:00Z"),
    };
    const to = recipientsOf(BY_SARAH, { request: closedLongAgo, now: new Date("2026-09-01T00:00:00Z") });
    expect(to).not.toContain("alice@example.com");
    expect(to).not.toContain("bob@example.com");
    expect(to).toContain("eve@example.com");
  });

  it("skips somebody with no address rather than failing everybody", () => {
    const to = recipientsOf(BY_SARAH, {
      candidates: [{ ...BOB, user: { ...BOB.user, email: null } }, ALICE],
    });
    expect(to).toEqual(["alice@example.com"]);
  });

  it("returns the user id beside the address, once per person", () => {
    const recipients = commentRecipients({
      request: REPAIR,
      comment: BY_SARAH,
      candidates: [TOM, TOM],
      participantIds: [],
      houseAddressOf,
    });
    expect(recipients).toEqual([{ userId: "u-tom", email: "tom@example.com" }]);
  });

  // Deduping is keyed on the address, not the account. upsertUser's
  // email-based re-linking (see CLAUDE.md, "Login") can leave two rows -- an
  // old id and a new one -- sharing one address for a transitional period,
  // and a real person should get one email, not two, for the same comment.
  it("sends one email even when two different accounts share an address", () => {
    const TOM_RELINKED = candidate(
      user({ id: "u-tom-2", email: TOM.user.email, role: "regional_administrator" }),
      west,
    );
    const recipients = commentRecipients({
      request: REPAIR,
      comment: BY_SARAH,
      candidates: [TOM, TOM_RELINKED],
      participantIds: PARTICIPANTS,
      houseAddressOf,
    });
    expect(recipients).toHaveLength(1);
  });
});
