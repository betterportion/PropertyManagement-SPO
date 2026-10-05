/**
 * Who a comment is emailed to.
 *
 * One pure function: the request, the comment and the candidate users in,
 * addresses out. It decides nothing about delivery -- whether email is
 * configured, whether a send works -- and it reaches for no storage, so it
 * is table-tested without a database.
 *
 * Four guards, all of them required:
 *
 *   1. never the author;
 *   2. an internal comment goes to staff only;
 *   3. anybody with comment email switched off is dropped;
 *   4. nothing here can fail the comment (there is nothing here to fail).
 *
 * Beyond those, the rule is "the people who can see it": every candidate is
 * put through canReadComment, the same function the thread routes decide
 * with, so ownership, the house match, the repairs-only type rule, region
 * scoping and the 120-day closed window all reach email with nothing
 * implemented a second time. On top of that, staff are narrowed to those
 * who have already posted in the thread plus the regional administrators
 * whose regions cover the request and who hold the maintenance permission.
 * An admin is emailed only for a thread they have posted in -- otherwise
 * every thread nationally would land in one inbox.
 */
import type { User, UserPermissions } from "@shared/schema";
import {
  authContextFor,
  canReadComment,
  canReadMaintenanceRequest,
  hasPermission,
  type RequestAccessFields,
} from "./authz";

/** One account as the candidate list carries it: the row plus its permissions row, if any. */
export interface CommentCandidate {
  user: User;
  permissions: UserPermissions | null;
}

export interface CommentRecipientsInput {
  request: RequestAccessFields;
  comment: { isInternal: boolean; authorUserId: string | null | undefined };
  candidates: readonly CommentCandidate[];
  /** Everybody who has posted in the thread so far, by user id. */
  participantIds: readonly (string | null | undefined)[];
  /**
   * The address of a resident's house, or null for no house claim -- the
   * route answers only for a login a current roster row speaks for (the same
   * rule as every resident read, `isCurrentRosterMember`). Passed in rather
   * than looked up so the function stays pure.
   */
  houseAddressOf: (user: User) => string | null | undefined;
  now?: Date;
}

export interface CommentRecipient {
  userId: string;
  email: string;
}

export function commentRecipients({
  request,
  comment,
  candidates,
  participantIds,
  houseAddressOf,
  now = new Date(),
}: CommentRecipientsInput): CommentRecipient[] {
  const participants = new Set(participantIds.filter((id): id is string => !!id));
  const recipients = new Map<string, CommentRecipient>();

  for (const { user, permissions } of candidates) {
    if (!user.isActive) continue;
    if (user.id === comment.authorUserId) continue;
    if (!user.commentEmailsEnabled) continue;
    const email = user.email?.trim();
    if (!email) continue;

    const ctx = authContextFor(user, permissions);
    const house = ctx.isResident && user.propertyId ? (houseAddressOf(user) ?? null) : null;
    if (!canReadComment(ctx, request, comment, house, now)) continue;

    // A resident who may read it hears about it. Staff hear about it if they
    // are in the conversation, or cover the region as a working RA.
    const inThread = participants.has(user.id);
    const coversRegion =
      !ctx.isAdmin && hasPermission(ctx, "canViewMaintenance", "canManageMaintenance");
    if (!ctx.isResident && !inThread && !coversRegion) continue;

    // Keyed on the address, not the account: an email re-link can leave two
    // accounts on one address for a while, and one person gets one message.
    const key = email.toLowerCase();
    if (!recipients.has(key)) recipients.set(key, { userId: user.id, email });
  }

  return Array.from(recipients.values());
}

export interface SubmitterReadInput {
  request: RequestAccessFields;
  candidates: readonly CommentCandidate[];
  houseAddressOf: CommentRecipientsInput["houseAddressOf"];
  now?: Date;
}

/**
 * Whether the account behind a request's `submittedBy` may still open it: the
 * gate in front of the acknowledgement and status emails, which are addressed
 * to that email. The same read rule as every other reader and as the comment
 * email above (canReadMaintenanceRequest, through authContextFor), so a
 * demoted regional administrator is not told about a repair she filed in
 * another house (#290).
 *
 * `submittedBy` is an email, so the account is found by address, case aside.
 * Fails closed: no active account holding it means no email, and so does any
 * account that cannot read the request. Comment-email preferences do not
 * apply; that switch is for comment email.
 */
export function submitterMayRead({
  request,
  candidates,
  houseAddressOf,
  now = new Date(),
}: SubmitterReadInput): boolean {
  const address = request.submittedBy?.trim().toLowerCase();
  if (!address) return false;
  return candidates.some(({ user, permissions }) => {
    if (!user.isActive || user.email?.trim().toLowerCase() !== address) return false;
    const ctx = authContextFor(user, permissions);
    const house = ctx.isResident && user.propertyId ? (houseAddressOf(user) ?? null) : null;
    return canReadMaintenanceRequest(ctx, request, house, now);
  });
}
