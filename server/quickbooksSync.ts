/**
 * The daily QuickBooks spend sync -- the fourth job that runs inside the web
 * process (CLAUDE.md, "Backend").
 *
 * For every owned house linked to a QuickBooks class, it reads the fiscal
 * year's repair & maintenance spend on the accounts an admin chose, and stores
 * one figure per house per year. Until July 31 it also re-reads the year just
 * ended, so a bill entered late in June still lands in the right year.
 *
 * The rules it keeps:
 *
 *   - **Idempotent.** It overwrites each figure with what QuickBooks says now,
 *     so running twice changes nothing the second time.
 *   - **All or nothing.** Every report is read and every figure worked out
 *     before anything is written, and the figures are written in one
 *     transaction. A failed sync leaves the last good figures exactly as they
 *     were; their age is what tells an admin something is wrong.
 *   - **The newest refresh token is saved first.** Intuit may rotate it on
 *     every refresh and the old one stops working; it is stored the moment it
 *     arrives, before any report is read, so a failure later in the run cannot
 *     strand the connection.
 *   - **Never fails the boot**, and never runs twice at once (a "Sync now"
 *     during the daily run joins it).
 */
import { readQuickBooksConfigFromEnv } from "./config";
import { storage as defaultStorage, type IStorage } from "./storage";
import { recordAuditEvent, AUDIT_ACTIONS } from "./audit";
import { logError } from "./errors";
import type { AuthContext } from "./authz";
import {
  createQuickBooksApi,
  QuickBooksConnectionLostError,
  QuickBooksRequestError,
  type QuickBooksApi,
} from "./quickbooks/api";
import { decryptToken, encryptToken } from "./quickbooks/crypto";
import { centsForClass, repairSpendByColumn } from "./quickbooks/report";
import { fiscalYearBounds, fiscalYearLabel, fiscalYearOf } from "@shared/fiscalYear";
import type { QuickBooksHealth } from "@shared/quickbooks";

export const QUICKBOOKS_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1_000;

/** The months in which the year just ended is still re-read: June and July (0-based). */
const PRIOR_YEAR_REFRESH_MONTHS = new Set([5, 6]);

/** The fiscal years one run reads: this one, and last year's until July 31. */
export function fiscalYearsToSync(now: Date): number[] {
  const current = fiscalYearOf(now);
  return PRIOR_YEAR_REFRESH_MONTHS.has(now.getUTCMonth()) ? [current, current - 1] : [current];
}

type SyncStorage = Pick<
  IStorage,
  | "getQuickbooksIntegration"
  | "updateQuickbooksIntegration"
  | "getAllPropertyQuickbooksLinks"
  | "getAllProperties"
  | "upsertPropertySpend"
>;

export interface SyncDeps {
  api: QuickBooksApi;
  tokenKey: Buffer;
  storage: SyncStorage;
  now: Date;
  /** Who pressed "Sync now"; null for the daily run. */
  actor: AuthContext | null;
}

export type SyncResult =
  | { ok: true; fiscalYears: number[]; housesUpdated: number; ownedNotLinked: number }
  | { ok: false; message: string };

/** One run. Never throws: every failure comes back as a result and is recorded. */
export async function syncQuickBooksSpend(deps: SyncDeps): Promise<SyncResult> {
  const { api, tokenKey, storage, now, actor } = deps;

  const fail = async (message: string, extra: Record<string, unknown> = {}): Promise<SyncResult> => {
    try {
      await storage.updateQuickbooksIntegration({ lastAttemptAt: now, lastError: message, lastErrorAt: now, ...extra });
    } catch (error) {
      logError("Failed to record the QuickBooks sync error", error);
    }
    recordAuditEvent(actor, {
      action: AUDIT_ACTIONS.QUICKBOOKS_SYNC,
      entityType: "quickbooks",
      summary: `QuickBooks sync failed: ${message}`,
      details: { ok: false },
    });
    return { ok: false, message };
  };

  try {
    const integration = await storage.getQuickbooksIntegration();
    if (!integration?.encryptedRefreshToken || !integration.realmId) {
      // Not connected is a state, not a failure: nothing to record.
      return { ok: false, message: "QuickBooks is not connected." };
    }
    if (integration.repairAccountIds.length === 0) {
      return await fail("No QuickBooks accounts are chosen as repair & maintenance yet. Choose them in Settings.");
    }

    let refreshToken: string;
    try {
      refreshToken = decryptToken(integration.encryptedRefreshToken, tokenKey);
    } catch {
      return await fail("The saved QuickBooks connection can't be read (the token key may have changed). Reconnect it in Settings.", {
        encryptedRefreshToken: null,
        refreshTokenExpiresAt: null,
      });
    }

    let accessToken: string;
    try {
      const tokens = await api.refresh(refreshToken);
      accessToken = tokens.accessToken;
      await storage.updateQuickbooksIntegration({
        encryptedRefreshToken: encryptToken(tokens.refreshToken, tokenKey),
        refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
      });
    } catch (error) {
      if (error instanceof QuickBooksConnectionLostError) {
        return await fail(error.message, { encryptedRefreshToken: null, refreshTokenExpiresAt: null });
      }
      throw error;
    }

    const [links, properties] = await Promise.all([storage.getAllPropertyQuickbooksLinks(), storage.getAllProperties()]);
    const owned = properties.filter((p) => p.ownership === "owned");
    const ownedById = new Map(owned.map((p) => [p.id, p]));
    const linked = links.filter((link) => ownedById.has(link.propertyId) && link.kind === "class");
    const accounts = new Set(integration.repairAccountIds);
    const fiscalYears = fiscalYearsToSync(now);

    // Read everything before writing anything.
    const rows: Parameters<SyncStorage["upsertPropertySpend"]>[0] = [];
    for (const fiscalYear of fiscalYears) {
      const { startDate, endDate } = fiscalYearBounds(fiscalYear);
      const report = await api.profitAndLossByClass(accessToken, integration.realmId, startDate, endDate);
      const columns = repairSpendByColumn(report, accounts);
      for (const link of linked) {
        const property = ownedById.get(link.propertyId)!;
        const cents = centsForClass(columns, link.externalId, link.externalName);
        rows.push({
          propertyId: property.id,
          fiscalYear,
          amount: (cents / 100).toFixed(2),
          region: property.region,
          syncedAt: now,
        });
      }
    }

    await storage.upsertPropertySpend(rows);
    await storage.updateQuickbooksIntegration({ lastAttemptAt: now, lastSuccessAt: now, lastError: null, lastErrorAt: null });

    const ownedNotLinked = owned.length - linked.length;
    recordAuditEvent(actor, {
      action: AUDIT_ACTIONS.QUICKBOOKS_SYNC,
      entityType: "quickbooks",
      summary:
        `QuickBooks sync: updated ${linked.length} house${linked.length === 1 ? "" : "s"} for ` +
        `${fiscalYears.map(fiscalYearLabel).join(" and ")}` +
        (ownedNotLinked > 0 ? `; ${ownedNotLinked} owned house${ownedNotLinked === 1 ? " is" : "s are"} not linked` : ""),
      details: { ok: true, housesUpdated: linked.length, ownedNotLinked, fiscalYears },
    });
    return { ok: true, fiscalYears, housesUpdated: linked.length, ownedNotLinked };
  } catch (error) {
    logError("QuickBooks sync failed", error);
    const message =
      error instanceof QuickBooksRequestError || error instanceof QuickBooksConnectionLostError
        ? error.message
        : "Something went wrong reading from QuickBooks. The last figures are unchanged.";
    return await fail(message);
  }
}

