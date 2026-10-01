/**
 * The move-out reminder: 30 days before a resident's stop date, a task for
 * the house's regional administrators, plus a checklist email to the resident
 * and a heads-up to the RAs.
 *
 * Driven by the stop date, which the roster sheet sync now keeps accurate. It
 * runs inside the daily seasonal-task job (server/seasonalTasks.ts), the same
 * way and with the same guarantees:
 *
 *   - **Never duplicated.** The task's `sourceKey` is
 *     `move-out:<residentId>:<YYYY-MM-DD>`; a run that finds it open does
 *     nothing, and one that finds it done does not recreate it.
 *   - **Corrected when the date changes.** An open reminder for an old date is
 *     moved to the new one (and the emails go again, with the new date), or
 *     removed when the stop date goes or moves out of the window.
 *   - **Emails once per date**, because they are sent only when a reminder is
 *     created or moved.
 *
 * `planMoveOutTasks` is pure: residents, the open reminders and `now` in, what
 * to create, move and remove out.
 */
import { storage as defaultStorage, type IStorage } from "./storage";
import { sendEmail } from "./email";
import { logError } from "./errors";
import { authContextFor, canAccessRegion, hasPermission } from "./authz";
import { moveOutResidentEmail, moveOutStaffEmail } from "./notifications";
import type { Property, Resident, Task } from "@shared/schema";

/** How far ahead of a stop date the reminder appears. */
export const MOVE_OUT_NOTICE_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1_000;
const PREFIX = "move-out:";

export const moveOutKey = (residentId: string, day: string) => `${PREFIX}${residentId}:${day}`;

export function parseMoveOutKey(key: string | null | undefined): { residentId: string; day: string } | null {
  if (!key?.startsWith(PREFIX)) return null;
  const [residentId, day] = key.slice(PREFIX.length).split(":");
  return residentId && /^\d{4}-\d{2}-\d{2}$/.test(day ?? "") ? { residentId, day } : null;
}

const isoDay = (value: Date | string) => new Date(value).toISOString().slice(0, 10);

export interface MoveOutTaskSpec {
  sourceKey: string;
  resident: Resident;
  day: string;
  title: string;
  notes: string;
  region: string;
  dueDate: Date;
}

export interface MoveOutTaskPlan {
  create: MoveOutTaskSpec[];
  move: Array<{ taskId: string; spec: MoveOutTaskSpec }>;
  remove: string[];
}

function specFor(resident: Resident, day: string, houseName: string): MoveOutTaskSpec {
  const name = `${resident.firstName} ${resident.lastName}`;
  const when = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", timeZone: "UTC" }).format(new Date(`${day}T00:00:00.000Z`));
  return {
    sourceKey: moveOutKey(resident.id, day),
    resident,
    day,
    title: `${name} moves out on ${when}`,
    notes:
      `${name} leaves ${houseName} on ${day}. Complete the move-out checklist on their resident page ` +
      `(room inspected, belongings removed, keys returned), then see that their deposit goes back on time.`,
    region: resident.region,
    dueDate: new Date(`${day}T00:00:00.000Z`),
  };
}

/**
 * @param openTasks every OPEN task whose sourceKey starts with `move-out:`
 * @param doneKeys the sourceKeys of move-out reminders already marked done
 */
export function planMoveOutTasks(
  residents: Resident[],
  properties: Property[],
  openTasks: Pick<Task, "id" | "sourceKey">[],
  doneKeys: ReadonlySet<string>,
  now: Date,
): MoveOutTaskPlan {
  const plan: MoveOutTaskPlan = { create: [], move: [], remove: [] };
  const today = isoDay(now);
  const horizon = isoDay(new Date(now.getTime() + MOVE_OUT_NOTICE_DAYS * DAY_MS));
  const houseName = new Map(properties.map((p) => [p.id, p.name]));
  const residentById = new Map(residents.map((r) => [r.id, r]));

  const openByResident = new Map<string, { id: string; day: string }>();
  for (const task of openTasks) {
    const key = parseMoveOutKey(task.sourceKey);
    if (!key) continue;
    if (openByResident.has(key.residentId) || !residentById.has(key.residentId)) {
      plan.remove.push(task.id); // a duplicate, or a resident who is gone
      continue;
    }
    openByResident.set(key.residentId, { id: task.id, day: key.day });
  }

  for (const resident of residents) {
    const day = resident.moveOutDate ? isoDay(resident.moveOutDate) : null;
    const open = openByResident.get(resident.id);
    if (open && open.day === day) continue; // already reminded for this date

    const inWindow = day !== null && day >= today && day <= horizon;
    if (!inWindow) {
      // The date went, or moved outside the window: the old reminder is wrong.
      if (open) plan.remove.push(open.id);
      continue;
    }
    const spec = specFor(resident, day, houseName.get(resident.propertyId) ?? resident.buildingAddress);
    if (open) plan.move.push({ taskId: open.id, spec });
    else if (!doneKeys.has(spec.sourceKey)) plan.create.push(spec);
  }
  return plan;
}

