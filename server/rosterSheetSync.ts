/**
 * Running the roster sync: read the sheet (or a CSV with the same columns),
 * plan (server/rosterSync.ts), apply the plan in one transaction, record the
 * run and audit what changed. Also the daily job, the fifth that runs inside
 * the web process -- idempotent, and unable to fail the boot.
 *
 * A dry run plans and records the run but writes nothing to the roster: it is
 * how the first sync is reviewed before it is trusted.
 */
import { readRosterSheetConfigFromEnv } from "./config";
import { storage as defaultStorage, type IStorage, type RosterPlanWrite } from "./storage";
import { recordAuditEvent, AUDIT_ACTIONS } from "./audit";
import { logError } from "./errors";
import type { AuthContext } from "./authz";
import { createRosterSheetReader, RosterSheetError } from "./googleSheets";
import { newReviews, planRosterSync, type RosterPlan, type SheetTable, type SyncedValues } from "./rosterSync";
import type { RosterSyncRun } from "@shared/schema";
import type { RosterSyncHealth } from "@shared/rosterSheet";

export const ROSTER_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1_000;

/** What an admin sees about a run: the counts, and the changes themselves. */
export interface RosterSyncResult {
  run: RosterSyncRun;
  creates: Array<{ row: number; name: string; email: string; house: string; returning: boolean }>;
  updates: Array<{ row: number; name: string; changes: Array<{ field: string; from: unknown; to: unknown; conflict: boolean }> }>;
  reviews: Array<{ kind: string; detail: string }>;
}

type SyncStorage = Pick<
  IStorage,
  | "getAllResidents"
  | "getAllProperties"
  | "getAllResidentSheetLinks"
  | "getRosterReviewItems"
  | "applyRosterPlan"
  | "createRosterSyncRun"
>;

const toDate = (day: string | boolean | null) => (typeof day === "string" ? new Date(`${day}T00:00:00.000Z`) : null);

function residentFields(values: SyncedValues) {
  return {
    firstName: values.firstName as string,
    lastName: values.lastName as string,
    moveInDate: toDate(values.moveInDate),
    moveOutDate: toDate(values.moveOutDate),
    paymentPlan: (values.paymentPlan as "monthly" | "installments" | null) ?? null,
    isActive: values.isActive as boolean,
  };
}

const showDay = (value: unknown) => (value ? String(value) : "none");

