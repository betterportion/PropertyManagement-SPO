import type { Express } from "express";
import { pingDatabase } from "./db";

/**
 * Health check for the hosting platform.
 *
 * Deliberately says almost nothing. It is unauthenticated, because the platform
 * probing it has no way to log in, which means anything reported here is public
 * -- so no versions, no configuration, no environment names, no error details.
 * "The database did not answer" is all an outsider learns, and that is already
 * obvious from the application being unusable.
 *
 * The database is included on purpose. A process that is running but cannot
 * reach its database serves errors on every page, and a check that only proved
 * the process was alive would report that as healthy.
 */
export function registerHealthRoutes(app: Express): void {
  app.get("/api/health", async (_req, res) => {
    const databaseReachable = await pingDatabase();

    // 503 rather than 200-with-a-flag, so a platform that only looks at the
    // status code still notices. During a rolling deploy this is what stops
    // traffic being sent to an instance that cannot serve it.
    res.status(databaseReachable ? 200 : 503).json({
      status: databaseReachable ? "ok" : "unavailable",
      database: databaseReachable ? "ok" : "unreachable",
      uptimeSeconds: Math.floor(process.uptime()),
    });
  });
}
