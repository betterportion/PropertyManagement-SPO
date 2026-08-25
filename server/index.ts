import express from "express";
import type { Server } from "http";
import { log } from "./logger";
import { logError } from "./errors";
import { isProduction, validateConfiguration } from "./config";
import { securityHeaders } from "./security";

// Set once the server is listening, so a shutdown can stop accepting new
// connections before the process goes away.
let httpServer: Server | undefined;
let shuttingDown = false;

/** How long in-flight requests get to finish before the process exits anyway. */
const SHUTDOWN_GRACE_MS = 15_000;

/**
 * Stops serving and exits.
 *
 * Both the orderly case (the platform sent SIGTERM to replace this instance)
 * and the fatal case (an exception escaped everything) end up here, because the
 * sequence is the same: stop accepting work, let what is already running
 * finish, release the database connections, exit.
 *
 * The forced exit is not a formality. `server.close()` waits for every open
 * connection, and a browser holding an idle keep-alive socket would otherwise
 * keep a shutting-down process alive indefinitely -- on a platform that waits
 * before sending SIGKILL, that turns a routine deploy into a stall.
 */
async function shutdown(reason: string, exitCode: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  log(`${reason} — shutting down`);

  const force = setTimeout(() => {
    log("Shutdown took too long; exiting now");
    process.exit(exitCode);
  }, SHUTDOWN_GRACE_MS);
  force.unref();

  if (httpServer) {
    await new Promise<void>((resolve) => {
      httpServer!.close(() => resolve());
      // Sockets sitting idle between requests are not in-flight work and have
      // no reason to delay the exit.
      httpServer!.closeIdleConnections?.();
    });
  }

  try {
    // Imported here rather than at the top so that a failure to configure the
    // database cannot prevent the shutdown path from existing.
    const { closeDatabase } = await import("./db");
    await closeDatabase();
  } catch (error) {
    logError("Failed to close the database connection pool during shutdown", error);
  }

  clearTimeout(force);
  process.exit(exitCode);
}

/**
 * Last resort for a fault that escaped every request-level handler.
 *
 * Node cannot guarantee anything about the process after an uncaught
 * exception -- a connection pool, a transaction, or a module's internal state
 * may be half-updated -- so continuing to serve risks giving staff answers that
 * are quietly wrong, which is worse than a short restart.
 *
 * This is not the mechanism that keeps one bad request from becoming an
 * outage; request failures are caught in the routes and by the Express error
 * handler, and never reach here.
 */
function shutdownAfterFatalError(context: string, err: unknown): void {
  logError(context, err);
  void shutdown(context, 1);
}

process.on("uncaughtException", (error) => {
  shutdownAfterFatalError("Uncaught exception", error);
});

/**
 * A rejected promise nobody awaited is a bug, but unlike an uncaught exception
 * it does not imply the process is unsound, so this logs and keeps serving.
 * Every request path is wrapped, so a rejection here is background work rather
 * than someone's unanswered request.
 */
process.on("unhandledRejection", (reason) => {
  logError("Unhandled promise rejection", reason);
});

// SIGTERM is how a hosting platform asks an instance to stand down during a
// deploy or a restart; SIGINT is Ctrl-C in a terminal.
process.on("SIGTERM", () => void shutdown("Received SIGTERM", 0));
process.on("SIGINT", () => void shutdown("Received SIGINT", 0));

const app = express();

// Behind a reverse proxy the connection to this process is plain HTTP even
// though the visitor is on HTTPS. Without this, req.protocol is "http",
// req.ip is the proxy's address, and secure session cookies are never sent --
// which presents as nobody being able to log in. `1` means trust exactly one
// proxy, so a client cannot forge the header by adding its own hop.
app.set("trust proxy", 1);

app.use(securityHeaders());

declare module 'http' {
  interface IncomingMessage {
    rawBody: unknown
  }
}
app.use(express.json({
  verify: (req, _res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(express.urlencoded({ extended: false }));

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      // Response bodies carry resident names, addresses and vendor contact
      // details. That is a useful debugging aid on a laptop and a privacy
      // problem in a hosting platform's log retention, so it stops at the
      // boundary.
      if (capturedJsonResponse && !isProduction) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "…";
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  // First, before anything that reads configuration at import time, so that a
  // misconfigured deployment gets one clear report naming every missing value
  // instead of whichever module happened to load first.
  validateConfiguration();

  const { registerRoutes } = await import("./routes");
  const { registerHealthRoutes } = await import("./health");
  const { apiNotFound, errorHandler } = await import("./errors");
  const { serveStatic } = await import("./static");
  const { startAuditLogRetentionJob } = await import("./audit");
  const { startScheduleGenerationJob } = await import("./schedules");

  // Before the rest of the API so that the platform can always tell whether
  // this instance is serving, even while other routes are being set up.
  registerHealthRoutes(app);

  // Normalise any legacy kebab-case allowedRegions rows to Title Case on every boot.
  const { migrateRegionsToTitleCase, backfillBillingRegions } = await import("./migrateRegions");
  await migrateRegionsToTitleCase();
  // Give pre-existing billing records the region they now need to be visible.
  await backfillBillingRegions();

  const server = await registerRoutes(app);

  app.use("/api", apiNotFound);

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes.
  //
  // The import is inside the branch so that the production bundle never
  // evaluates it -- Vite is a build tool and is not installed when only runtime
  // dependencies are.
  if (app.get("env") === "development") {
    const { setupVite } = await import("./vite");
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  // Registered last, after the Vite and static layers, so their failures reach
  // it too. See errorHandler for why the position matters.
  app.use(errorHandler);

  // The hosting platform decides the port and passes it in; 5000 is only the
  // local default. Listening on 0.0.0.0 is required for the platform's router
  // to reach the process.
  const port = parseInt(process.env.PORT || '5000', 10);

  // Published so a shutdown can drain in-flight requests before exiting.
  httpServer = server;

  server.listen({ port, host: "0.0.0.0" }, () => {
    log(`serving on port ${port}`);
    startAuditLogRetentionJob();
    startScheduleGenerationJob();
  });
})().catch((error) => {
  // A startup failure must not leave a half-initialised process running and
  // reporting itself as up.
  logError("Failed to start the server", error);
  process.exit(1);
});
