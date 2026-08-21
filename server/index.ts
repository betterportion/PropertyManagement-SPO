import express from "express";
import type { Server } from "http";
import { registerRoutes } from "./routes";
import { setupVite, serveStatic, log } from "./vite";
import { apiNotFound, errorHandler, logError } from "./errors";

// Set once the server is listening, so a fatal fault can stop accepting new
// connections before the process goes away.
let httpServer: Server | undefined;
let shuttingDown = false;

/**
 * Last resort for a fault that escaped every request-level handler.
 *
 * Node cannot guarantee anything about the process after an uncaught
 * exception -- a connection pool, a transaction, or a module's internal state
 * may be half-updated -- so continuing to serve risks giving staff answers that
 * are quietly wrong, which is worse than a short restart. Instead: log it, stop
 * taking new work, let the requests already in flight finish, and exit so the
 * platform starts a clean process.
 *
 * This is not the mechanism that keeps one bad request from becoming an
 * outage; request failures are caught in the routes and by the Express error
 * handler, and never reach here.
 */
function shutdownAfterFatalError(context: string, err: unknown): void {
  logError(context, err);

  if (shuttingDown) return;
  shuttingDown = true;

  const exit = () => process.exit(1);

  // A connection that never closes must not keep a broken process alive.
  const forceExit = setTimeout(exit, 10_000);
  forceExit.unref();

  if (httpServer) {
    httpServer.close(exit);
  } else {
    exit();
  }
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

const app = express();

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
      if (capturedJsonResponse) {
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
  // Normalise any legacy kebab-case allowedRegions rows to Title Case on every boot.
  const { migrateRegionsToTitleCase, backfillBillingRegions } = await import("./migrateRegions");
  await migrateRegionsToTitleCase();
  // Give pre-existing billing records the region they now need to be visible.
  await backfillBillingRegions();

  const server = await registerRoutes(app);

  app.use("/api", apiNotFound);

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (app.get("env") === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  // Registered last, after the Vite and static layers, so their failures reach
  // it too. See errorHandler for why the position matters.
  app.use(errorHandler);

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || '5000', 10);

  // Published so a fatal fault can drain in-flight requests before exiting.
  httpServer = server;

  server.listen({
    port,
    host: "0.0.0.0",
    reusePort: true,
  }, () => {
    log(`serving on port ${port}`);
  });
})();