/** The connection's state, worked out the same way for the settings page and the alerts. */
export async function quickBooksHealth(storage: Pick<IStorage, "getQuickbooksIntegration"> = defaultStorage): Promise<QuickBooksHealth> {
  const configured = readQuickBooksConfigFromEnv().configured;
  const row = await storage.getQuickbooksIntegration();
  const connected = !!row?.encryptedRefreshToken;
  return {
    configured,
    connected,
    // Lost keeps the connection date; a deliberate disconnect clears it.
    lost: !connected && !!row?.connectedAt,
    connectedAt: row?.connectedAt?.toISOString() ?? null,
    lastSuccessAt: row?.lastSuccessAt?.toISOString() ?? null,
    lastError: row?.lastError ?? null,
  };
}

/**
 * Runs `work` with a fresh access token, for the settings screens' live lists.
 * The same rotation rule as the sync: the new refresh token is stored before
 * `work` runs, and a refused one ends the connection.
 */
export async function withQuickBooks<T>(
  work: (api: QuickBooksApi, accessToken: string, realmId: string) => Promise<T>,
  storage: Pick<IStorage, "getQuickbooksIntegration" | "updateQuickbooksIntegration"> = defaultStorage,
): Promise<T> {
  const config = readQuickBooksConfigFromEnv();
  if (!config.configured) throw new QuickBooksRequestError("QuickBooks is not set up on this server.");
  const integration = await storage.getQuickbooksIntegration();
  if (!integration?.encryptedRefreshToken || !integration.realmId) {
    throw new QuickBooksRequestError("QuickBooks is not connected.");
  }
  const api = createQuickBooksApi(config.config);
  let tokens;
  try {
    tokens = await api.refresh(decryptToken(integration.encryptedRefreshToken, config.config.tokenKey));
  } catch (error) {
    if (error instanceof QuickBooksConnectionLostError) {
      await storage.updateQuickbooksIntegration({
        encryptedRefreshToken: null,
        refreshTokenExpiresAt: null,
        lastError: error.message,
        lastErrorAt: new Date(),
      });
    }
    throw error;
  }
  await storage.updateQuickbooksIntegration({
    encryptedRefreshToken: encryptToken(tokens.refreshToken, config.config.tokenKey),
    refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
  });
  return await work(api, tokens.accessToken, integration.realmId);
}

let running: Promise<SyncResult> | null = null;

/**
 * A sync with the real QuickBooks client, joining one already in progress.
 * Resolves to "not configured" when the QUICKBOOKS_* variables are unset.
 */
export function runQuickBooksSync(actor: AuthContext | null, now: Date = new Date()): Promise<SyncResult> {
  if (running) return running;
  const config = readQuickBooksConfigFromEnv();
  if (!config.configured) return Promise.resolve({ ok: false, message: "QuickBooks is not set up on this server." });
  running = syncQuickBooksSpend({
    api: createQuickBooksApi(config.config),
    tokenKey: config.config.tokenKey,
    storage: defaultStorage,
    now,
    actor,
  }).finally(() => {
    running = null;
  });
  return running;
}

function runScheduledSync(): void {
  try {
    void runQuickBooksSync(null)
      .then((result) => {
        if (result.ok) console.info(`[quickbooks] Updated spend for ${result.housesUpdated} house(s)`);
      })
      .catch((error) => logError("QuickBooks sync failed", error));
  } catch (error) {
    logError("Failed to start the QuickBooks sync", error);
  }
}

/**
 * Starts the daily sync and runs it once now. With QuickBooks not set up it
 * does nothing at all -- off is a normal state, not a boot problem.
 */
export function startQuickBooksSyncJob(): NodeJS.Timeout | null {
  if (!readQuickBooksConfigFromEnv().configured) return null;
  runScheduledSync();
  const timer = setInterval(runScheduledSync, QUICKBOOKS_SYNC_INTERVAL_MS);
  timer.unref();
  return timer;
}
