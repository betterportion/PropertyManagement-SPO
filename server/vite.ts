import { type Express } from "express";
import fs from "fs";
import path from "path";
import { createServer as createViteServer, createLogger } from "vite";
import { type Server } from "http";
import viteConfig from "../vite.config";
import { nanoid } from "nanoid";

/**
 * Development only. This module imports Vite, which is a build-time dependency,
 * so the production entry point must reach it through a dynamic import that is
 * never evaluated. Logging lives in server/logger.ts and static file serving in
 * server/static.ts for the same reason.
 */
const viteLogger = createLogger();

export async function setupVite(app: Express, server: Server) {
  // Merge rather than replace: vite.config.ts sets server.fs.{strict,deny} to
  // keep the dev server from serving dotfiles, and a wholesale replacement of
  // `server` would silently drop those restrictions.
  const serverOptions = {
    ...viteConfig.server,
    middlewareMode: true,
    hmr: { server },
    allowedHosts: true as const,
  };

  const vite = await createViteServer({
    ...viteConfig,
    configFile: false,
    // Log Vite errors without exiting: a request-scoped error such as an
    // fs.deny refusal must not take the whole dev server down with it.
    customLogger: viteLogger,
    server: serverOptions,
    appType: "custom",
  });

  app.use(vite.middlewares);
  app.use("*", async (req, res, next) => {
    const url = req.originalUrl;

    try {
      const clientTemplate = path.resolve(
        import.meta.dirname,
        "..",
        "client",
        "index.html",
      );

      // always reload the index.html file from disk incase it changes
      let template = await fs.promises.readFile(clientTemplate, "utf-8");
      template = template.replace(
        `src="/src/main.tsx"`,
        `src="/src/main.tsx?v=${nanoid()}"`,
      );
      const page = await vite.transformIndexHtml(url, template);
      res.status(200).set({ "Content-Type": "text/html" }).end(page);
    } catch (e) {
      vite.ssrFixStacktrace(e as Error);
      next(e);
    }
  });
}
