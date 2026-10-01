/**
 * Household logins end when the stay does (JR, 2026-10-01).
 *
 * A household leader's or steward's login is for one house while they live
 * there. Once no current roster row at that house speaks for it -- they moved
 * out, their stop date passed, they were removed from the roster -- the login
 * is switched off and unlinked from the house, which also frees the house's
 * slot (HOUSE_PORTAL_ACCOUNT_LIMIT). Their RA can give access again if they
 * come back.
 *
 * Run right after a roster change, for one house, so it is immediate, and by
 * the daily job for every house, so a stop date that simply passes is caught.
 * Idempotent: a login already switched off is not looked at again.
 */
import { storage as defaultStorage, type IStorage } from "./storage";
import { recordAuditEvent, AUDIT_ACTIONS } from "./audit";
import { isCurrentRosterMember } from "./authz";
import { logError } from "./errors";
import type { Resident, User } from "@shared/schema";

/** Pure: the active household logins that no current roster row speaks for. */
export function departedHouseholdLogins(logins: User[], rosterByHouse: Map<string, Resident[]>, now: Date): User[] {
  return logins.filter(
    (login) =>
      login.role === "resident" &&
      login.isActive &&
      !!login.propertyId &&
      !(rosterByHouse.get(login.propertyId) ?? []).some((row) => isCurrentRosterMember(row, login, now)),
  );
}

type LoginStorage = Pick<
  IStorage,
  "getActiveResidentAccountsByProperty" | "getAllUsers" | "getResidentsByProperty" | "getAllResidents" | "deactivateAndUnlinkUser"
>;

/**
 * Switches off the departed logins of one house, or of every house. Returns how
 * many. Never throws: a roster save must not fail because this could not run,
 * and the daily job catches anything missed.
 */
export async function closeDepartedHouseholdLogins(
  scope: { propertyId: string } | "all",
  now: Date = new Date(),
  storage: LoginStorage = defaultStorage,
): Promise<number> {
  try {
    let logins: User[];
    const rosterByHouse = new Map<string, Resident[]>();
    if (scope === "all") {
      logins = await storage.getAllUsers();
      for (const row of await storage.getAllResidents()) {
        rosterByHouse.set(row.propertyId, [...(rosterByHouse.get(row.propertyId) ?? []), row]);
      }
    } else {
      logins = await storage.getActiveResidentAccountsByProperty(scope.propertyId);
      rosterByHouse.set(scope.propertyId, await storage.getResidentsByProperty(scope.propertyId));
    }

    const departed = departedHouseholdLogins(logins, rosterByHouse, now);
    for (const login of departed) {
      await storage.deactivateAndUnlinkUser(login.id);
      // Access history, kept indefinitely. The system did it, so no actor.
      recordAuditEvent(null, {
        action: AUDIT_ACTIONS.USER_STATUS_CHANGED,
        entityType: "user",
        entityId: login.id,
        summary: `Switched off ${login.email ?? login.id}'s login: they are no longer on their house's roster`,
        details: { isActive: false, reason: "left_roster" },
      });
      recordAuditEvent(null, {
        action: AUDIT_ACTIONS.USER_PROPERTY_CHANGED,
        entityType: "user",
        entityId: login.id,
        summary: `Unlinked ${login.email ?? login.id} from their house: they are no longer on its roster`,
        details: { from: login.propertyId, to: null, reason: "left_roster" },
      });
    }
    return departed.length;
  } catch (error) {
    logError("Failed to switch off departed household logins", error);
    return 0;
  }
}