type MoveOutStorage = Pick<
  IStorage,
  "getAllResidents" | "getAllProperties" | "getAllTasks" | "createTask" | "updateTask" | "deleteTask" | "getAllUsersWithPermissions"
>;

/**
 * The house's regional administrators: active, holding a property permission,
 * with the resident's region among theirs. Admins are not emailed -- every
 * move-out nationally would land in one inbox.
 */
async function regionalAdminEmails(storage: MoveOutStorage, region: string): Promise<string[]> {
  const people = await storage.getAllUsersWithPermissions();
  return people
    .filter(({ user }) => user.isActive && user.role === "regional_administrator" && !!user.email)
    .map(({ user, permissions }) => ({ user, ctx: authContextFor(user, permissions) }))
    .filter(({ ctx }) => hasPermission(ctx, "canViewProperties", "canManageProperties") && canAccessRegion(ctx, region))
    .map(({ user }) => user.email as string);
}

async function sendMoveOutEmails(storage: MoveOutStorage, spec: MoveOutTaskSpec, houseName: string): Promise<void> {
  const { resident, day } = spec;
  const messages = [
    moveOutResidentEmail({ to: resident.email, firstName: resident.firstName, propertyName: houseName, moveOutDay: day }),
    ...(await regionalAdminEmails(storage, resident.region)).map((to) =>
      moveOutStaffEmail({ to, residentName: `${resident.firstName} ${resident.lastName}`, propertyName: houseName, moveOutDay: day }),
    ),
  ];
  // sendEmail never throws; an unconfigured or failed send is its own result.
  for (const message of messages) if (message) await sendEmail(message);
}

/** Applies the day's plan. Returns what it did. */
export async function syncMoveOutTasks(
  now: Date,
  storage: MoveOutStorage = defaultStorage,
): Promise<{ created: number; moved: number; removed: number }> {
  const [residents, properties, tasks] = await Promise.all([storage.getAllResidents(), storage.getAllProperties(), storage.getAllTasks()]);
  const moveOutTasks = tasks.filter((t) => parseMoveOutKey(t.sourceKey));
  const open = moveOutTasks.filter((t) => t.status === "open");
  const doneKeys = new Set(moveOutTasks.filter((t) => t.status !== "open").map((t) => t.sourceKey as string));
  const plan = planMoveOutTasks(residents, properties, open, doneKeys, now);
  const houseName = new Map(properties.map((p) => [p.id, p.name]));

  for (const id of plan.remove) await storage.deleteTask(id);
  for (const { taskId, spec } of plan.move) {
    await storage.updateTask(taskId, { sourceKey: spec.sourceKey, title: spec.title, notes: spec.notes, dueDate: spec.dueDate, region: spec.region });
    await sendMoveOutEmails(storage, spec, houseName.get(spec.resident.propertyId) ?? spec.resident.buildingAddress).catch((error) =>
      logError("Failed to send move-out emails", error),
    );
  }
  for (const spec of plan.create) {
    await storage.createTask({
      title: spec.title,
      notes: spec.notes,
      category: "property",
      status: "open",
      dueDate: spec.dueDate,
      region: spec.region,
      assignedToUserId: null,
      createdBy: null,
      sourceKey: spec.sourceKey,
    });
    await sendMoveOutEmails(storage, spec, houseName.get(spec.resident.propertyId) ?? spec.resident.buildingAddress).catch((error) =>
      logError("Failed to send move-out emails", error),
    );
  }
  return { created: plan.create.length, moved: plan.move.length, removed: plan.remove.length };
}