export async function runRosterSync(options: {
  source: "sheet" | "csv";
  /** For a CSV; the sheet is read here. */
  table?: SheetTable;
  dryRun: boolean;
  actor: AuthContext | null;
  now?: Date;
  storage?: SyncStorage;
  readSheet?: () => Promise<SheetTable>;
}): Promise<RosterSyncResult> {
  const { source, dryRun, actor } = options;
  const now = options.now ?? new Date();
  const storage = options.storage ?? defaultStorage;
  const actorEmail = actor?.user.email ?? null;

  const record = async (patch: Partial<Omit<RosterSyncRun, "id" | "createdAt">>, plan?: RosterPlan) =>
    await storage.createRosterSyncRun({
      source,
      dryRun,
      ok: false,
      rowsRead: plan?.rowsRead ?? 0,
      created: plan?.creates.length ?? 0,
      updated: plan?.updates.length ?? 0,
      conflicts: plan?.reviews.filter((r) => r.kind === "conflict").length ?? 0,
      skipped: plan?.skipped.length ?? 0,
      skippedRows: plan?.skipped ?? [],
      refusedColumns: plan?.refusedColumns ?? [],
      error: null,
      actorEmail,
      ...patch,
    });

  let table: SheetTable;
  try {
    if (options.table) table = options.table;
    else if (options.readSheet) table = await options.readSheet();
    else {
      const config = readRosterSheetConfigFromEnv();
      if (!config.configured) throw new RosterSheetError("The resident sheet is not set up on this server.");
      table = await createRosterSheetReader(config.config).readTable();
    }
  } catch (error) {
    if (!(error instanceof RosterSheetError)) logError("Reading the resident sheet failed", error);
    const message = error instanceof RosterSheetError ? error.message : "The resident sheet could not be read. Nothing was changed.";
    const run = await record({ error: message });
    audit(actor, `Resident ${source} sync failed: ${message}`, { ok: false, dryRun });
    return { run, creates: [], updates: [], reviews: [] };
  }

  const [residents, properties, links, open] = await Promise.all([
    storage.getAllResidents(),
    storage.getAllProperties(),
    storage.getAllResidentSheetLinks(),
    storage.getRosterReviewItems("open", 10_000),
  ]);
  const plan = planRosterSync({ table, residents, properties, links, now });

  if (plan.refusedColumns.length > 0) {
    const message = `Refused: the ${source === "sheet" ? "sheet" : "file"} has a column that looks like banking data (${plan.refusedColumns.join(", ")}). Remove it; nothing was read or changed.`;
    const run = await record({ error: message }, plan);
    audit(actor, `Resident ${source} sync refused: banking-like column ${plan.refusedColumns.join(", ")}`, { ok: false, dryRun, refusedColumns: plan.refusedColumns });
    return { run, creates: [], updates: [], reviews: [] };
  }
  if (plan.missingColumns.length > 0) {
    const message = `The ${source === "sheet" ? "sheet" : "file"} is missing ${plan.missingColumns.join(", ")}. Nothing was changed.`;
    const run = await record({ error: message }, plan);
    audit(actor, `Resident ${source} sync failed: ${message}`, { ok: false, dryRun });
    return { run, creates: [], updates: [], reviews: [] };
  }

  const reviews = newReviews(plan, new Set(open.map((r) => r.dedupeKey)));

  if (!dryRun) {
    const write: RosterPlanWrite = {
      syncedAt: now,
      creates: plan.creates.map(({ values: { email, ...values }, property }) => ({
        resident: {
          ...residentFields(values),
          email,
          roomName: null,
          propertyId: property.id,
          region: property.region,
          buildingAddress: property.address,
        },
        syncedValues: values,
      })),
      updates: plan.updates.map((u) => ({ id: u.resident.id, data: residentFields(u.values), syncedValues: u.values })),
      links: plan.unchanged.map((u) => ({ residentId: u.resident.id, syncedValues: u.values })),
      reviews,
    };
    try {
      await storage.applyRosterPlan(write);
    } catch (error) {
      logError("Applying the roster sync failed", error);
      const run = await record({ error: "Saving the changes failed, so none were saved. Try again." }, plan);
      audit(actor, `Resident ${source} sync failed while saving; nothing was changed`, { ok: false });
      return { run, creates: [], updates: [], reviews: [] };
    }

    // Each change on its own line: dates drive move-outs and deposits, so
    // their history matters.
    for (const c of plan.creates) {
      recordAuditEvent(actor, {
        action: AUDIT_ACTIONS.RESIDENT_SHEET_CREATED,
        entityType: "resident",
        summary: `Added ${c.values.firstName} ${c.values.lastName} to ${c.property.name} from the ${source} (start ${showDay(c.values.moveInDate)}, stop ${showDay(c.values.moveOutDate)})${c.previousStayId ? " as a new stay" : ""}`,
        details: { region: c.property.region, moveInDate: c.values.moveInDate, moveOutDate: c.values.moveOutDate, previousStayId: c.previousStayId },
      });
    }
    for (const u of plan.updates) {
      recordAuditEvent(actor, {
        action: AUDIT_ACTIONS.RESIDENT_SHEET_UPDATED,
        entityType: "resident",
        entityId: u.resident.id,
        summary: `Updated ${u.resident.firstName} ${u.resident.lastName} from the ${source}: ${u.changes
          .map((ch) => `${ch.field} ${showDay(ch.from)} → ${showDay(ch.to)}`)
          .join(", ")}`,
        details: { region: u.resident.region, changes: u.changes },
      });
    }
  }

  const run = await record({ ok: true }, { ...plan, reviews });
  audit(
    actor,
    `Resident ${source} sync${dryRun ? " (preview)" : ""}: ${plan.rowsRead} rows read, ${plan.creates.length} added, ${plan.updates.length} updated, ` +
      `${reviews.filter((r) => r.kind === "conflict").length} conflicts, ${plan.skipped.length} skipped`,
    { ok: true, dryRun, rowsRead: plan.rowsRead, created: plan.creates.length, updated: plan.updates.length, skipped: plan.skipped.length },
  );

  return {
    run,
    creates: plan.creates.map((c) => ({
      row: c.row,
      name: `${c.values.firstName} ${c.values.lastName}`,
      email: c.values.email,
      house: c.property.name,
      returning: c.previousStayId !== null,
    })),
    updates: plan.updates.map((u) => ({ row: u.row, name: `${u.resident.firstName} ${u.resident.lastName}`, changes: u.changes })),
    reviews: reviews.map((r) => ({ kind: r.kind, detail: r.detail })),
  };
}

function audit(actor: AuthContext | null, summary: string, details: Record<string, unknown>) {
  recordAuditEvent(actor, { action: AUDIT_ACTIONS.RESIDENT_SHEET_SYNC, entityType: "roster", summary, details });
}

export async function rosterSyncHealth(
  storage: Pick<IStorage, "getRecentRosterSyncRuns" | "getLastSuccessfulRosterSyncRun" | "getRosterReviewItems"> = defaultStorage,
): Promise<RosterSyncHealth> {
  const [recent, success, open] = await Promise.all([
    storage.getRecentRosterSyncRuns(10),
    storage.getLastSuccessfulRosterSyncRun(),
    storage.getRosterReviewItems("open", 10_000),
  ]);
  return {
    configured: readRosterSheetConfigFromEnv().configured,
    // The last real run against the sheet: a preview or a CSV says nothing about it.
    lastRun: recent.find((r) => r.source === "sheet" && !r.dryRun) ?? null,
    lastSuccessAt: success?.createdAt?.toISOString() ?? null,
    openReviews: open.length,
  };
}

let running: Promise<RosterSyncResult> | null = null;

/** A real (not dry-run) sheet sync, joining one already in progress. */
export function runScheduledRosterSync(actor: AuthContext | null): Promise<RosterSyncResult> {
  if (running) return running;
  running = runRosterSync({ source: "sheet", dryRun: false, actor }).finally(() => {
    running = null;
  });
  return running;
}

function tick(): void {
  try {
    void runScheduledRosterSync(null)
      .then(({ run }) => {
        if (run.ok) console.info(`[roster] Sheet sync: ${run.created} added, ${run.updated} updated, ${run.skipped} skipped`);
      })
      .catch((error) => logError("Resident sheet sync failed", error));
  } catch (error) {
    logError("Failed to start the resident sheet sync", error);
  }
}

/** Starts the daily sheet sync and runs it now. Does nothing while the sheet is not set up. */
export function startRosterSheetSyncJob(): NodeJS.Timeout | null {
  if (!readRosterSheetConfigFromEnv().configured) return null;
  tick();
  const timer = setInterval(tick, ROSTER_SYNC_INTERVAL_MS);
  timer.unref();
  return timer;
}
